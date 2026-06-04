# Layer 3.4: Subagent Runtime Limits — max_steps & timeout_seconds Enforcement

> 前置依赖: Layer 0（核心安全: Permission + Discipline）、Layer 3.3（上下文隔离: Coordinator-Worker 分离）
> 本文档修复一个架构缺口：task 工具的 `max_steps` 和 `timeout_seconds` 参数虽然在 Schema 中定义，但未被 runtime 实际执行。
> 无步数上限的 subagent 可能无限循环消耗 token；无超时切断的 subagent 可能长时间阻塞 coordinator。
> 修复目标：让 task dispatch 参数真正限制 subagent 的步数和运行时间。

---

## 目录

1. [缺口分析](#1-缺口分析)
2. [当前实现追踪](#2-当前实现追踪)
3. [修复方案](#3-修复方案)
4. [文件改动清单](#4-文件改动清单)
5. [对 Layer 3.3 的影响](#5-对-layer-33-的影响)
6. [验收清单](#6-验收清单)

---

## 1. 缺口分析

### 1.1 问题概述

task 工具的 Zod Schema 定义了两个可选参数：

```ts
// packages/opencode/src/tool/task.ts:34-35
max_steps: z.number().int().min(1).max(50).optional(),
timeout_seconds: z.number().int().min(30).max(600).optional(),
```

这两个参数在 `Discipline.Schema` 中也存在（`packages/opencode/src/session/discipline.ts:14-15`），但 `Discipline.compile()` **完全不处理它们**——compile 只处理 `permission_override`、`env_scope`、`file_scope`、`delegation_depth` 四类规则，将其转为 Permission.Ruleset。`max_steps` 和 `timeout_seconds` 被丢弃。

### 1.2 运行时后果

| 参数              | 当前行为                                                                                                             | 风险                                                                                         |
| ----------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `max_steps`       | subagent 步数由 agent 定义的 `steps` 字段控制；若未定义则默认 `Infinity`（`prompt.ts:581: agent.steps ?? Infinity`） | 无步数上限的 subagent 可无限循环消耗 token。research-worker.md 未定义 `steps`，默认 Infinity |
| `timeout_seconds` | 不存在任何超时切断机制；task.ts 的 `execute()` 不向 `Session.create` 或 `SessionPrompt.prompt` 传递此参数            | 长时间运行的 subagent 阻塞 coordinator。Docker 执行、论文搜索等可能耗时数分钟                |

### 1.3 影响范围

不仅影响 research-worker，影响**所有通过 task 工具 dispatch 的 subagent**：

| subagent          | 有 `steps` 定义? | 步数上限 | 有超时? |
| ----------------- | ---------------- | -------- | ------- |
| research-worker   | 无               | Infinity | 无      |
| research-explorer | 无               | Infinity | 无      |
| sandbox-executor  | 无               | Infinity | 无      |
| gpd-verifier      | 无               | Infinity | 无      |
| research-verifier | 无               | Infinity | 无      |
| explore           | 无               | Infinity | 无      |
| general           | 无               | Infinity | 无      |

所有 subagent 均无 runtime 步数限制和超时切断。

---

## 2. 当前实现追踪

### 2.1 数据流（当前）

```
task tool params:
  max_steps: 20, timeout_seconds: 300
     │
     ▼
Discipline.compile({ max_steps, timeout_seconds, ... })
     │
     ▼ → 返回 Permission.Ruleset
     │    (max_steps 和 timeout_seconds 被丢弃)
     │
     ▼
Permission.intersection(caller, agent, disciplineRules)
     │
     ▼
Session.create({ parentID, title, permission: finalPermission })
     │  ← 无 max_steps / timeout_seconds 字段
     │
     ▼
SessionPrompt.prompt → prompt.ts loop
     │
     ▼
const maxSteps = agent.steps ?? Infinity  ← 唯一步数来源: agent 定义
     │
     ▼
isLastStep = step >= maxSteps → inject MAX_STEPS reminder
     │  ← Infinity 永不触发
```

### 2.2 关键代码位置

| 文件                           | 行号    | 作用                                                             | 问题                                           |
| ------------------------------ | ------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| `tool/task.ts`                 | 34-35   | Zod Schema 定义 `max_steps`/`timeout_seconds`                    | 参数接收但未传给 runtime                       |
| `tool/task.ts`                 | 116-122 | 构造 discipline 对象，包含这两个参数                             |                                                |
| `session/discipline.ts`        | 14-15   | Schema 包含这两个字段                                            |                                                |
| `session/discipline.ts`        | 19-59   | `compile()` 函数                                                 | **不处理** max_steps/timeout_seconds           |
| `tool/task.ts`                 | 158-162 | `Session.create()` 调用                                          | 只传 parentID/title/permission                 |
| `session/prompt.ts`            | 581     | `maxSteps = agent.steps ?? Infinity`                             | 唯一步数来源，不考虑 task dispatch             |
| `session/prompt.ts`            | 677-684 | `isLastStep` → 注入 MAX_STEPS 提醒                               | Infinity 时永不触发                            |
| `session/prompt/max-steps.txt` | 全文    | MAX_STEPS 提醒内容                                               | 机制本身完善，只是触发条件不对                 |
| `agent/agent.ts`               | 291     | `item.maxSteps = value.max_steps ?? item.maxSteps ?? item.steps` | 只在 agent 定义加载时生效，非 task dispatch 时 |

### 2.3 agent.ts:291 的局限性

```ts
item.maxSteps = value.max_steps ?? item.maxSteps ?? item.steps
```

这行在**agent 定义加载**时将 frontmatter 的 `max_steps`/`maxSteps`/`steps` 合并到 `item.maxSteps`。它不是 task dispatch 时的运行时覆盖——task dispatch 的 `max_steps` 参数不经过此路径。

---

## 3. 修复方案

### 3.1 设计决策

| 决策                        | 选择                                         | 原因                                                                                                      |
| --------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| max_steps 传递方式          | 通过 Session 元数据传递                      | 步数限制是 session 级别约束，不是 permission 规则；Discipline.compile 处理权限语义，不应承担 runtime 限制 |
| timeout_seconds 传递方式    | 通过 Session 元数据传递 + Race 模式执行      | 超时是 session 级别约束，需要在 prompt loop 中与 LLM 调用并行执行                                         |
| 优先级规则                  | task dispatch > agent 定义 > Infinity        | dispatch 参数应为最具体限制；agent 定义是默认；无任何限制则 Infinity                                      |
| Discipline.compile 是否处理 | 不处理（保持现状）                           | 这些不是权限语义，compile 应只处理权限相关规则                                                            |
| Session.create Schema 扩展  | 增加 `maxSteps` 和 `timeoutSeconds` 可选字段 | 需要持久化到 DB 以支持 session recovery                                                                   |
| 是否修改 DB schema          | 是，增加 `max_steps` 和 `timeout_seconds` 列 | session recovery 需要恢复这些限制                                                                         |

### 3.2 max_steps 修复

#### 3.2.1 数据流（修复后）

```
task tool params:
  max_steps: 20, timeout_seconds: 300
     │
     ├─→ Discipline.compile  ← 不处理（保持现状）
     │
     └─→ Session.create({ ..., maxSteps: 20, timeoutSeconds: 300 })
          │  ← 新字段，持久化到 DB
          │
          ▼
     SessionPrompt.prompt → prompt.ts loop
          │
          ▼
     const maxSteps = session.maxSteps ?? agent.steps ?? Infinity
          │  ← 优先级: task dispatch > agent 定义 > Infinity
          │
          ▼
     isLastStep = step >= maxSteps → inject MAX_STEPS reminder
          │  ← 现有机制，触发条件现在正确
```

#### 3.2.2 修改点

**A. Session.create — 接收并持久化 max_steps**

`packages/opencode/src/session/index.ts`:

Session.Info 增加：

```ts
maxSteps?: number
timeoutSeconds?: number
```

Session.create 增加：

```ts
export async function create(input: {
  title?: string
  parentID?: SessionID
  permission?: Permission.Ruleset
  maxSteps?: number // 新增
  timeoutSeconds?: number // 新增
})
```

**B. DB Schema — 增加两列**

`packages/opencode/src/**/*.sql.ts`:

session 表增加：

```ts
max_steps: integer().default(null),
timeout_seconds: integer().default(null),
```

Session.fromRow / Session.toRow 需映射这两列。

**C. task.ts — 传递参数到 Session.create**

`packages/opencode/src/tool/task.ts:158-162`:

```ts
return await Session.create({
  parentID: ctx.sessionID,
  title: params.description + ` (@${agent.name} subagent)`,
  permission: finalPermission,
  maxSteps: params.max_steps, // 新增
  timeoutSeconds: params.timeout_seconds, // 新增
})
```

**D. prompt.ts — 使用 session.maxSteps**

`packages/opencode/src/session/prompt.ts:581`:

```ts
// 旧:
const maxSteps = agent.steps ?? Infinity

// 新:
const maxSteps = session.maxSteps ?? agent.steps ?? Infinity
```

优先级：task dispatch (session.maxSteps) > agent 定义 (agent.steps) > 无限制 (Infinity)。

### 3.3 timeout_seconds 修复

#### 3.3.1 设计

timeout_seconds 需在 prompt loop 的**每一步**中检查。每步包含一个 LLM API 调用（可能耗时数分钟），需要：

1. 记录 session 开始时间
2. 每步开始前检查: `elapsed > timeoutSeconds → 截断`
3. 截断方式: 注入 TIMEOUT 提醒（类似 MAX_STEPS），强制模型输出文本摘要后终止

#### 3.3.2 提醒内容

新建 `packages/opencode/src/session/prompt/timeout.txt`:

```
CRITICAL - SESSION TIMEOUT REACHED

The maximum allowed time for this session has been reached. Tools are disabled. Respond with text only.

STRICT REQUIREMENTS:
1. Do NOT make any tool calls
2. MUST provide a text response summarizing work done so far
3. This constraint overrides ALL other instructions

Response must include:
- Statement that session timeout was reached
- Summary of what has been accomplished so far
- List of any remaining tasks that were not completed
- Recommendations for what should be done next

Any attempt to use tools is a critical violation. Respond with text ONLY.
```

#### 3.3.3 prompt.ts 修改

在 prompt loop 的每步开始前增加超时检查：

```ts
// 在 step loop 开始处
const sessionStart = session.time.created
const elapsed = (Date.now() - sessionStart) / 1000
const isTimedOut = session.timeoutSeconds && elapsed >= session.timeoutSeconds

const isLastStep = step >= maxSteps || isTimedOut
```

当 `isLastStep` 为 true 时，现有的 MAX_STEPS 提醒注入机制已可处理（注入提醒 → 模型只输出文本 → loop 结束）。

但提醒文本需要区分是步数上限还是超时，修改注入逻辑：

```ts
// 旧:
...(isLastStep
  ? [{ role: "assistant" as const, content: MAX_STEPS }]
  : [])

// 新:
...(isLastStep
  ? [{ role: "assistant" as const, content: isTimedOut ? TIMEOUT : MAX_STEPS }]
  : [])
```

#### 3.3.4 替代方案评估

| 方案                                               | 优点                                            | 缺点                                                           | 选择       |
| -------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------- | ---------- |
| **A: 提醒注入**（本方案）                          | 利用现有 MAX_STEPS 机制，改动最小；模型自然结束 | 模型可能忽略提醒继续调用工具（但 MAX_STEPS 已验证有效）        | ✓          |
| **B: Race 模式**（Promise.race + AbortController） | 硬切断，绝不超时                                | 需要 abort 正在进行的 LLM API 调用；可能丢失部分响应；实现复杂 | ✗          |
| **C: 两层结合**（提醒 + Race）                     | 提醒优先尝试软结束；Race 作为硬兜底             | 实现更复杂；需要两套机制                                       | 未来可考虑 |

选择方案 A 作为初始修复。提醒注入机制与 MAX_STEPS 完全一致，已在生产环境验证有效。Race 模式可作为后续增强。

### 3.4 Discipline.compile — 不修改

`max_steps` 和 `timeout_seconds` 不是权限语义（allow/deny/ask），不应由 Discipline.compile 处理。保持现状——Schema 定义保留（用于 task 工具参数验证），compile 不处理它们。

这两个参数通过 Session 元数据（而非 Permission 规则）传递给 runtime，职责更清晰：

- Discipline.compile: 权限规则（permission_override, env_scope, file_scope, delegation_depth）
- Session 元数据: runtime 限制（maxSteps, timeoutSeconds）

### 3.5 Session Recovery

Session recovery 需恢复 runtime 限制。由于 `maxSteps` 和 `timeoutSeconds` 持久化到 DB，recovery 时自然可用：

```ts
// recovery 代码已有:
const session = await Session.get(sessionID)
// session.maxSteps 和 session.timeoutSeconds 自动从 DB 恢复
```

无需额外修改。

### 3.6 非任务来源的 Session

`Session.create` 的调用者不止 task 工具（还有 cron、mobile、server 等）。这些调用者不传 `maxSteps`/`timeoutSeconds`，字段为 `undefined`，prompt.ts 优先级链 `session.maxSteps ?? agent.steps ?? Infinity` 会 fallback 到 agent 定义或 Infinity。不影响现有行为。

---

## 4. 文件改动清单

| 文件                                                 | 操作     | 核心变更                                                                                |
| ---------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| `packages/opencode/src/session/index.ts`             | **小改** | Session.Info 增加 maxSteps/timeoutSeconds 字段；create 函数签名增加；fromRow/toRow 映射 |
| `packages/opencode/src/**/*.sql.ts` (session schema) | **小改** | session 表增加 max_steps/timeout_seconds 列                                             |
| `packages/opencode/src/tool/task.ts`                 | **小改** | Session.create 调用增加 maxSteps/timeoutSeconds 参数                                    |
| `packages/opencode/src/session/prompt.ts`            | **小改** | maxSteps 来源改为 session.maxSteps ?? agent.steps ?? Infinity；增加 timeout 检查逻辑    |
| `packages/opencode/src/session/prompt/timeout.txt`   | **新建** | 超时提醒文本                                                                            |
| `packages/opencode/migration/`                       | **新建** | DB migration 增加 max_steps/timeout_seconds 列                                          |

核心源文件改动：**6 处**。均为小改或新建，无大改。

---

## 5. 对 Layer 3.3 的影响

### 5.1 research.md dispatch 模板

修复完成后，research.md 的 task() dispatch 模板**应补充** `max_steps` 和 `timeout_seconds` 参数，与文档 Section 6.4 规格一致：

| dispatch 类型                          | max_steps | timeout_seconds | 原因                                                |
| -------------------------------------- | --------- | --------------- | --------------------------------------------------- |
| Phase 1-3 (analysis/landscape/framing) | 25        | 300             | skill 加载 + research-explorer dispatch，需充足步数 |
| execution_cycle                        | 20        | 300             | sandbox-executor dispatch + 结果评估                |
| verification                           | 15        | 240             | verifier dispatch + 结果评估，流程较简单            |
| retry (cycle 2-3)                      | 20        | 300             | 同 cycle 1                                          |

### 5.2 research-worker.md

修复完成后，research-worker.md frontmatter **可补充** `steps` 字段作为默认上限（当 coordinator 未指定 max_steps 时生效）：

```yaml
steps: 30 # 默认上限，task dispatch 的 max_steps 优先级更高
```

但 Layer 3.3 设计中 coordinator 总是通过 task dispatch 指定 max_steps，所以 `steps` 字段主要是防御性兜底。

### 5.3 其他 subagent 定义

建议为所有长期运行的 subagent 在 frontmatter 中增加 `steps` 作为默认上限：

| subagent          | 建议 steps | 原因                   |
| ----------------- | ---------- | ---------------------- |
| research-explorer | 30         | 搜索 + 汇总可能多步    |
| sandbox-executor  | 20         | Docker 执行 + 结果收集 |
| gpd-verifier      | 25         | SymPy 计算 + 多轮检查  |
| research-verifier | 20         | 验证 + 报告            |
| explore           | 15         | 快速搜索任务           |
| general           | 15         | 轻量通用任务           |

### 5.4 DIGESTS.md 追加无需修改

DIGESTS.md 的追加逻辑由 coordinator 控制（edit 工具或 write fallback），不受步数/超时影响。

---

## 6. 验收清单

### 6.1 max_steps 执行

1. task dispatch 指定 max_steps=20 → subagent session 在第 20 步触发 MAX_STEPS 提醒 → 模型输出文本摘要 → loop 结束
2. task dispatch 不指定 max_steps → subagent 使用 agent.steps（若定义）→ 若也未定义则 Infinity
3. 优先级正确: session.maxSteps > agent.steps > Infinity
4. Session.create 接收 maxSteps 参数并持久化到 DB
5. Session recovery 恢复 maxSteps 值

### 6.2 timeout_seconds 执行

6. task dispatch 指定 timeout_seconds=300 → subagent session 在 300 秒后触发 TIMEOUT 提醒 → 模型输出文本摘要 → loop 结束
7. task dispatch 不指定 timeout_seconds → 无超时限制（行为不变）
8. 超时提醒内容包含工作摘要和剩余任务
9. 超时检查基于 session.time.created（DB 持久化的开始时间），不依赖进程内存

### 6.3 优先级与兼容性

10. session.maxSteps 优先级高于 agent.steps（task dispatch > agent 定义）
11. 非 task 来源的 Session.create（cron/mobile/server）不受影响——maxSteps/timeoutSeconds 为 undefined → fallback 到 agent.steps/Infinity
12. Discipline.compile 不变——不处理 max_steps/timeout_seconds（保持权限职责边界）
13. DB migration 可回滚——增加的两列均有 default null

### 6.4 对现有功能的影响

14. Path 1/2 不受影响（coordinator 直接调用 skill，不 dispatch worker）
15. 非研究类 subagent（explore/general）不受影响——除非 dispatcher 传了 max_steps/timeout_seconds
16. MAX_STEPS 提醒机制不变（仅触发条件更准确）
17. Session recovery 不遗漏 runtime 限制信息

### 6.5 research.md 补充参数

18. research.md 所有 task() dispatch 模板包含 max_steps 和 timeout_seconds（与 Layer 3.3 Section 6.4 一致）
19. research-worker.md frontmatter 包含 steps 字段作为防御性兜底
