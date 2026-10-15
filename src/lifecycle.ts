/**
 * @module dsh-agent-skill-lifecycle/lifecycle
 * Pure lifecycle maths: Beta(1,1) posterior for η, status transitions, and
 * immutable ledger transforms. No I/O, no cordis imports — the shell owns
 * persistence.
 *
 * Semantics follow MemOS `core/skill/lifecycle.ts` (V7 §2.5): η is the
 * Beta(1,1) posterior mean `(passed + 1) / (attempted + 2)`, so early trials
 * cannot whip η between 0 and 1 (0/3 → 0.2, 2/3 → 0.6). Two deliberate
 * divergences: no automatic reward drift (we have no automatic reward signal),
 * and `archived` is never applied automatically by idleness.
 */

export type SkillStatus = 'candidate' | 'active' | 'archived'

export interface SkillTrials {
  attempted: number
  passed: number
}

export interface SkillEntry {
  status: SkillStatus
  eta: number
  trials: SkillTrials
  uses: number
  /**
   * 自动观测到的**加载失败**次数（`skill` 工具调用 `isError === true`）。
   *
   * 为什么独立成档而不并进 `trials`：两者**口径不同**——`trials` 是**显式**判定的试用
   * （`record` 动作，人给的结论），`loadFailures` 是**自动**观测的加载结果（机制给的）。
   * 并进一个计数器会让「谁在说话」消失（§5.9 规则 6：读数必须自带口径）。
   *
   * ⚠ **单向接入 η**（见 `effectiveTrials`）：失败降 η，**成功加载不算 pass**。
   * 理由：`skill` 工具成功只说明「文件读到了」，它几乎恒真 ⇒ 若当 pass 计入，
   * 所有 η 会被拉向 1，把区分力淹没（这是「接入信号」最容易犯的错）。
   */
  loadFailures?: number
  source: 'scan' | 'manual'
  createdAt: string
  lastUsedAt: string | null
  /** Directory no longer holds this skill; kept for the record, never deleted. */
  missing?: boolean
}

export interface SkillLedger {
  version: 1
  updatedAt: string
  skills: Record<string, SkillEntry>
}

export interface LifecyclePolicy {
  /** Trials required before a candidate may graduate. */
  candidateTrials: number
  /** η floor to become (or return to) active. */
  minEtaForActive: number
  /** η below this archives an active skill. */
  archiveEta: number
  /** Beta(1,1) prior mean for a brand-new skill. */
  initialEta: number
}

