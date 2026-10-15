/**
 * @module dsh-agent-skill-lifecycle
 * Skill lifecycle management, adapted from MemOS `core/skill/lifecycle.ts`
 * (V7 §2.5): Beta(1,1) posterior η, candidate → active / archived transitions,
 * and explicit rehabilitation.
 *
 * Division of labour: `dsh-agent-skill-forge` births skills from traces; this
 * plugin keeps them healthy. It scans the skill roots directly (no dependency
 * on the forge) and observes real use through `tools/result`.
 *
 * Discipline: archived never deletes a SKILL.md, idleness never auto-archives
 * (v0.1 reports only), and every I/O path is guarded so the mechanism can never
 * bite back (§5.22 rule 3 / §5.24).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  LIFECYCLE_DEFAULTS,
  emptyLedger,
  ensureEntry,
  markLoadFailure,
  markUsed,
  recordTrial,
  renewalCandidates,
  summarize,
  syncNames,
  type LifecyclePolicy,
  type SkillEntry,
  type SkillLedger,
  type SkillStatus,
} from './lifecycle.ts'
import { scanSkillNames, skillRoots } from './registry.ts'

export const name = 'agent-skill-lifecycle'
export const inject = ['tools', 'agents'] as const

export interface Config {
  enabled: boolean
  candidateTrials: number
  minEtaForActive: number
  archiveEta: number
}

export const Config: z<Config> = z.object({
  enabled: z.boolean().default(true),
  candidateTrials: z.number().default(LIFECYCLE_DEFAULTS.candidateTrials),
  minEtaForActive: z.number().default(LIFECYCLE_DEFAULTS.minEtaForActive),
  archiveEta: z.number().default(LIFECYCLE_DEFAULTS.archiveEta),
})

/** Ledger path — sidecar next to the other plugin state (§5.22). */
export function resolveLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const dshHome = env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(dshHome, 'skill-lifecycle.json')
}

/**
 * Load the ledger. A missing or corrupt file yields an empty ledger — never
 * throws, so a damaged sidecar cannot take the session down.
 * @param path - Ledger path.
 * @returns Parsed ledger, or an empty one.
 */
export function loadLedger(path: string, now: string = new Date().toISOString()): SkillLedger {
  try {
    if (!existsSync(path)) return emptyLedger(now)
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SkillLedger>
    if (parsed === null || typeof parsed !== 'object' || typeof parsed.skills !== 'object' || parsed.skills === null) {
      return emptyLedger(now)
    }
    return { version: 1, updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : now, skills: parsed.skills }
  } catch (e: unknown) {
    void e
    return emptyLedger(now)
  }
}

/**
 * Persist the ledger.
 * @param path - Ledger path.
 * @param ledger - Ledger to write.
 * @returns `true` when written; `false` on any failure (never throws).
 */
