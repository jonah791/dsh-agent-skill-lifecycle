/**
 * renewal.test.mjs — P5（RSI mode = Offline→Online）的判据。
 *
 * 缺口（域图 §3.2 G4）：离线产出物（技能）**用完即止**——离线炼化 → 在线用 →
 * 没有「该回去改它」的信号。缺的**不是写入路径**（`skill_commit` 本就能覆盖已有 SKILL.md），
 * 缺的是**触发器**。本判据验的就是那个触发器。
 *
 * 判据与尸体：
 * ① 加载失败 ⇒ 报出且**权重最高**（确定性失败 > 效果可能不好）
 * ② 用了多次却零 trial ⇒ 报出；从未用过 + 超龄 ⇒ 报出
 * ③ 多条命中 ⇒ 理由**互不掩盖**（都写出来）
 * ④ **尸体**：`createdAt` 不可解析 ⇒ **不报**第 3 条（「算不出来」不许当成「很老」）
 * ⑤ **尸体**：`missing` 的技能不报（目录已不在，续更无从谈起）
 * ⑥ 干净技能**不出现在候选里**（恒为满的读数不是信号）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { RENEWAL_DEFAULTS, emptyLedger, ensureEntry, renewalCandidates } from '../lib/lifecycle.js'

const NOW = '2026-10-15T00:00:00.000Z'
const OLD = '2026-01-01T00:00:00.000Z'

function ledgerOf(entries) {
  let l = emptyLedger(NOW)
  for (const [name, patch] of Object.entries(entries)) {
    l = ensureEntry(l, name, patch.createdAt ?? NOW).ledger
    l.skills[name] = { ...l.skills[name], ...patch }
  }
  return l
}

// ── ① 加载失败优先 ─────────────────────────────────────────────────────────

test('加载失败 ⇒ 报出且**权重最高**（确定性失败 > 效果可能不好）', () => {
  const l = ledgerOf({
    broken: { loadFailures: 2 },
    popular: { uses: 50 }, // 零 trial 但只是「用得多的」
  })
  const rows = renewalCandidates(l, NOW)

  assert.equal(rows[0].name, 'broken', '确定性失败必须排在最前')
  assert.ok(rows[0].why.includes('加载失败 2 次'))
  assert.ok(rows[0].weight > rows[1].weight, '权重必须真的分开：' + String(rows[0].weight) + ' vs ' + String(rows[1].weight))
})

// ── ② 两类「该续更」 ───────────────────────────────────────────────────────

test('用了多次却**从未给过判定** ⇒ 报出（「在线用而不更新」的最常见形态）', () => {
  const l = ledgerOf({ hot: { uses: RENEWAL_DEFAULTS.usedWithoutTrial } })
  const rows = renewalCandidates(l, NOW)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].why.includes('从未给过判定'), rows[0].why)
})

test('从未用过 + 超过 idleDays ⇒ 报出（只报，不自动归档）', () => {
  const l = ledgerOf({ stale: { uses: 0, createdAt: OLD } })
  const rows = renewalCandidates(l, NOW)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].why.includes('从未被用过'), rows[0].why)
})

// ── ③ 理由不掩盖 ───────────────────────────────────────────────────────────

test('多条命中 ⇒ 理由**互不掩盖**（同一技能三条都写出来）', () => {
  const l = ledgerOf({ mess: { uses: 9, loadFailures: 1, createdAt: OLD, trials: { attempted: 0, passed: 0 } } })
  const rows = renewalCandidates(l, NOW)
  assert.equal(rows.length, 1)
  assert.ok(rows[0].why.includes('加载失败'), '第 1 条')
  assert.ok(rows[0].why.includes('从未给过判定'), '第 2 条')
  assert.ok(!rows[0].why.includes('从未被用过'), '第 3 条不成立（uses>0）——不该硬塞')
})

// ── ④⑤ 尸体 ───────────────────────────────────────────────────────────────

test('尸体：`createdAt` 不可解析 ⇒ **不报**第 3 条（「算不出来」不许当成「很老」）', () => {
  const l = ledgerOf({ weird: { uses: 0, createdAt: 'not-a-date' } })
  const rows = renewalCandidates(l, NOW)
  assert.equal(rows.length, 0, '日期算不出来 ⇒ 这一条判据**沉默**，不是「默认很老」')
})

test('尸体：`missing` 的技能不报（目录已不在，续更无从谈起）', () => {
  const l = ledgerOf({ gone: { uses: 9, loadFailures: 3, missing: true } })
  const rows = renewalCandidates(l, NOW)
  assert.equal(rows.length, 0)
})

// ── ⑥ 干净技能不入候选 ─────────────────────────────────────────────────────

test('干净技能**不出现在候选里**（恒为满的读数不是信号）', () => {
  const l = ledgerOf({ clean: { uses: 2, trials: { attempted: 2, passed: 2 }, createdAt: NOW } })
  const rows = renewalCandidates(l, NOW)
  assert.equal(rows.length, 0, '没有理由就不该出现在候选面')
})

test('排序：weight 降序，同权重按名字（确定性输出——同输入必同序）', () => {
  const l = ledgerOf({
    b: { loadFailures: 1 },
    a: { loadFailures: 1 },
    c: { uses: 5 },
  })
  const rows = renewalCandidates(l, NOW)
  assert.deepEqual(rows.map((r) => r.name), ['a', 'b', 'c'])
})
