<!--
  DSH 插件生态公约声明（plugin-ecosystem-convention · 组合优先/声明清晰/兼容优先）
  purpose: 技能生命周期（借鉴 MemOS skill lifecycle）：Beta(1,1) 后验 η + candidate/active/archived 状态机 + 使用观测（tools/result 的 skill 调用）+ 台账 sidecar；不自动删除技能，只报告与显式流转
  inject: 'tools','agents'
  tools: skill_lifecycle
  runtime: host-only
  envDeps: 无
  boundary: 不自动删除技能（只报告 + 显式流转）；观测不反噬（台账读写失败吞错返回 false，绝不影响会话）
  compat: cordis ^4.0.1 / schemastery ^3.18.1-rc.1 / dsh-tools >=0.1.0-rc.6
-->
# dsh-agent-skill-lifecycle

<p align="center">
  <a href="https://github.com/jonah791/dsh-agent-skill-lifecycle"><img src="https://img.shields.io/badge/version-0.3.0-blue" alt="version"></a>
  <img src="https://img.shields.io/badge/License-MIT-green" alt="license">
  <img src="https://img.shields.io/badge/TypeScript-3178C6" alt="TypeScript">
  <img src="https://img.shields.io/badge/tests-45%20passed-brightgreen" alt="tests">
</p>

**一句话**：给技能库一个**生命周期台账**——用 Beta 后验 η 记录「哪个技能真好用」，并维护 candidate / active / archived 三态流转。

**为什么值得用**：技能多了之后，「哪些还在用、哪些是死重量」靠印象判断必然失真。本插件把这件事变成**可复算的读数**：η = `(passed+1)/(attempted+2)`（Beta(1,1) 后验期望）——**没有 trial 数据时 η = 0.5**（先验诚实，不假装知道哪个技能好用），试过几次后平滑逼近真实成功率（0/3 → 0.2，2/3 → 0.6）。⚠ 它**不自动删除任何技能**——只报告与显式流转，删除权归主体。

## 能力

**工具面 1 个**（名称逐字来自 `src/index.ts` 的 `defineTool({ name })`）：

| 工具 | 用途 |
|------|------|
| `skill_lifecycle` | 技能生命周期台账：`sync`（扫描技能目录纳入新技能，**不删任何文件**）· `list`（按 η 升序，最该关注的在前）· `record`（记一次显式试用的 pass/fail，η 随之更新并跑状态机）· `archive` / `restore`（显式流转） |

## 快速开始

**1) 装依赖**：

```jsonc
"dsh-agent-skill-lifecycle": "link:E:/alice/self-plugins/dsh-agent-skill-lifecycle"
```

**2) 挂组合**：

```yaml
- id: skill-lifecycle
  name: dsh-agent-skill-lifecycle
```

**3) 30 秒验证**：调 `skill_lifecycle {action: "sync"}` → 应报「纳入 N 个新技能」；再 `{action: "list"}` → 应给出按 η 升序的技能清单（**不删除任何文件**）。

## 配置

见源码 `Config`。**无必填项**——缺省即按本机技能目录工作。

## 落盘与自证

| 文件 | 何时写 | 内容 |
|---|---|---|
| 台账 sidecar（由 `resolveLedgerPath(env)` 解析，落在插件状态目录） | 每次 `sync` / `record` / `archive` / `restore` | 每技能一行：`attempted` / `passed` / η / status / `uses` / `missing` 标记 |

⚠ **读不到或损坏 ⇒ 返回空台账，绝不抛**（`loadLedger` 的契约）——台账是**证据**，不是会话的前置条件。
⚠ `missing` 标记**取代删除**：技能文件消失只标记，不抹掉历史（I3 只增不减）。

## 生效判据与回退

**怎么证明线上跑的是当前构建**：
1. 行为级（最直接）：`skill_lifecycle {action:"list"}` 返回按 η 升序的清单；
2. 构建级：`lib/index.js` mtime 晚于 web 进程启动时间（⚠ 重新构建 ≠ 生效，必须重启）。

**回退**：① `git revert` + 重建 + 预检重启；② patch 行 `disabled: true`；③ 台账是 sidecar 文件，**停用不影响技能本身**。

## 测试

```bash
cd self-plugins/dsh-agent-skill-lifecycle && npm test
```

**45 条用例**（跑一次得到）：覆盖 η 后验平滑（0/3 → 0.2、2/3 → 0.6）· **先验诚实**（无 trial ⇒ 0.5）· 状态机封闭（迁移只经 `nextStatus()`）· **只增不减的留痕**（`missing` 取代删除、`uses` 单调不减）· **观测不反噬**（台账不可写 ⇒ 返回 false 且**不抛**）· 空/损坏台账退化路径。无需网络。

## 设计要点

- **I1 先验诚实**：无 trial 数据时 η = 0.5（Beta(1,1) 期望），**不假装知道**哪个技能好用。
- **I2 后验平滑**：η 恒为 `(passed+1)/(attempted+2)`，早期 trial 不会把 η 甩到 0 或 1。
- **I3 只增不减的留痕**：`missing` 标记取代删除；`uses` 单调不减。
- **I4 状态机封闭**：状态迁移只经 `nextStatus()`，无隐式路径。
- **I5 观测不反噬**：台账读写失败一律吞错返回 `false`，**绝不影响会话**（§5.22 规则 3）。
- **为什么「不自动删除」**：删除是不可逆的；本插件只把「哪个技能该看」变成读数，**决策权归主体**。

## 相关文档

- [`docs/semantic.md`](docs/semantic.md) —— **权威契约**（定位/反定位 · 术语 · 5 条不变量 · 验收表）
- 中心仓：[alice-digital-life](https://github.com/jonah791/alice-digital-life)（本插件归 **认知层**）
- 相关技能：`skill-maintenance`（技能的常态化维护规范）

## License

MIT © jonah791

---

本插件属于**爱丽丝 DSH 自研插件生态**（[alice-digital-life](https://github.com/jonah791/alice-digital-life) · 73 个插件 · 8 个模块）：单一职责、独立仓库、独立可用。
