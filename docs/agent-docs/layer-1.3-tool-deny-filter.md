# Layer 1.3: 工具 deny 过滤与 upstream 对齐 —— 复用 `Permission.disabled` + 引入 `approved`

> 前置依赖: Layer 0（`Permission` Service、`evaluate`/`disabled`/`ask`）、Layer 1（`resolveTools` 组装期 deny 过滤——本次重构对象）
> 本文档重构 `resolveTools` 末尾的"组装期 deny 过滤"：**保留**受限子 agent 的干净工具面（被 deny 的工具不进 LLM 工具列表），但**消除与 upstream 分歧的"第二套 evaluate"**——改用 upstream 自带的 `Permission.disabled` helper，并喂入与执行期 `Permission.ask` **相同**的有效 ruleset（含运行期 `approved`）。完成后：除"agent 只见未被 deny 的工具"这一项有意保留的差异外，工具权限的求值逻辑与 upstream 完全一致，单一真值、无漂移。

---

## 上下文

| Layer         | 状态       | 简介                                                                                        |
| ------------- | ---------- | ------------------------------------------------------------------------------------------- |
| Layer 0       | 已完成     | `Permission` Service（`ask`/`reply`/`list`）、`evaluate`（findLast 后匹配胜出）、`disabled` |
| Layer 1       | 已完成     | `resolveTools` 末尾组装期 deny 过滤（`prompt.ts:1005-1010`）                                |
| **Layer 1.3** | **本文档** | 组装期过滤改用 `disabled` + `approved`，与 upstream 对齐                                    |

---

## 1. 问题分析

### 1.1 当前是"双 evaluate"且 ruleset 不一致

工具权限现有两条求值路径：

- **组装期**（`prompt.ts:1005-1010`，本分支新增）：对每个 tool 调 `Permission.evaluate(permKey, "*", Permission.merge(agent.permission, session.permission ?? []))`，`action === "deny"` 则从 `tools` 删除。**ruleset 不含 `approved`**。
- **执行期**（`prompt.ts:813-820` 的 `ctx.ask` → `Permission.ask`）：内部 `evaluate(request.permission, pattern, ruleset, approved)`（`permission/index.ts` ask 函数）。**ruleset 含 `approved`**。

`evaluate.ts` 语义为 `findLast` → **后匹配规则胜出**，`approved` 拼在最后 → **approved 的 allow 能覆盖静态 deny**。于是两条路径用的有效 ruleset 不同。

### 1.2 分歧导致的过度删除 bug

若某工具在静态 ruleset（agent+session）里是 `deny`，但用户此前对该工具点过 "always allow"（`approved` 里有 allow）：

- 执行期：`evaluate(perm, "*", base, approved)` → approved 的 allow 胜出 → **放行**
- 组装期：`evaluate(perm, "*", base)`（无 approved）→ deny → **从列表删除**

结果：用户此前的 always 批准被**静默忽略**，工具不可见。发生条件是"规则从 `ask`（被批准过）变为 `deny`（配置重载后）"——罕见但**可达**，非纯理论。这是当前实现独有的缺陷，upstream（仅执行期一路）不存在。

### 1.3 "第二套 evaluate"还复刻了 `disabled` 的逻辑

`Permission.disabled(tools, ruleset)`（`permission/index.ts:324-333`）是 upstream **既有的**"哪些工具被禁用"helper：

```ts
export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  const result = new Set<string>()
  for (const tool of tools) {
    const permission = EDIT_TOOLS.includes(tool) ? "edit" : tool
    const rule = ruleset.findLast((rule) => Wildcard.match(permission, rule.permission))
    if (!rule) continue
    if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
  }
  return result
}
```

它已封装：① `EDIT_TOOLS` → `edit` 权限映射 ② `findLast` ③ 只在"最后匹配规则是 `*: deny`"时判定禁用。组装期过滤（`prompt.ts:1005-1010`）用 `evaluate(permKey, "*")` **重新实现**了同一意图，属重复逻辑。

### 1.4 粒度差异：`evaluate(perm,"*")` 存在过度隐藏

`Wildcard.match(str, pattern)` 第一参为字符串、第二参为通配模式（`wildcard.ts:4`）。`evaluate(perm, "*")` 中 `Wildcard.match("*", rule.pattern)` 仅当 `rule.pattern === "*"`（或 `?`）时为真——即它只考虑 `pattern==="*"` 的规则，返回最后一条 `*` 规则。

与 `disabled` 的 `findLast(任意 pattern) → 再查 pattern==="*"` 相比，两者在常见配置下一致，但在"`*: deny` + 具体模式 allow"的边罕配置下分歧：

