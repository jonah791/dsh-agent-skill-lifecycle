/**
 * load-failure.test.mjs — P3（技能结果信号）的判据。
 *
 * 修的是什么：旧实现 `if (isError) return` 把**加载失败直接丢弃** ⇒
 * 「一个技能反复加载失败」这种真信号**在读数里不存在**（G6「信号稀疏」有一半来自这里）。
 *
 * 判据与尸体：
 * ① 加载失败**拉低** η；**尸体**：成功加载**不**抬高 η（不对称是刻意的）
 * ② 两个计数器**口径分开**（`trials` 显式 / `loadFailures` 自动）——并进一个就分不清谁在说话
 * ③ η 的输入是 `effectiveTrials` 的**单一真源**
 * ④ 旧台账（无字段）⇒ 当 0，不是 NaN；未知技能不凭空入册
 * ⑤ 失败累积能推动状态机（active → archived）
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  LIFECYCLE_DEFAULTS,
  effectiveTrials,
  emptyLedger,
  ensureEntry,
  etaOf,
  markLoadFailure,
  markUsed,
  recordTrial,
} from '../lib/lifecycle.js'

const NOW = '2026-10-15T00:00:00.000Z'

function ledgerWith(name) {
  return ensureEntry(emptyLedger(NOW), name, NOW).ledger
}

// ── ① 失败拉低 η（不对称） ─────────────────────────────────────────────────

test('加载失败**拉低** η（旧实现把失败丢了 ⇒ 这条判据在旧代码下无从谈起）', () => {
  const l0 = ledgerWith('alpha')
  const before = l0.skills['alpha'].eta
  const out = markLoadFailure(l0, 'alpha', NOW)

  assert.equal(out.changed, true)
  assert.equal(out.entry.loadFailures, 1)
  assert.ok(out.entry.eta < before, 'η 必须下降：' + String(before) + ' → ' + String(out.entry.eta))
})

test('尸体：**成功加载不抬高 η**（若当 pass 计入，所有 η 会被拉向 1，区分力淹没）', () => {
  const l0 = ledgerWith('beta')
  const before = l0.skills['beta'].eta
  const out = markUsed(l0, 'beta', NOW)

  assert.equal(out.entry.uses, 1, 'uses 照常前进')
  assert.equal(out.entry.eta, before, 'η 一字不动——抬高 η 的唯一途径是显式 trial')
})

// ── ② 口径分开 ─────────────────────────────────────────────────────────────

test('两个计数器口径分开：trials 只记显式、loadFailures 只记自动', () => {
  let l = ledgerWith('gamma')
  l = recordTrial(l, 'gamma', true, NOW).ledger
  l = markLoadFailure(l, 'gamma', NOW).ledger

  const e = l.skills['gamma']
  assert.deepEqual(e.trials, { attempted: 1, passed: 1 }, '显式 trial 只记自己那一次')
  assert.equal(e.loadFailures, 1, '自动失败独立成档（不并进 trials——并了就分不清谁在说话）')
})

// ── ③ 单一真源 ─────────────────────────────────────────────────────────────

test('η 的输入是 `effectiveTrials` 的单一真源（合并显式与自动）', () => {
  let l = ledgerWith('delta')
  l = recordTrial(l, 'delta', true, NOW).ledger
  l = markLoadFailure(l, 'delta', NOW).ledger

  const e = l.skills['delta']
  assert.deepEqual(effectiveTrials(e), { attempted: 2, passed: 1 }, '显式 1/1 ∪ 自动失败 1 ⇒ 2 次尝试 1 次通过')
  assert.equal(e.eta, etaOf(effectiveTrials(e)), 'η 必须等于按合并输入算出的值')
})

// ── ④ 兼容与守卫 ───────────────────────────────────────────────────────────

test('旧台账（无 `loadFailures` 字段）⇒ 当 0，不是 NaN', () => {
  const legacy = ledgerWith('epsilon')
  delete legacy.skills['epsilon'].loadFailures

  assert.deepEqual(effectiveTrials(legacy.skills['epsilon']), { attempted: 0, passed: 0 })
  assert.equal(legacy.skills['epsilon'].eta, 0.5, 'η 不受缺字段影响')

  const out = markLoadFailure(legacy, 'epsilon', NOW)
  assert.equal(out.entry.loadFailures, 1, '从缺省 0 起算，不是 NaN')
  assert.ok(Number.isFinite(out.entry.eta), 'η 必须仍是有限数')
})

test('尸体：未知技能 ⇒ 不建条目（不凭空入册）', () => {
  const l0 = emptyLedger(NOW)
  const out = markLoadFailure(l0, 'nope', NOW)

  assert.equal(out.changed, false)
  assert.equal(out.entry, null)
  assert.deepEqual(Object.keys(out.ledger.skills), [], '不得凭空建条目')
})

// ── ⑤ 推动状态机 ───────────────────────────────────────────────────────────

test('失败累积能推动状态机：active 被连续加载失败拖到 archived', () => {
  let l = ledgerWith('zeta')
  l = recordTrial(l, 'zeta', true, NOW).ledger
  l = recordTrial(l, 'zeta', true, NOW).ledger
  l = recordTrial(l, 'zeta', true, NOW).ledger
  assert.equal(l.skills['zeta'].status, 'active', '前置：3 次通过 ⇒ active')

  let eta = l.skills['zeta'].eta
  for (let i = 0; i < 9; i++) {
    const out = markLoadFailure(l, 'zeta', NOW)
    l = out.ledger
    assert.ok(out.entry.eta <= eta, '每次失败都不该抬高 η')
    eta = out.entry.eta
  }

  assert.ok(eta < LIFECYCLE_DEFAULTS.archiveEta, 'η 跌破归档线：' + String(eta))
  assert.equal(l.skills['zeta'].status, 'archived', '状态机必须跟着动（不是只改数字）')
})
