/**
 * lifecycle 纯层离线单测（η 后验 + 状态机 + 台账变换）
 * 运行：先 build（tsc）再 node --test tests/lifecycle.test.mjs
 *
 * 判据对应 docs/semantic.md §7：
 *   L1 η 公式（含 MemOS 文档对照值 0/3→0.2、2/3→0.6）
 *   L2 状态机四向迁移
 *   L3 sync 新增/消失（missing 不删）
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  LIFECYCLE_DEFAULTS,
  emptyLedger,
  ensureEntry,
  etaOf,
  markUsed,
  nextStatus,
  recordTrial,
  summarize,
  syncNames,
} from '../lib/lifecycle.js'

const NOW = '2026-09-26T19:00:00.000Z'
const P = LIFECYCLE_DEFAULTS

describe('L1 · η 是 Beta(1,1) 后验', () => {
  test('无 trial → 0.5（先验诚实）', () => {
    assert.equal(etaOf({ attempted: 0, passed: 0 }), 0.5)
  })

  test('MemOS 文档对照值：0/3→0.2、2/3→0.6、3/3→0.8', () => {
    assert.equal(etaOf({ attempted: 3, passed: 0 }), 0.2)
    assert.equal(etaOf({ attempted: 3, passed: 2 }), 0.6)
    assert.equal(etaOf({ attempted: 3, passed: 3 }), 0.8)
  })

  test('平滑性：早期 trial 不把 η 甩到 0 或 1', () => {
    const one = etaOf({ attempted: 1, passed: 0 })
    assert.ok(one > 0, '一次失败不应使 η 归零')
    const perfect = etaOf({ attempted: 1, passed: 1 })
    assert.ok(perfect < 1, '一次成功不应使 η 到 1')
  })

  test('畸形输入被夹紧（passed 不得超过 attempted）', () => {
    assert.equal(etaOf({ attempted: 1, passed: 99 }), etaOf({ attempted: 1, passed: 1 }))
    assert.equal(etaOf({ attempted: -5, passed: -5 }), 0.5)
  })
})

describe('L2 · 状态机', () => {
  test('candidate + 满 3 trials + η≥0.5 → active', () => {
    assert.equal(nextStatus('candidate', 0.6, 3, P), 'active')
  })

  test('candidate + 满 3 trials + η<0.5 → archived', () => {
    assert.equal(nextStatus('candidate', 0.4, 3, P), 'archived')
  })

  test('candidate 未满试用期 → 原地不动', () => {
    assert.equal(nextStatus('candidate', 0.9, 2, P), 'candidate')
  })

  test('active + η 跌破 archiveEta → archived', () => {
    assert.equal(nextStatus('active', 0.2, 5, P), 'archived')
    assert.equal(nextStatus('active', 0.35, 5, P), 'active')
  })

  test('archived + η 回升 → candidate（可康复）', () => {
    assert.equal(nextStatus('archived', 0.6, 5, P), 'candidate')
    assert.equal(nextStatus('archived', 0.4, 5, P), 'archived')
  })

  test('端到端：三连失败把新技能推向 archived', () => {
    let ledger = emptyLedger(NOW)
    ledger = ensureEntry(ledger, 'probe-skill', NOW).ledger
    for (let i = 0; i < 3; i += 1) ledger = recordTrial(ledger, 'probe-skill', false, NOW).ledger
    const entry = ledger.skills['probe-skill']
    assert.equal(entry.trials.attempted, 3)
    assert.equal(entry.eta, 0.2)
    assert.equal(entry.status, 'archived')
  })

  test('端到端：三连成功把新技能推向 active', () => {
    let ledger = emptyLedger(NOW)
    ledger = ensureEntry(ledger, 'good-skill', NOW).ledger
    for (let i = 0; i < 3; i += 1) ledger = recordTrial(ledger, 'good-skill', true, NOW).ledger
    const entry = ledger.skills['good-skill']
    assert.equal(entry.eta, 0.8)
    assert.equal(entry.status, 'active')
  })
})

describe('L3 · sync 对账', () => {
  test('新增技能纳入为 candidate / η=0.5', () => {
    const { ledger, added } = syncNames(emptyLedger(NOW), ['a', 'b'], NOW)
    assert.deepEqual(added.sort(), ['a', 'b'])
    assert.equal(ledger.skills['a'].status, 'candidate')
    assert.equal(ledger.skills['a'].eta, 0.5)
  })

  test('消失技能标 missing 而非删除（留痕）', () => {
    let ledger = syncNames(emptyLedger(NOW), ['a', 'b'], NOW).ledger
    const out = syncNames(ledger, ['a'], NOW)
    assert.equal(out.ledger.skills['b'].missing, true)
    assert.ok(out.ledger.skills['b'] !== undefined, '条目必须保留')
    assert.deepEqual(out.missing, ['b'])
  })

  test('技能回归 → missing 清零并计入 revived', () => {
    let ledger = syncNames(emptyLedger(NOW), ['a'], NOW).ledger
    ledger = syncNames(ledger, [], NOW).ledger
    assert.equal(ledger.skills['a'].missing, true)
    const back = syncNames(ledger, ['a'], NOW)
    assert.equal(back.ledger.skills['a'].missing, false)
    assert.deepEqual(back.revived, ['a'])
  })

  test('sync 幂等：重复同步不新增', () => {
    const first = syncNames(emptyLedger(NOW), ['a'], NOW)
    const second = syncNames(first.ledger, ['a'], NOW)
    assert.deepEqual(second.added, [])
    assert.equal(Object.keys(second.ledger.skills).length, 1)
  })

  test('sync 无变化时返回**同一引用**（shell 层据此免写盘）', () => {
    const ledger = syncNames(emptyLedger(NOW), ['a'], NOW).ledger
    const again = syncNames(ledger, ['a'], NOW)
    assert.equal(again.added.length, 0)
    assert.equal(again.missing.length, 0)
    assert.equal(again.revived.length, 0)
    // 承重假设：`list` 自动 sync 的分支用 `synced.ledger !== ledger` 决定要不要 saveLedger。
    // 若这里返回新对象，每次 list 都会白写盘，并把 updatedAt 一直推后
    // ⇒「台账最后一次变动是什么时候」这个读数会永久失真（永远显示刚才）。
    assert.equal(again.ledger, ledger, '无变化时必须返回同一对象引用，否则每次 list 都会白写盘')
  })
})

describe('markUsed · 使用观测', () => {
  test('uses 单调递增且更新 lastUsedAt', () => {
    let ledger = syncNames(emptyLedger(NOW), ['a'], NOW).ledger
    ledger = markUsed(ledger, 'a', '2026-09-26T20:00:00.000Z').ledger
    const entry = ledger.skills['a']
    assert.equal(entry.uses, 1)
    assert.equal(entry.lastUsedAt, '2026-09-26T20:00:00.000Z')
    ledger = markUsed(ledger, 'a', '2026-09-26T21:00:00.000Z').ledger
    assert.equal(ledger.skills['a'].uses, 2)
  })

  test('未知技能 → changed=false，不凭空建条目', () => {
    const out = markUsed(emptyLedger(NOW), 'ghost', NOW)
    assert.equal(out.changed, false)
    assert.equal(out.entry, null)
    assert.equal(Object.keys(out.ledger.skills).length, 0)
  })
})

describe('summarize · 读数', () => {
  test('按状态计数 + 从未使用 + missing', () => {
    let ledger = syncNames(emptyLedger(NOW), ['a', 'b', 'c'], NOW).ledger
    for (let i = 0; i < 3; i += 1) ledger = recordTrial(ledger, 'a', true, NOW).ledger
    ledger = markUsed(ledger, 'a', NOW).ledger
    ledger = syncNames(ledger, ['a', 'c'], NOW).ledger   // b 消失 ⇒ missing
    const s = summarize(ledger)
    assert.equal(s.total, 3)
    // ★ 2026-11-03 口径修正：下面四个期望值**变了**，翻转原因逐条写明（不是「跟着实现改数」）。
    //   旧断言：byStatus.candidate === 2（b + missing 的 c）、neverUsed === 2（b + missing 的 c）。
    //   病症：`c` 目录已不在，却仍被算进「我有多少候选技能」「多少从未使用」——
    //   实测放大到 221 条台账上就是 candidate 220 vs 真实 29、neverUsed 167 vs 真实 25（差 6.7 倍）。
    //   新口径：missing 的条目**不进** byStatus / neverUsed / lowEta，改由 merged / unknownOrigin 单独计数。
    assert.equal(s.present, 2, '在场只有 a 和 c（b 目录已缺失）')
    assert.equal(s.byStatus.active, 1, 'a 已毕业')
    assert.equal(s.byStatus.candidate, 1, '**只剩在场未毕业的 c**；missing 的 b 不算候选')
    assert.equal(s.missingCount, 1, '= merged + unknownOrigin')
    assert.equal(s.neverUsed, 1, '**只有在场且 uses=0 的 c**；missing 的 b 不算「从未使用」')
  })

  test('★ 尸体：missing 且无 mergedInto ⇒ 计入 unknownOrigin，不计 merged', () => {
    const ledger = {
      version: 1,
      updatedAt: NOW,
      skills: {
        'old-name': {
          status: 'candidate', eta: 0.5, trials: { attempted: 0, passed: 0 }, uses: 9,
          source: 'scan', createdAt: NOW, lastUsedAt: null, missing: true,
        },
      },
    }
    const s = summarize(ledger)
    assert.equal(s.total, 1)
    assert.equal(s.present, 0)
    assert.equal(s.merged, 0)
    assert.equal(s.unknownOrigin, 1, '**不知道去处**必须与「已合并」分开报——两者修法完全不同')
    assert.equal(s.missingCount, 1)
    assert.equal(s.neverUsed, 0, '幽灵的 uses=0 不算「从未使用」')
    assert.equal(s.byStatus.candidate, 0, '幽灵不进状态计数')
  })

  test('★ merged 与 unknownOrigin 可区分，且 missingCount = 两者之和', () => {
    const base = {
      status: 'candidate', eta: 0.5, trials: { attempted: 0, passed: 0 }, uses: 0,
      source: 'scan', createdAt: NOW, lastUsedAt: null,
    }
    const ledger = {
      version: 1,
      updatedAt: NOW,
      skills: {
        alive: { ...base },
        'ghost-merged': { ...base, missing: true, mergedInto: 'engineering-core' },
        'ghost-merged-2': { ...base, missing: true, mergedInto: 'ops-management' },
        'ghost-unknown': { ...base, missing: true },
      },
    }
    const s = summarize(ledger)
    assert.equal(s.total, 4)
    assert.equal(s.present, 1, '只有 alive 在场')
    assert.equal(s.merged, 2)
    assert.equal(s.unknownOrigin, 1)
    assert.equal(s.missingCount, 3, 'merged + unknownOrigin')
    assert.equal(s.byStatus.candidate, 1, '状态计数只含在场的 alive')
    assert.equal(s.neverUsed, 1, '只含在场的 alive')
  })

  test('回归：没有幽灵时读数与修前完全一致', () => {
    let ledger = syncNames(emptyLedger(NOW), ['x', 'y'], NOW).ledger
    ledger = markUsed(ledger, 'x', NOW).ledger
    const s = summarize(ledger)
    assert.equal(s.total, 2)
    assert.equal(s.present, 2)
    assert.equal(s.merged, 0)
    assert.equal(s.unknownOrigin, 0)
    assert.equal(s.missingCount, 0)
    assert.equal(s.byStatus.candidate, 2)
    assert.equal(s.neverUsed, 1)
  })
})