| ruleset                            | `evaluate(perm,"*")` | `disabled` | 正确语义                          |
| ---------------------------------- | -------------------- | ---------- | --------------------------------- |
| `[{bash,*:deny}]`                  | deny → 隐藏          | 隐藏       | 一致（全禁）                      |
| `[{bash,*:deny},{bash,rm*:allow}]` | deny → **隐藏**      | **不隐藏** | 不隐藏 bash（仍存在可用 pattern） |

`disabled` 更稳：仅当最后一条匹配规则是 `*: deny` 才隐藏，不会因存在具体 allow 而误判。组装期改用 `disabled` 同时修正此过度隐藏。

### 1.5 范围边界：不处理具体 pattern 的 deny

`disabled` 仅在"最后一条 permission 匹配规则是 `*: deny`"时隐藏——即只识别**安全边界级**的全量 deny。对"具体 pattern 的 deny"（如 `bash: { "*": "deny", "rm": "deny" }`：`disabled` 见末条 `rm:deny` 非 `*` → 不隐藏，但执行期对任意 pattern 仍 deny），组装期**不予隐藏**——工具会被列出、调用即被 `DeniedError` 拒。

此不在本任务范围内。理由：逐 pattern 的 deny 是 hard-code 式的细粒度控制，与"agent 应保有自由度、仅在安全边界设限"的风格相悖；把这类边罕配置塞进组装期判定会让过滤逻辑趋近于复刻执行期求值，重回 §1.3 的重复路径。

> 后续（**非本任务**）：应重新设计 agent 对具体工具/pattern 的 deny 表达方式，使"安全边界"与"自由度"在配置层就分离，而非在组装期用启发式判定补齐。

---

## 2. 当前实现追踪

- 组装期过滤：`packages/opencode/src/session/prompt.ts:1005-1010`
- `ctx.ask`（执行期入口，传 `ruleset = merge(agent, session)`）：`prompt.ts:813-820`
- `Permission.ask` Effect（内部 `evaluate(perm, pattern, ruleset, approved)`）：`permission/index.ts`（layer 内）
- `Permission.ask` 导出 wrapper：`permission/index.ts:337-339`
- `Permission.disabled`：`permission/index.ts:324-333`
- `Permission.evaluate`：`permission/evaluate.ts:9-14`（`findLast`，无匹配默认 `ask`）
- `approved` 状态：`Permission` layer 内 `InstanceState` 的 `state.approved`（`reply` 处理 "always" 时追加 allow 规则）

---

## 3. 修复方案：复用 `disabled` + 暴露 `approved`

### 设计哲学：单一真值

- **"可见性"判据唯一**：组装期不再调 `evaluate`，改调 upstream 自带的 `Permission.disabled`。组装期要回答的是"这工具**无论模型怎么调用都会被拒**吗"（即全量拒绝/blanket-denied）——而 `disabled` 的判据"最后一条 permission 匹配规则是 `*:deny`"恰好刻画这个语义，且它已封装 `EDIT_TOOLS` 映射与 `findLast`，不需要重写。"全量拒绝"只有 `disabled` 一处定义。
- **ruleset 同源同序**：组装期喂给 `disabled` 的 ruleset 与 `ask` 内部用的**结构同源同序**——均为 `merge(base, approved)`（`base = merge(agent, session)`、`approved` 为运行期累计的 "always allow" 规则）；`evaluate` 的 `rulesets.flat()` 与 `merge` 的 `flat()` 产出同一数组、同序。注意"同序"指**结构**（规则排列顺序一致），非指两路径在同一时刻内容恒等——组装期取的是快照，执行期 `ask` 用的是调用时刻的 approved，二者内容可能因 approved 增长而不同，由下文"时机安全性"收敛为一致。这保证组装期与执行期的有效权限求值同源，消除 §1.2 的 approved 不一致。
- **二者求值并不等价**（`disabled` 不是 `evaluate` 的语法糖）：`evaluate` 是**双侧** findLast——搜索阶段同时要求 `match(permission, rule.permission)` **且** `match(pattern, rule.pattern)`，pattern 参数化（每次调用取真实命令/pattern）；`disabled` 是**单侧** findLast——搜索阶段只看 `match(permission, rule.permission)`，pattern 不参与搜索，只在命中那条上**事后**检查 `pattern === "*"`，且 pattern 无关。§1.4 已用 `[{bash,*:deny},{bash,rm*:allow}]` 证明二者结果相反（`evaluate` 隐藏、`disabled` 不隐藏）。
- **正确关系：单向可靠近似**。成立的方向是——`disabled` 隐藏工具 T ⟹ 执行期 `evaluate(T, p, ·)` 对**任意** pattern p 均 deny（证明：`{T,*:deny}` 是单侧最后一条，故对双侧任意 p 它必入选且其后再无匹配 T 的规则，双侧最后胜出也是它）。反向不成立——如 `[{bash,*:deny},{bash,rm:deny}]` 执行期对任意 p 均 deny，但 `disabled` 见末条非 `*` → 不隐藏（§1.5）。故 `disabled` 是"全量拒绝"的**欠近似**：保证不误隐藏（修 §1.4），但刻意不覆盖具体 pattern deny（§1.5）。这正是"安全边界级"过滤应有的保守性，也正是组装期该用 `disabled` 而非 `evaluate` 的根因——组装期没有具体调用 pattern，`evaluate("…","*")` 的 `"*"` 是伪造值，会把"`*` 不匹配具体 allow pattern"误判为"该规则不适用"，从而漏掉靠后的 allow、过度隐藏。
- **有意保留的唯一差异**：组装期多调一次 `disabled` 来**隐藏**被 deny 的工具（upstream 不调，仅靠执行期 `ask` 抛 `DeniedError`）。这正是"agent 只见未被 deny 的工具"。