export const LIFECYCLE_DEFAULTS: LifecyclePolicy = {
  candidateTrials: 3,
  minEtaForActive: 0.5,
  archiveEta: 0.3,
  initialEta: 0.5,
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * Beta(1,1) posterior mean.
 * @param trials - Attempted / passed counters (negatives clamped to 0).
 * @returns η in [0,1]; 0.5 when nothing has been tried.
 */
export function etaOf(trials: SkillTrials): number {
  const attempted = Math.max(0, Math.floor(trials.attempted))
  const passed = Math.max(0, Math.min(Math.floor(trials.passed), attempted))
  return clamp01((passed + 1) / (attempted + 2))
}

/**
 * η 的**输入**：显式 trials ∪ 自动观测到的加载失败（**单向**）。
 *
 * 语义（刻意的不对称）：`loadFailures` 计入 `attempted` 而**不**计入 `passed`
 * ⇒ 加载失败**拉低** η；成功加载**不**抬高 η（它只让 `uses` 前进）。
 * 抬高 η 的唯一途径仍是**显式 trial**（`record` 动作）——因为「这个技能好不好用」
 * 需要判断，而判断不可代填（§2.4）。
 *
 * ⚠ 与 `etaOf` 的分工：`etaOf` 只做 Beta(1,1) 后验算术，本函数决定**喂什么给它**。
 * 单一真源：所有算 η 的地方都必须经本函数取输入，否则会出现两套口径。
 */
export function effectiveTrials(entry: Pick<SkillEntry, 'trials' | 'loadFailures'>): SkillTrials {
  const auto = Math.max(0, Math.floor(entry.loadFailures ?? 0))
  return { attempted: entry.trials.attempted + auto, passed: entry.trials.passed }
}

/**
 * Single source of truth for status transitions (invariant I4).
 * @param current - Current status.
 * @param eta - Posterior mean.
 * @param attempted - Trials attempted so far.
 * @param policy - Thresholds.
 * @returns The next status (may equal `current`).
 */
export function nextStatus(
  current: SkillStatus,
  eta: number,
  attempted: number,
  policy: LifecyclePolicy = LIFECYCLE_DEFAULTS,
): SkillStatus {
  if (current === 'candidate' && attempted >= policy.candidateTrials) {
    return eta >= policy.minEtaForActive ? 'active' : 'archived'
  }
  if (current === 'active' && eta < policy.archiveEta) return 'archived'
  if (current === 'archived' && eta >= policy.minEtaForActive) return 'candidate'
  return current
}

/** Fresh, empty ledger. */
export function emptyLedger(now: string): SkillLedger {
  return { version: 1, updatedAt: now, skills: {} }
}

/**
 * Ensure an entry exists (idempotent).
 * @param ledger - Current ledger (not mutated).
 * @param name - Skill name.
 * @param now - Timestamp for the new entry.
 * @param policy - Thresholds (for the prior η).
 * @returns New ledger plus whether an entry was created.
 */
export function ensureEntry(
  ledger: SkillLedger,
  name: string,
  now: string,
  policy: LifecyclePolicy = LIFECYCLE_DEFAULTS,
): { ledger: SkillLedger; created: boolean } {
  if (ledger.skills[name] !== undefined) return { ledger, created: false }
  const entry: SkillEntry = {
    status: 'candidate',
    eta: clamp01(policy.initialEta),
    trials: { attempted: 0, passed: 0 },
    uses: 0,
    source: 'scan',
    createdAt: now,
    lastUsedAt: null,
  }
  return {
    ledger: { ...ledger, updatedAt: now, skills: { ...ledger.skills, [name]: entry } },
    created: true,
  }
}

/**
 * Record one explicit trial verdict and re-evaluate status.
 * @param ledger - Current ledger (not mutated).
 * @param name - Skill name.
 * @param passed - Whether the trial succeeded.
 * @param now - Timestamp.
 * @param policy - Thresholds.
 * @returns New ledger and the updated entry (existing entry is preserved).
 */
export function recordTrial(
  ledger: SkillLedger,
  name: string,
  passed: boolean,
  now: string,
  policy: LifecyclePolicy = LIFECYCLE_DEFAULTS,
): { ledger: SkillLedger; entry: SkillEntry | null } {
  const current = ledger.skills[name]
  if (current === undefined) return { ledger, entry: null }
  const trials: SkillTrials = {
    attempted: current.trials.attempted + 1,
    passed: current.trials.passed + (passed ? 1 : 0),
  }
  const next: SkillEntry = { ...current, trials, missing: false }
  // η 经 `effectiveTrials` 取输入（显式 trials ∪ 自动的加载失败）——单一真源
  const eff = effectiveTrials(next)
  const eta = etaOf(eff)
  const entry: SkillEntry = { ...next, eta, status: nextStatus(current.status, eta, eff.attempted, policy) }
  return { ledger: { ...ledger, updatedAt: now, skills: { ...ledger.skills, [name]: entry } }, entry }
}

/**
 * Record one observed use (a successful `skill` tool call).
 * @param ledger - Current ledger (not mutated).
 * @param name - Skill name.
 * @param now - Timestamp.
 * @returns New ledger, updated entry, and whether anything changed.
 */
export function markUsed(
  ledger: SkillLedger,
  name: string,
  now: string,
): { ledger: SkillLedger; entry: SkillEntry | null; changed: boolean } {
  const current = ledger.skills[name]
  if (current === undefined) return { ledger, entry: null, changed: false }
  const entry: SkillEntry = { ...current, uses: current.uses + 1, lastUsedAt: now }
  return { ledger: { ...ledger, updatedAt: now, skills: { ...ledger.skills, [name]: entry } }, entry, changed: true }
}

/**
 * Record one observed **load failure** (`skill` tool call returned `isError`).
 *
 * 这是 P3 接上的**自动结果信号**：旧实现把它直接丢弃（`if (isError) return`）⇒
 * 「一个技能反复加载失败」这种真信号**在读数里不存在**（G6 的「信号稀疏」有一半是这么来的）。
 *
 * ⚠ **单向**：本函数只累加 `loadFailures`（进而拉低 η），**不**动 `uses`、**不**动 `passed`。
 * `lastUsedAt` 也不更新——一次失败的加载不是「使用」。
 */
export function markLoadFailure(
  ledger: SkillLedger,
  name: string,
  now: string,
  policy: LifecyclePolicy = LIFECYCLE_DEFAULTS,
): { ledger: SkillLedger; entry: SkillEntry | null; changed: boolean } {
  const current = ledger.skills[name]
  if (current === undefined) return { ledger, entry: null, changed: false }
  const loadFailures = Math.max(0, Math.floor(current.loadFailures ?? 0)) + 1
  const next: SkillEntry = { ...current, loadFailures }
  const eff = effectiveTrials(next)
  const eta = etaOf(eff)
  const entry: SkillEntry = { ...next, eta, status: nextStatus(current.status, eta, eff.attempted, policy) }
  return { ledger: { ...ledger, updatedAt: now, skills: { ...ledger.skills, [name]: entry } }, entry, changed: true }
}

/**
 * Reconcile the ledger against a directory scan.
 * New names are added as candidates; vanished names are flagged `missing`
 * (never deleted — invariant I3).
 * @param ledger - Current ledger (not mutated).
 * @param names - Skill names currently present in the directory.
 * @param now - Timestamp.
 * @param policy - Thresholds.
 * @returns New ledger plus added / missing / revived name lists.
 */
export function syncNames(
  ledger: SkillLedger,
  names: readonly string[],
  now: string,
  policy: LifecyclePolicy = LIFECYCLE_DEFAULTS,
): { ledger: SkillLedger; added: string[]; missing: string[]; revived: string[] } {
  let next = ledger
  const added: string[] = []
  const revived: string[] = []
  for (const name of names) {
    const before = next.skills[name]
    const ensured = ensureEntry(next, name, now, policy)
    next = ensured.ledger
    if (ensured.created) {
      added.push(name)
      continue
    }
    if (before?.missing === true) {
      const entry: SkillEntry = { ...before, missing: false }
      next = { ...next, updatedAt: now, skills: { ...next.skills, [name]: entry } }
      revived.push(name)
    }
  }
  const present = new Set(names)
  const missing: string[] = []
  for (const [name, entry] of Object.entries(next.skills)) {
    const gone = !present.has(name)
    if (gone && entry.missing !== true) {
      next = { ...next, updatedAt: now, skills: { ...next.skills, [name]: { ...entry, missing: true } } }
    }
    if (gone) missing.push(name)
  }
  return { ledger: next, added, missing, revived }
}

/** Read-only roll-up for the `list` action's header. */
export interface LedgerSummary {
  total: number
  byStatus: Record<SkillStatus, number>
  neverUsed: number
  missingCount: number
  lowEta: number
}

/**
 * Summarise a ledger.
 * @param ledger - Ledger to read.
 * @param lowEtaThreshold - η below which a skill counts as "low".
 * @returns Counts per status plus attention figures.
 */
export function summarize(ledger: SkillLedger, lowEtaThreshold = 0.5): LedgerSummary {
  const byStatus: Record<SkillStatus, number> = { candidate: 0, active: 0, archived: 0 }
  let neverUsed = 0
  let missingCount = 0
  let lowEta = 0
  for (const entry of Object.values(ledger.skills)) {
    byStatus[entry.status] += 1
    if (entry.uses === 0) neverUsed += 1
    if (entry.missing === true) missingCount += 1
    if (entry.eta < lowEtaThreshold) lowEta += 1
  }
  return { total: Object.keys(ledger.skills).length, byStatus, neverUsed, missingCount, lowEta }
}

// ── 续更候选（RSI mode = Offline→Online 的入口 · 域图 P5） ──────────────────
//
// **缺口**（域图 §3.2 G4）：离线产出物（技能/预设）**用完即止**——离线炼化 → 在线用 →
// 然后没有「该回去改它」的信号。论文 §3.4 的 AWM 是「先离线归纳工作流、再在线继续更新」，
// 而本地缺的**不是写入路径**（`skill_commit` 本就能覆盖已有 SKILL.md），缺的是**触发器**。
//
// **本函数的定位**：把**在线观测**（uses / loadFailures / 年龄）翻成「该续更」的候选，
// **只报不改**——是否重炼、怎么改，是判断（§2.4 判断不可代填）。
// 闭环因此成形：离线炼化 → 在线用 → **在线观测** → 候选浮出 → 我重炼 → 回到离线。

export interface RenewalCandidate {
  readonly name: string
  /** 为什么该续更（一句话，附可复算的数） */
  readonly why: string
  /** 排序强度（越大越该先看）。它是**序数**，不是分数——只用来排序，不解释为「好坏」 */
  readonly weight: number
}

export interface RenewalOptions {
  /** 用了这么多次却从未给过判定 ⇒ 该给一次显式 trial 或重炼（缺省 3） */
  readonly usedWithoutTrial: number
  /** 从未被用过、且创建超过这么多天 ⇒ 该复核它值不值得留（缺省 30） */
  readonly idleDays: number
}

export const RENEWAL_DEFAULTS: RenewalOptions = { usedWithoutTrial: 3, idleDays: 30 }

/**
 * 该续更的候选（按 weight 降序）。
 *
 * 三条规则（每条都附可复算的数，且**互不掩盖**——同一技能命中多条就把理由都写出来）：
 * 1. `loadFailures > 0` ⇒ 加载失败 N 次——**frontmatter / 名字可能有问题**（权重最高：
 *    它是**确定性失败**，不是「效果可能不好」）；
 * 2. `uses >= usedWithoutTrial` 且 `trials.attempted === 0` ⇒ 用了 N 次却**从未给过判定**
 *    ——该给一次显式 trial，或直接重炼（这是「在线用而不更新」的最常见形态）；
 * 3. `uses === 0` 且创建超过 `idleDays` 天 ⇒ 从未被用过——该复核它值不值得留
 *    （**只报，不自动归档**：I2「闲置不自动归档」不因本条而改）。
 *
 * ⚠ 年龄算不出来时（`createdAt` 不可解析）**不报第 3 条**——「算不出来」不许当成「很老」。
 */
export function renewalCandidates(
  ledger: SkillLedger,
  now: string,
  opts: RenewalOptions = RENEWAL_DEFAULTS,
): RenewalCandidate[] {
  const nowMs = Date.parse(now)
  const out: RenewalCandidate[] = []
  for (const [name, entry] of Object.entries(ledger.skills)) {
    if (entry.missing === true) continue // 目录已不在：续更无从谈起（保留记录，不在此面催）
    const reasons: string[] = []
    let weight = 0

    const failures = Math.max(0, Math.floor(entry.loadFailures ?? 0))
    if (failures > 0) {
      reasons.push('加载失败 ' + String(failures) + ' 次（确定性失败：frontmatter / 名字可能有问题）')
      weight += 100 + failures
    }
    if (entry.uses >= opts.usedWithoutTrial && entry.trials.attempted === 0) {
      reasons.push('用了 ' + String(entry.uses) + ' 次却从未给过判定（该给一次显式 trial，或直接重炼）')
      weight += 10 + Math.min(entry.uses, 90)
    }
    if (entry.uses === 0 && Number.isFinite(nowMs)) {
      const createdMs = Date.parse(entry.createdAt)
      if (Number.isFinite(createdMs)) {
        const days = Math.floor((nowMs - createdMs) / 86_400_000)
        if (days >= opts.idleDays) {
          reasons.push('从未被用过，创建已 ' + String(days) + ' 天（该复核值不值得留）')
          weight += 1
        }
      }
      // `createdAt` 不可解析 ⇒ 第 3 条不报（「算不出来」不是「很老」）
    }
    if (reasons.length > 0) out.push({ name, why: reasons.join('；'), weight })
  }
  return out.sort((a, b) => b.weight - a.weight || a.name.localeCompare(b.name))
}