export function saveLedger(path: string, ledger: SkillLedger): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`)
    return true
  } catch (e: unknown) {
    void e
    return false
  }
}

/** Row shape returned to the tool. */
interface EntryView {
  name: string
  status: SkillStatus
  eta: number
  /** 显式 trial 的尝试数（**不含**自动观测的加载失败——两者口径不同，见 `lifecycle.ts`） */
  attempted: number
  passed: number
  uses: number
  /** 自动观测到的加载失败数（P3 起；缺省 0 ⇒ 旧台账读出来也是 0，不是「未知」） */
  loadFailures: number
  lastUsedAt?: string
  missing?: boolean
}

function viewOf(name: string, entry: SkillEntry): EntryView {
  const view: EntryView = {
    name,
    status: entry.status,
    eta: Number(entry.eta.toFixed(3)),
    attempted: entry.trials.attempted,
    passed: entry.trials.passed,
    uses: entry.uses,
    loadFailures: Math.max(0, Math.floor(entry.loadFailures ?? 0)),
  }
  if (entry.lastUsedAt !== null) view.lastUsedAt = entry.lastUsedAt
  if (entry.missing === true) view.missing = true
  return view
}

/** Tool parameter shape (loose host input). */
interface ToolArgs {
  action?: unknown
  skill?: unknown
  verdict?: unknown
  status?: unknown
  limit?: unknown
}

/**
 * Mount the lifecycle manager.
 * @param ctx - Plugin context.
 * @param config - Validated configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('agent-skill-lifecycle')
  const ledgerPath = resolveLedgerPath()
  const policy: LifecyclePolicy = {
    candidateTrials: config.candidateTrials,
    minEtaForActive: config.minEtaForActive,
    archiveEta: config.archiveEta,
    initialEta: LIFECYCLE_DEFAULTS.initialEta,
  }
  const now = (): string => new Date().toISOString()

  /** Guarded wrapper: a throwing callback must never escape into the host. */
  const guarded = (stage: string, fn: () => void): void => {
    try {
      fn()
    } catch (e: unknown) {
      log.warn('[agent-skill-lifecycle] ' + stage + ' 失败：' + (e instanceof Error ? e.message : String(e)))
    }
  }

  const roots = (): string[] => skillRoots(process.cwd())

  const lifecycleTool: ToolDefinition = defineTool({
    name: 'skill_lifecycle',
    description:
      '技能生命周期（读+显式流转）：Beta(1,1) 后验 η + candidate/active/archived 三态。'
      + 'action=sync 扫描技能目录纳入新技能（不删任何文件）；list 按 η 升序列出（最该关注的在前）；'
      + 'record 记一次显式试用的 pass/fail（η 随之更新并跑状态机）；archive/restore 显式流转。'
      + '不带 skill 的 list 给出总览。决策归爱丽丝——本工具只维护台账与读数。',
    parameters: {
      action: { type: 'string', description: 'sync | list | record | archive | restore（缺省 list）' },
      skill: { type: 'string', description: '技能名（record/archive/restore 必填）' },
      verdict: { type: 'string', description: 'record 时：pass | fail' },
      status: { type: 'string', description: 'list 时按状态过滤：candidate | active | archived' },
      limit: { type: 'number', description: 'list 返回条数（缺省 30）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'number', required: true },
          candidate: { type: 'number', required: true },
          active: { type: 'number', required: true },
          archived: { type: 'number', required: true },
          neverUsed: { type: 'number', required: true },
          missing: { type: 'number', required: true },
          entries: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                status: { type: 'string', required: true },
                eta: { type: 'number', required: true },
                attempted: { type: 'number', required: true },
                passed: { type: 'number', required: true },
                uses: { type: 'number', required: true },
                loadFailures: { type: 'number', required: true },
                lastUsedAt: { type: 'string' },
                missing: { type: 'boolean' },
              },
            },
          },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: any) => {
        const head = `技能生命周期 · 共 ${value.total}｜candidate ${value.candidate} / active ${value.active} / archived ${value.archived}`
          + `｜从未使用 ${value.neverUsed}｜目录缺失 ${value.missing}`
        const rows = (value.entries as EntryView[]).map(
          (e) => `• ${e.name} [${e.status}] η=${e.eta} trials ${e.passed}/${e.attempted} uses=${e.uses}`
            + (e.loadFailures > 0 ? ` 加载失败=${e.loadFailures}` : '')
            + (e.missing ? ' (missing)' : ''),
        )
        return [{ type: 'text', text: [head, ...rows, value.note].join('\n') }]
      },
    },
    async execute(args: ToolArgs) {
      let ledger = loadLedger(ledgerPath, now())
      const action = typeof args.action === 'string' && args.action !== '' ? args.action : 'list'
      const skill = typeof args.skill === 'string' ? args.skill : undefined
      let note = ''

      if (action === 'sync') {
        const names = scanSkillNames(roots())
        const out = syncNames(ledger, names, now(), policy)
        ledger = out.ledger
        saveLedger(ledgerPath, ledger)
        note = `扫描到 ${names.length} 个技能：新增 ${out.added.length}、回归 ${out.revived.length}、目录缺失 ${out.missing.length}（缺失只标记不删除）。`
      } else if (action === 'record') {
        if (skill === undefined || (args.verdict !== 'pass' && args.verdict !== 'fail')) {
          note = 'record 需要 skill 与 verdict(pass|fail)——未改动台账。'
        } else {
          const ensured = ensureEntry(ledger, skill, now(), policy)
          ledger = ensured.ledger
          const out = recordTrial(ledger, skill, args.verdict === 'pass', now(), policy)
          if (out.entry === null) {
            note = `技能 ${skill} 不在台账中——先 sync。`
          } else {
            ledger = out.ledger
            saveLedger(ledgerPath, ledger)
            note = `已记 trial：${skill} ${args.verdict === 'pass' ? '通过' : '失败'}`
              + ` ⇒ η=${out.entry.eta.toFixed(3)}，状态 ${out.entry.status}。`
          }
        }
      } else if (action === 'archive' || action === 'restore') {
        const entry = skill === undefined ? undefined : ledger.skills[skill]
        if (skill === undefined || entry === undefined) {
          note = `${action} 需要已存在的 skill——先 sync 或检查技能名。`
        } else {
          const status: SkillStatus = action === 'archive' ? 'archived' : 'candidate'
          ledger = { ...ledger, updatedAt: now(), skills: { ...ledger.skills, [skill]: { ...entry, status } } }
          saveLedger(ledgerPath, ledger)
          note = `${skill} → ${status}（${action === 'restore' ? '康复回试用期' : '退场，文件保留'}）。`
        }
      } else if (action !== 'list') {
        note = `未知 action「${action}」——按 list 处理（未改动台账）。`
      }

      const summary = summarize(ledger)
      const statusFilter = typeof args.status === 'string' && args.status !== '' ? args.status : undefined
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.floor(args.limit) : 30
      const all = Object.entries(ledger.skills)
        .map(([n, e]) => viewOf(n, e))
        .filter((e) => statusFilter === undefined || e.status === statusFilter)
        .sort((a, b) => a.eta - b.eta || b.uses - a.uses)
      if (note === '') {
        note = '按 η 升序（最该关注的在前）。η 是 Beta(1,1) 后验：无 trial 时恒为 0.5——没有证据就不假装知道。'
      }
      // 续更候选（P5 · Offline→Online 的入口）：把**在线观测**翻成「该回去改它」的信号。
      // 只报不改——是否重炼、怎么改是判断（§2.4）。⚠ 只在 list 动作上追加（别的动作有自己的 note）。
      if (action === 'list') {
        const renew = renewalCandidates(ledger, now())
        note += renew.length === 0
          ? '\n续更候选：0 条（在线观测里没有「该回去改它」的信号）。'
          : '\n续更候选 ' + String(renew.length) + ' 条（确定性失败 > 用得多的 > 闲置；**只报不改**）：\n'
            + renew.slice(0, 5).map((r) => '  · ' + r.name + '：' + r.why).join('\n')
            + (renew.length > 5 ? '\n  …还有 ' + String(renew.length - 5) + ' 条' : '')
      }
      return {
        action,
        total: summary.total,
        candidate: summary.byStatus.candidate,
        active: summary.byStatus.active,
        archived: summary.byStatus.archived,
        neverUsed: summary.neverUsed,
        missing: summary.missingCount,
        entries: all.slice(0, limit),
        note,
      }
    },
  })
  ctx.tools.register(lifecycleTool)

  // 使用观测：skill **成功**调用 ⇒ uses++ / lastUsedAt；**失败**调用 ⇒ loadFailures++（P3 起不再丢弃）。
  // ⚠ 两条路径都**不凭空建条目**（未知技能名不入册）——那是 `syncNames` 的职责。
  ctx.on('tools/result', (exec: unknown, result: unknown) => {
    if (!config.enabled) return
    guarded('tools/result', () => {
      const e = exec as { name?: unknown; arguments?: { name?: unknown }; input?: { name?: unknown } } | undefined
      if (e?.name !== 'skill') return
      const skillName = e.arguments?.name ?? e.input?.name
      if (typeof skillName !== 'string' || skillName === '') return
      const failed = (result as { isError?: unknown } | undefined)?.isError === true
      const ledger = loadLedger(ledgerPath, now())
      // P3：失败**不再丢弃**——它是「这个技能加载不了」的真信号（G6 的「信号稀疏」有一半来自这里）。
      // 单向：失败拉低 η，成功加载**不**抬高 η（理由见 lifecycle.ts 的 effectiveTrials）。
      const out = failed ? markLoadFailure(ledger, skillName, now()) : markUsed(ledger, skillName, now())
      if (out.changed) saveLedger(ledgerPath, out.ledger)
    })
  })

  log.info('[agent-skill-lifecycle] 就绪（台账 ' + ledgerPath + '）')
}