### 时机安全性

`approved` 按构造**只含 allow 规则**（`reply` 在 `index.ts:236-240` 硬编码 `action: "allow"` 追加），且只增不减。组装期快照由 `Permission.merge(base, approved)` 的 `flat()` 物化为一新数组、`approved()` 亦返回拷贝，故组装后 `approved` 的后续增长不影响已喂给 `disabled` 的 ruleset：

- 被判 deny 而隐藏的工具 → 模型无法调用 → 不会触发 `ask` → `approved` 不会为本工具新增 allow → 执行期仍 deny，一致。
- 被判 allow/ask 而保留的工具 → 模型调用 → `ask` 用**更新后**的 `approved` 重新求值；`approved` 只增 allow，不会把 allow/ask 变成 deny，一致。

故快照与执行期不会出现"隐藏了却本该放行"的可观察分歧（§1.2 的 bug 由此消除）。

---

## 4. 改动清单（2 文件）

### 改动 1: `Permission` 暴露 `approved`

文件：`packages/opencode/src/permission/index.ts`

(a) `Interface` 增加 `approved` getter（与 `ask`/`reply`/`list` 并列）：

```ts
export interface Interface {
  readonly ask: (input: z.infer<typeof AskInput>) => Effect.Effect<void, Error>
  readonly reply: (input: z.infer<typeof ReplyInput>) => Effect.Effect<void>
  readonly list: () => Effect.Effect<Request[]>
  readonly approved: () => Effect.Effect<Ruleset>
}
```

(b) layer 内实现（读取 `InstanceState` 的 `approved`，返回**拷贝**以避免调用方修改内部 state——`reply` 在 `index.ts:236-240` 会在原数组上 `push`）：

```ts
const approved = Effect.fn("Permission.approved")(function* () {
  return [...(yield* InstanceState.get(state)).approved]
})
```

`return Service.of({ ask, reply, list, approved })`（契约：返回值为只读快照，调用方不得修改）

(c) 导出 async wrapper（与 `ask`/`reply`/`list` 同模式，`permission/index.ts:337-347` 一带）：

```ts
export async function approved(): Promise<Ruleset> {
  return runPromise((s) => s.approved())
}
```

### 改动 2: `resolveTools` 组装期过滤改用 `disabled` + `approved`

文件：`packages/opencode/src/session/prompt.ts`

删除 `prompt.ts:1005-1010` 的内联循环：

```ts
// 删除：
const effectivePermission = Permission.merge(input.agent.permission, input.session.permission ?? [])
for (const key of Object.keys(tools)) {
  const permKey = Permission.EDIT_TOOLS.includes(key) ? "edit" : key
  const rule = Permission.evaluate(permKey, "*", effectivePermission)
  if (rule.action === "deny") delete tools[key]
}
```

替换为：

```ts
const base = Permission.merge(input.agent.permission, input.session.permission ?? [])
const approved = await Permission.approved()
for (const tool of Permission.disabled(Object.keys(tools), Permission.merge(base, approved))) {
  delete tools[tool]
}
```

要点：

- 复用 `Permission.disabled`（封装 `EDIT_TOOLS` 映射 + `findLast` + `pattern==="*"` 粒度），不再重复 `evaluate` 逻辑。
- `Permission.merge(base, approved)` 与 `ask` 内部 `evaluate(perm, pattern, base, approved)` 同源同序，消除 §1.2 分歧。
- 无需改动 import：`prompt.ts:45` 为 `import { Permission }` 单命名空间导入，仍被 `.merge`/`.ask`/`.disabled`/`.approved` 使用。`Permission.evaluate` 在 `prompt.ts:1408`（task 权限判定）仍有使用，**不删**；仅 `Permission.EDIT_TOOLS`（本处 1007 独占）随删除自然不再被 `prompt.ts` 引用，但它是 `Permission` 命名空间成员（`disabled` 内部消费），无 import 可清。

### 不改的东西

- `ctx.ask`（`prompt.ts:813-820`）——执行期强制原样保留，与 upstream 一致。
- `Permission.ask` / `reply` / `evaluate` / `disabled` 的实现——只新增 `approved` getter，不改既有逻辑。
- MCP 工具、session 工具、`ToolRegistry.tools` 的组装顺序与过滤——不动。
- `EDIT_TOOLS` 常量位置（仍在 `permission/index.ts`，`disabled` 内部消费）。

---

## 5. 设计决策属性

本节陈述已选定方案的**设计性质**（非备选比较）。实施方案即 §4，本节回答"该方案满足哪些约束、为何这样定形"。

### 5.1 组装期判据用 `disabled`，不用 `evaluate`

组装期没有具体调用 pattern，能回答的问题只有"工具是否**全量拒绝**"（无论模型怎么调用都会被拒）。`disabled` 的判据"最后一条 permission 匹配规则是 `*:deny`"正好刻画该语义，且已封装 `EDIT_TOOLS` 映射与 `findLast`，复用即得。`evaluate` 是 pattern 参数化的双侧求值，组装期只能喂入伪造的 `"*"`，会把"`*` 不匹配具体 allow pattern"误判为"该规则不适用"，漏掉靠后的 allow、过度隐藏（§1.4）。故判据落在 `disabled` 一处。

### 5.2 `disabled` 保持纯函数，`approved` 由调用方显式传入

`disabled` 维持纯函数签名 `(tools, ruleset): Set<string>`，不内取 `approved`：

1. 它被 `SystemPrompt.skills`（`session/system.ts:56`）、`session/llm.ts:378`、`cli/cmd/debug/agent.ts:78` 同步调用，纯函数形态已确立，不改动这些调用点。
2. 显式传 `merge(base, approved)` 让"有效 ruleset 的组成"在调用处可见、可测，不隐藏运行期状态依赖。
3. `disabled` 保持纯函数便于单测（给定 ruleset 即可断言）；运行期状态由 `approved` getter（已是 Effect）单独承载。

### 5.3 保留组装期过滤

组装期隐藏是受限子 agent（`*:deny` + 少量 allow）体验的关键：避免工具列表臃肿、token 浪费、"被拒一轮才学会不用"。该隐藏用 upstream 自家 `disabled` 实现，不引入新语义；与执行期 `ask` 共享同一份 `merge(base, approved)`，故组装期"隐藏全量拒绝工具"与执行期"拒绝具体调用"两条路径不冲突。

### 5.4 `approved` 暴露的安全性

`approved` 是用户授权决策的累计，本就是有效权限的一部分（`ask` 已用它求值）。暴露只读快照不改变权限边界，只是让组装期与执行期看到同一份。`approved` getter 返回拷贝（`[...approved]`），调用方修改之不影响内部 state。不涉及新权限授予。

### 5.5 新增表面的最小性

`approved` getter 是本次**唯一**新增的 upstream-facing 公共 API：改动 2 复用既有 `disabled`，无新表面；改动 1 只新增 `approved`，不动 `ask`/`reply`/`list`/`evaluate`/`disabled` 既有签名与实现。无更轻替代：

- 既有 `list()` 返回 pending 请求队列，不返回 approved ruleset，无法替代。
- 让 `disabled` 自取 approved 会破坏其纯函数签名（§5.2），且牵连 `system.ts:56`/`llm.ts:378`/`debug/agent.ts:78` 三个既有同步调用点。
- `approved` 只活在 `InstanceState` 内部 state，组装期位于 `session/prompt.ts` 外部，唯一可达路径是 Service 接口。

取舍：§1.4（粒度过度隐藏）单独修可**零新 API**（组装期改 `disabled(tools, base)` 即可）；§1.2（approved 不一致）的修复**必须**读 approved，无法绕过暴露该 getter。本设计选择同时修两者，故接受 `approved` getter 作为最小必要代价——它是只读、返回拷贝、不授予新权限（§5.4）的窄表面。

---

## 6. 影响面核对

| 场景                                                     | 预期                                       | 依据                             |
| -------------------------------------------------------- | ------------------------------------------ | -------------------------------- |
| primary agent（宽 allow）组装                            | 几乎不删工具，行为无感                     | `disabled` 多数返回空集          |
| research 子 agent（`*: deny` + allow）组装               | 仅保留 allow 的工具，deny 的隐藏           | `disabled` 判 `*: deny`          |
| 静态 deny 工具，用户曾 always allow                      | **不再被隐藏**（与执行期一致放行）         | `merge(base, approved)` 含 allow |
| 静态 deny 工具，无 approved                              | 隐藏；模型不调用；执行期也 deny            | 一致                             |
| `*: deny` + 具体模式 allow 的工具                        | **不隐藏**（具体模式可用）                 | `disabled` 粒度修正（§1.4）      |
| 执行期 `ctx.ask`                                         | 不变，DeniedError 仍生效                   | `ctx.ask` 未改                   |
| `SystemPrompt.skills` / `llm.ts` / debug 等用 `disabled` | 不变（仍用纯函数 `disabled`，无 approved） | 未改 `disabled` 签名             |
| `bun typecheck`                                          | 通过                                       | 新增 `approved` 类型完整         |

---

## 7. 验收清单

1. `prompt.ts` 组装期不再出现 `Permission.evaluate(` 调用（改用 `Permission.disabled`）
2. `prompt.ts` 组装期 ruleset 含 `approved`（`Permission.merge(base, approved)`）
3. `permission/index.ts` 新增 `approved` Interface 成员 + 实现 + 导出 wrapper
4. 静态 deny 工具（无 approved）仍被隐藏
5. 静态 deny + approved allow 的工具**不再被隐藏**（§1.2 bug 修复）
6. `*: deny` + 具体模式 allow 的工具不被隐藏（§1.4 过度隐藏修复）
7. 执行期 `ctx.ask` 行为不变（DeniedError 仍抛出）
8. `bun typecheck` 在 `packages/opencode` 通过

---

## 8. 测试策略

### 8.1 现有测试更新

| 测试文件                                   | 改动                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/layer-1/denied-tools.test.ts`        | **工具可见性**断言对齐 `disabled` 语义；**pattern 级执行期**断言（如 `evaluate("bash","uv run …")`、`evaluate("bash","rm -rf /")`）保留在 `evaluate`（`disabled` 不看具体 pattern，无法替代）；新增"`*: deny` + 具体模式 allow 不隐藏"用例；describe 标题 `"...via Permission.evaluate"` 更新为反映组装期走 `disabled` |
| `test/layer-0/permission-intersection*.ts` | 不受影响（`intersection` 未改）                                                                                                                                                                                                                                                                                        |

### 8.2 新增测试点

- **approved 一致性（验收 #5，已实现）**：`denied-tools.test.ts` 新增用例——`base = fromConfig({"*":"allow", bash:"deny"})`、`approved = fromConfig({bash:"allow"})`，断言 `disabled(["bash"], base).has("bash")` 为 true、`disabled(["bash"], merge(base, approved)).has("bash")` 为 false。覆盖 §1.2 bug 修复的纯函数语义（组装期与执行期同源 ruleset 下的可见性）。
- **approved 快照时机（待集成 harness）**：组装后向 `approved` 追加 allow，断言已隐藏的工具不变（快照已取）、保留的工具执行期重新求值放行。需 prompt 组装期集成 harness（导入 `prompt.ts`、驱动 `resolveTools`）；现有 `denied-tools.test.ts` 不导入 `prompt.ts`，不覆盖组装流程。
- **粒度（验收 #6，已实现）**：`denied-tools.test.ts` 用例——`base = fromConfig({ bash: { "*": "deny", "rm*": "allow" } })`，断言 `disabled(["bash"], base)` 返回空集（不隐藏 bash）。
- **`Permission.approved()` getter（已实现）**：`test/permission/next.test.ts` 用例——通过 `tmpdir` + `Instance.provide` 起真实实例（不 mock，符合 AGENTS.md "Avoid mocks"），`ask`+`reply("always")` 累计一条 allow 后断言 `approved()` 返回内容等于该 ruleset；再向返回值 `push` 一条规则、重新取，断言内部 state 不变（拷贝语义）。

### 8.3 手动验证

1. 配置某子 agent `*: deny` + `bash: allow`，确认其工具列表只含 bash 等允许项
2. 对某 ask 工具点 "always allow"，重载配置将其改为 deny，重启后确认该工具仍可见（approved 覆盖）
3. `bun typecheck` 通过
