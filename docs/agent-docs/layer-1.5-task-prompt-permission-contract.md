# Layer 1.5: task.ts↔prompt.ts tools/permission 契约固化 —— 单轨注释 + intersection 裁决

> 前置依赖: Layer 0（`Permission.merge`/`intersection`）、Layer 1（`resolveTools` deny-filter）、Layer 1.4（已实施：去除 Discipline 第三参 `disciplineRules`，`intersection` 收敛为 2-arg）、Layer 1.3（deny-filter 与 upstream 对齐）。Layer 1.4 曾将 `Permission.intersection` 去留移交本层裁决——本层决定**保留** `intersection`（见 §5.5）
> 本文档固化 `task.ts`↔`prompt.ts` 之间"子会话权限如何传递"的隐性契约，含两项明确实施：① 在 `task.ts` 注释固化"单轨、不传 `tools`、`session.permission` 为权威"的方向（§3）；② 保留 `Permission.intersection` 作为"子 agent 权限 ≤ 父 caller"的权限收紧（caller→child 政策，非安全必需），注明为有意偏离 upstream（§5.5）。`prompt.ts` 的 `tools` 轨覆盖语义**保留**，其"混用会冲掉丰富权限"的特性作为已知限制靠 `task.ts` 单轨规避（§1.2）。完成后：`task.ts` 单轨契约显式化，对 `upstream/dev` 零逻辑侵入（仅注释），`intersection` 决策固化。

---

## 上下文

| Layer         | 状态             | 简介                                                            |
| ------------- | ---------------- | --------------------------------------------------------------- |
| Layer 0       | 已完成           | `Permission.merge`/`intersection`、`Discipline.compile`         |
| Layer 1       | 已完成           | `resolveTools` 组装期 deny-filter（`prompt.ts:1005-1009`）      |
| Layer 1.4     | 已实施（未提交） | 去除 Discipline 第三参，`intersection` 收敛为 2-arg，与本层正交 |
| Layer 1.3     | 已完成           | deny-filter 复用 `disabled` + `approved`，与 upstream 对齐      |
| **Layer 1.5** | **本文档**       | `task.ts` 单轨契约注释固化 + `intersection` 去留裁决            |

---

## 1. 问题分析

### 1.1 双轨/单轨现状

子会话权限经两条可能的路径进入 `session.permission`：

- **`Session.create({ permission })` 轨**（`task.ts`）：在创建会话时直接写入 `session.permission`。当前分支在此写入丰富的 `finalPermission`（`intersection(parent, child)` + `task/todowrite` deny + `primary_tools` deny）。
- **`tools` 轨**（`prompt.ts:181-192`）：调用 `prompt({ tools: {x: bool} })` 时，`prompt` 把 `tools` 转成 `[{permission, pattern:"*", action: allow/deny}]` 规则，**覆盖** `session.permission`。

upstream `task.ts` 用**双轨**：① `Session.create` 写入（含 `primary_tools: allow` 的 bug），② `prompt` 传 `tools:{...false}` → ② 覆盖 ①。① 实为死代码（永被覆盖），且已与 ② 分歧（`allow` vs `false`）。

当前分支 `task.ts` 用**单轨**：① `Session.create` 写 `finalPermission`（已修正 `primary_tools: deny`），② `promptWithFallback` **不传 `tools`** → `prompt.ts:189` 的 `if (permissions.length > 0)` 不触发 → `session.permission` 保持 `finalPermission`。

### 1.2 覆盖语义与已知限制

`prompt.ts:190` 是 `session.permission = permissions`（**覆盖**）。`tools` 轨只能表达 tool 级 on/off（`{x: bool}`），无法表达 `intersection`/pattern-scoped 权限。由此产生一个已知限制：**若某调用方既设丰富 `session.permission` 又传 `tools`，丰富部分（intersection 结果）会被静默冲掉。**

本设计对此的处理：**保留覆盖语义**（`prompt.ts:181-192` 不改），靠 `task.ts` 单轨规避——`task.ts` 是唯一设丰富 `finalPermission` 的调用方，经 `promptWithFallback` 结构性不传 `tools`（`task.ts:31-38` 入参无 `tools` 字段），即不触发覆盖。覆盖语义保留的 upstream 依据见 §5.1。

`tools` 轨现有调用方（不能删该轨，故该限制无法靠"删 tools"消除，只能靠单轨规避）：

- `github.ts:996`（`{"*":false}`）——**已知限制的良性触发实例**：`github.ts:548-555` 在 `Session.create` 写入 `[{question,*,deny}]`，`:996` 的 `tools:{"*":false}` 将其覆盖为 `[{*:deny}]`；因 `{*:deny}` 更严且该 summary 为会话最后一步，净效果无害。即 `github.ts` 既是 `tools` 轨合法用户，也同时是已知限制的（良性）受害者。
- `review-agent.ts:410`（`{"*":false,skill_manage:true,read:true}`）——会话 base 空，覆盖即写入 tools 规则，无丰富权限被冲。
- `compaction-flow.test.ts:436`（`{todowrite:true}`）——同上，base 空。

各调用方在覆盖下的具体行为见 §6。

### 1.3 upstream 已宣告 `tools` 为 legacy

`PromptInput.tools`（`prompt.ts:106-111`）标注 `@deprecated`："tools and permissions have been merged, you can set permissions on the session itself now"。即 upstream 自己定的方向是 `session.permission`，`tools` 是 legacy 叠加层。当前 `task.ts` 单轨正是采纳该方向（超前于 upstream 自己尚未迁移的 `task.ts`）。

### 1.4 本层范围

- **已修（当前分支）**：upstream `task.ts` 的 `primary_tools: allow` bug → 当前 `finalPermission` 已改为 `deny`（`task.ts:132-136`）。
- **本层实施（注释）**：`task.ts` 单轨契约注释固化（§3）。
- **已知限制（保留覆盖语义）**：`prompt.ts:190` 覆盖特性——靠 `task.ts` 单轨规避（§1.2）。
- **本层裁决**：`Permission.intersection` 去留（Layer 1.4 §5.1/§5.2/§9 移交）——**保留**（§5.5）。

---

## 2. 当前实现追踪

> 行号基于 Layer 1.4 后的工作区状态。代码库仍在活跃重构，行号可能漂移——实施时以 §9 的 grep 锚点为准。

- `tools`→permission 转换 + 覆盖：`packages/opencode/src/session/prompt.ts:181-192`（本层保留覆盖语义；下方代码块为可读性重排并加行内注释，源文件多行写法见 `prompt.ts:181-192`，upstream 字节一致性见 §5.1）
  ```ts
  const permissions: Permission.Ruleset = []
  for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
    permissions.push({ permission: tool, action: enabled ? "allow" : "deny", pattern: "*" })
  }
  if (permissions.length > 0) {
    session.permission = permissions // ← 覆盖（保留，已知限制见 §1.2）
    await Session.setPermission({ sessionID: session.id, permission: permissions })
  }
  ```
- `PromptInput.tools` `@deprecated`：`prompt.ts:106-111`
- `task.ts` `finalPermission`：`task.ts:129-137`；`promptWithFallback` 调用（不传 `tools`）：`task.ts:177-187`
- `PromptInput.tools` 轨调用方（`Record<string,boolean>` 权限叠加）：`cli/cmd/github.ts:996`（`{"*":false}`）、`skill-evolution/review-agent.ts:410`（`{"*":false,skill_manage:true,read:true}`）、`test/session/compaction-flow.test.ts:436`（`{todowrite:true}`）
- ⚠️ 易混非调用方：`session/compaction.ts:215` 与 `prompt.ts:2191` 的 `tools:{}` 是 `LLM.StreamInput.tools`（`Record<string,Tool>` 工具字典，见 `llm.ts:78`），**非** `PromptInput.tools`，不经 `prompt.ts:189-192`，不在枚举内
- 不可枚举外部调用方：`server/routes/session.ts:990` 以 `{...body, sessionID}` 透传 HTTP body（经 `PromptInput` 校验），SDK/CLI/HTTP 客户端可传 `tools`
- `Permission.merge`（`permission/index.ts:295-297`）：`rulesets.flat()`——`merge(a, b)` = `[...a, ...b]`
- `evaluate` 语义（`evaluate.ts:11`）：`findLast` 后匹配胜出
- `prompt.ts:181-192` 与 upstream 字节一致（`git diff upstream/dev -- prompt.ts` 证实），本层保留该一致性

---

## 3. 修复方案：单轨注释 + intersection 裁决

### 设计哲学

- **单轨注释**：把 `task.ts` 单轨方向显式化，防止后人回退到双轨。这是单轨契约的**唯一固化手段**——覆盖限制（§1.2）靠 `task.ts` 结构性不传 `tools` 规避，注释标明此意图。
- **intersection 保留**（§5.5）：保留 `Permission.intersection` 作为子≤父权限收紧（caller→child 政策），决策固化（无代码变更）。
- **覆盖语义保留**：`prompt.ts:181-192` 保持与 upstream 字节一致（最小侵入）；覆盖限制靠 `task.ts` 单轨规避（§1.2）。

### `task.ts` 单轨契约注释

`task.ts:177`（`promptWithFallback` 调用前）加注释块：

```ts
// Single-track permission contract: finalPermission is set on the session
// via Session.create above and is the authoritative source. Do NOT pass
// `tools` to prompt here — PromptInput.tools is @deprecated and uses
// overwrite (not merge) semantics in prompt.ts:189-192; passing it would
// silently clobber the intersection-derived finalPermission. task.ts
// intentionally keeps permission on the session so the intersection results
// survive. promptWithFallback structurally omits `tools`, enforcing this
// by construction.
const result = await promptWithFallback({
  sessionID: session.id,
  messageID,
  model: { modelID: model.modelID, providerID: model.providerID },
  agent,
  promptParts,
  fallbackModels: agent.fallbackModels ?? [],
})
```

要点：注释说明"为何不传 `tools`"（覆盖会冲掉 `finalPermission`，指向 §1.2 已知限制）+ 指向 `@deprecated` + 指出 `promptWithFallback` 已结构性省略 `tools`（构造级强制）。注释把覆盖限制作为**不传 tools 的理由**固化——既是方向护栏，也是已知限制的文档化锚点。

---

## 4. 改动清单（1 文件，纯注释）

### 改动 1: `task.ts` 单轨契约注释

文件：`packages/opencode/src/tool/task.ts`

`task.ts:177` 前加注释块（见 §3）。纯注释，零逻辑变更。

### 不改的东西

- `prompt.ts:189-192` 覆盖语义保留（与 upstream 字节一致，依据见 §5.1）——覆盖限制靠 `task.ts` 单轨规避
- `PromptInput.tools` schema 及 `@deprecated` 标注（保留 legacy API）
- `tools`→permission 转换逻辑（`prompt.ts:182-188`，仍把 `tools` 转成 `pattern:"*"` 规则，覆盖赋值）
- `task.ts` 的 `finalPermission` 构成逻辑（`intersection` 调用保留不变，见 §5.5；Discipline 第三参删除属 Layer 1.4；`sessionDenyRules`/`primary_tools` 不动）
- `github.ts`/`review-agent.ts` 等调用方（覆盖语义保留，行为不变，无需改）
- `resolveTools` deny-filter（属 Layer 1.3）
- `Session.create` / `Session.setPermission` 接口
- `Permission.intersection` 函数本身（决策固化，无代码变更，§5.5）

---

## 5. 设计决策与权衡

### 5.1 覆盖语义保留的依据

覆盖语义（`prompt.ts:181-192`，`session.permission = permissions`）保留的增量依据：**该块与 upstream 字节一致**（`git diff upstream/dev -- prompt.ts` 证实），保留即保持该块零偏离，符合"对 upstream 最小侵入"约束。

已知限制（丰富权限被冲掉）的分析与 `task.ts` 单轨规避方式见 §1.2；各调用方在覆盖下的行为见 §6——此处不重复。

### 5.2 为何不删 `tools` 轨

`tools` 轨仍被 `github.ts`/`review-agent.ts` 等多处使用（§2），且 `PromptInput` 是公开 API（SDK/CLI/移动端可能传 `tools`）。删除会波及面过大、破坏兼容。`@deprecated` 标注 + 保留覆盖语义是渐进迁移的正路：保留 API、不动语义、等调用方逐步迁到 `session.permission` 后再删。

### 5.3 单轨注释作为唯一防护

覆盖语义保留后（§5.1），`task.ts` 单轨（§1.2）成为"`finalPermission` 不被冲掉"的唯一保障。§3 注释把这一意图写进代码，防止后人回退到双轨——那会触发覆盖限制（§1.2）、冲掉 `intersection` 结果。无运行时网，注释 + `promptWithFallback` 结构性省略 `tools`（`task.ts:31-38` 入参无 `tools` 字段）是双层软防护。

### 5.4 契约固化方式（不引入运行时断言）

契约靠 §3 注释 + `promptWithFallback` 结构性省略 `tools` 固化，不引入运行时断言。理由有二：

1. **github.ts 会误报**：`github.ts:548-555` 在 `Session.create` 写入 `[{question,*,deny}]`，随后 `:996` 传 `tools:{"*":false}`——这是已知限制（§1.2）的一个**良性触发**（`question:deny` 被覆盖为 `[{*:deny}]`，因更严且为末步，无害）。运行时 warn 会在此误报为"丰富权限被冲掉"。
2. **最小侵入**：在 `prompt.ts:181-192`（与 upstream 字节一致，§5.1）加断言本身即引入 upstream 偏离，违背最小侵入约束。

### 5.5 为何保留 `Permission.intersection`（有意偏离 upstream）

Layer 1.4 §5.1/§5.2/§9 把 `intersection` 去留显式移交本层。本层裁决：**保留** `Permission.intersection(callerAgent?.permission ?? [], agent.permission)`（2-arg 形态），不回归 upstream 的 `merge`（flatten）。

**upstream 现状**：`git diff upstream/dev -- task.ts` 证实 upstream `Session.create` 内联拼装权限数组，**从不调用 `intersection`**——子 agent 权限不经父 caller 收紧。

**intersection 的语义**：`intersection`（`permission/index.ts:299-324`）对每条 child 规则用 parent 求值——parent deny → 子 deny；child allow 仅当 parent 也 allow 才保留；parent 未被 child 覆盖的 deny 规则向下传播。效果：**子会话有效权限 ⊆ 父 caller 权限**。

**定性：政策选择，非安全必需**。这是本分支与 upstream 的**政策分歧**，不是安全漏洞修复。两种模型各有理：upstream 模型是"agent 定义即权限边界、caller 信任 agent 声明"——delegation 本就意味子 agent 获得 caller 没有的能力（委派的目的），子 agent 不能超出**自身**声明，但可超出 **caller**，by design；upstream 无 intersection 且运行良好。本分支模型是"caller 约束 child"：宽权限子 agent（如 `general`，`agent.ts:163-176` 基本为 `*:allow` 减 todowrite）被窄权限 caller dispatch 时，子会话同样受 caller 的 deny 约束——例如 caller 对某 bash 命令设了 deny（安全防线），dispatch 出去的 general 子会话也继承该 deny，而非获得 caller 没有的放行。本分支选择后者。

> **与路径限写的关系（避免混淆）**：路径限写（Layer 1.3/1.4，如 research-worker 的 `edit: {"*":"deny", ".aether/research/**":"allow"}`）由**子 agent 自身 frontmatter** 经 `Permission.fromConfig` 提供，**不依赖 intersection**即可生效（组装期 `disabled` 不误删、执行期 `evaluate` 命中路径 allow/deny）。intersection 只负责 **caller→child 约束传播**，与子 agent 自身路径规则是正交两层——故不以"路径限写"作为 intersection 的理由。

**这是 Layer 1.4 减法后唯一保留的运行时权限偏离**：Layer 1.4 删 Discipline、回归声明式，已清除"调用点指令式注入"；intersection 是剩余的 caller→child 运行时收紧。它与 `promptWithFallback`（模型韧性）、`owner`/`owns`（域隔离）同列为本分支"有意保留的偏离"，非待回退项——但它是其中**最接近 upstream 边界**的一个：若未来要进一步向 upstream 对齐，回退 intersection 即可（回退后子会话权限 = child 自身声明），需同步评估 caller 约束场景的影响。注：`owner`/`owns`（Layer 1.1）与本层权限契约**完全正交**——前者管域可见性（列表过滤 + execute 硬闸，`task.ts:71-75`/`108-111`），后者管运行时权限传递（intersection + 单轨，`task.ts:116`/`129-137`/`177-187`），不同阶段、不同数据，无依赖。

**无代码变更**：`intersection` 调用已存在于分支 `task.ts`（Layer 1.4 仅删其第三参）。本层为**决策固化**，不改代码、不加断言——契约由 §3 注释与 `intersection` 函数本身共同承载。

---

## 6. 影响面核对

| 场景                                               | 预期                                                                | 依据                     |
| -------------------------------------------------- | ------------------------------------------------------------------- | ------------------------ |
| `task.ts` 子会话                                   | `session.permission = finalPermission`，不变                        | 不传 `tools`，不触发覆盖 |
| `Permission.intersection` 调用                     | 保留（子≤父收紧），不变                                             | §5.5 有意偏离 upstream   |
| `github.ts` `tools:{"*":false}`                    | `question:deny` 被覆盖为 `{*:deny}`（更严、末步、无害），全工具禁用 | §1.2 良性触发            |
| `review-agent.ts` 传 `tools`                       | 覆盖既有（base 空，无影响），不变                                   | 覆盖语义保留             |
| 某调用方既设丰富 `session.permission` 又传 `tools` | 丰富部分**被静默冲掉**（已知限制）                                  | 覆盖保留，§1.2           |
| `resolveTools` deny-filter                         | 不变（读 `session.permission`，值同源）                             | Layer 1.3 不受影响       |
| `ctx.ask` 执行期                                   | 不变（读 `session.permission`）                                     | 同上                     |
| `PromptInput.tools` API                            | 保留（`@deprecated`，覆盖语义）                                     | 不删、不改               |
| `prompt.ts:181-192`                                | 与 upstream 字节一致，保留覆盖语义                                  | §5.1 最小侵入            |
| `bun typecheck`                                    | 通过                                                                | 仅加注释                 |

---

## 7. 验收清单

1. `task.ts:177` 前有单轨契约注释（含 `@deprecated` 指引、覆盖限制说明、`finalPermission` 保留理由、结构性省略 `tools` 说明）
2. `prompt.ts:189-192` 与 upstream 字节一致（仍为 `session.permission = permissions` 覆盖）
3. `github.ts` `tools:{"*":false}` 行为不变（仍禁全部工具）
4. `task.ts` 子会话 `session.permission` 仍为 `finalPermission`（不传 `tools`）
5. `resolveTools` deny-filter / `ctx.ask` 行为不变
6. `bun typecheck` 在 `packages/opencode` 通过
7. `Permission.intersection` 调用保留（子≤父收紧），无代码变更（§5.5）

---

## 8. 测试策略

### 8.1 现有测试更新

| 测试文件                                    | 改动                                              |
| ------------------------------------------- | ------------------------------------------------- |
| `test/session/compaction-flow.test.ts:436`  | 不受影响（走 `tools` 轨但覆盖语义保留，行为不变） |
| `test/layer-2/config-load-order.test.ts` 等 | 不受影响（不涉 `PromptInput.tools` 轨）           |

> 本层仅加注释、零逻辑变更，无行为变更需测试覆盖。§8.2 为单轨契约的运行时不变性验证（防回归）。

### 8.2 新增测试：单轨契约运行时不变性

落地文件：`test/layer-1/single-track-permission.test.ts`

**Test A — prompt 不传 tools 时 session.permission 不被覆盖（无 LLM）**

构造方式：创建带丰富 permission（含 path-scoped 规则）的 session → 调 `SessionPrompt.prompt` 不传 `tools`、设 `noReply: true`（跳过 LLM 循环，但仍经过 `prompt.ts:181-192` 的 tools→permission 转换逻辑）→ 断言 `session.permission` 不变。

```ts
test("prompt without tools preserves session.permission", async () => {
  await using tmp = await tmpdir({ config: { provider: { [pid]: { ... } } } })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const rich: Permission.Ruleset = [
        { permission: "edit", pattern: "src/**", action: "allow" },
        { permission: "edit", pattern: "*", action: "deny" },
        { permission: "bash", pattern: "*", action: "deny" },
      ]
      const session = await Session.create({ permission: rich })

      await SessionPrompt.prompt({
        sessionID: session.id,
        agent: "build",
        model,
        noReply: true,
        parts: [{ type: "text", text: "test" }],
      })

      const updated = await Session.get(session.id)
      expect(updated.permission).toEqual(rich)
    },
  })
})
```

关键点：`noReply: true` 在 `prompt.ts:194` 返回，但在 `prompt.ts:181-192` 之后——故若误传 `tools`，覆盖已发生、测试会失败。不传 `tools` → `permissions` 数组为空 → `if (permissions.length > 0)` 不触发 → permission 保持。

**Test B — TaskTool 全链路 dispatch 后 session.permission 包含 finalPermission 规则（mock LLM）**

构造方式：mock LLM server（复制 `compaction-flow.test.ts` 的 `stub`/`stream`/`chunk` **实现模式**——三者均为该文件内部定义的 helper，非可 import 的导出，须复制到本测试文件）→ 创建父 session + prompt 产生 assistant message → 调 `TaskTool.execute` dispatch `general`（`bypassAgentCheck: true` 跳过 ask）→ 从 `result.metadata.sessionId` 取子 session → 不变式断言：`session.permission` 包含 `primary_tools` deny 规则。

```ts
test("task dispatch preserves finalPermission (no tools overwrite)", async () => {
  const srv = await stub([
    { type: "text", text: "ok", usage: { input: 4, output: 2 } }, // parent
    { type: "text", text: "done", usage: { input: 4, output: 2 } }, // child
  ])
  await using tmp = await tmpdir({
    git: true,
    config: {
      provider: {
        [pid]: {
          /* openai-compatible, baseURL: srv.url */
        },
      },
      experimental: { primary_tools: ["bash"] },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      // 1. 父 session + prompt 产生 assistant message
      const parent = await Session.create({})
      await SessionPrompt.prompt({
        sessionID: parent.id,
        agent: "build",
        model,
        parts: [{ type: "text", text: "dispatch" }],
      })
      const msgs = await Session.messages({ sessionID: parent.id })
      const assistant = msgs.findLast((m) => m.info.role === "assistant")!

      // 2. 经 TaskTool dispatch general
      const caller = await Agent.get("build")
      const tool = await TaskTool.init({ agent: caller! })
      const result = await tool.execute(
        { description: "test", prompt: "say hi", subagent_type: "general" },
        {
          sessionID: parent.id,
          messageID: assistant.info.id as MessageID,
          agent: "build",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: () => {},
          ask: async () => {},
          extra: { bypassAgentCheck: true },
        },
      )

      // 3. 不变式：primary_tools deny 规则存在 → finalPermission 存活
      //    （该规则只能来自 Session.create 的 finalPermission，
      //     不可能来自 tools 覆盖——promptWithFallback 不传 tools）
      const child = await Session.get(SessionID.make(result.metadata!.sessionId as string))
      const hasBashDeny = child.permission?.some(
        (r) => r.permission === "bash" && r.pattern === "*" && r.action === "deny",
      )
      expect(hasBashDeny).toBe(true)
    },
  })
})
```

关键点：不复制 `finalPermission` 构造逻辑——用不变式断言（`primary_tools` deny 规则存在即证明 `finalPermission` 在 prompt 后存活）。若 `promptWithFallback` 误传 `tools`，`session.permission` 会被覆盖为仅含 tool 级 on/off 规则，`primary_tools` deny 丢失，测试失败。

### 8.3 手动验证

1. `github.ts` 触发 `tools:{"*":false}` 路径，确认子会话所有工具被禁（行为不变）
2. dispatch research-worker 子 agent，确认 `session.permission` 为 `finalPermission`（无 `tools` 叠加）
3. `bun typecheck` 通过

---

## 9. 行号定位指南

本文 `file:line` 引用基于 Layer 1.4 后的工作区状态。代码库仍在活跃重构，行号可能漂移——实施时先跑下表 grep 定位，再按 §3/§4 代码块内容操作：

| 定位目标                                          | grep 锚点                                                       |
| ------------------------------------------------- | --------------------------------------------------------------- |
| task.ts 注释插入点（`promptWithFallback` 调用前） | `rg "const result = await promptWithFallback" src/tool/task.ts` |
| task.ts `finalPermission`                         | `rg "const finalPermission" src/tool/task.ts`                   |
| task.ts `intersection` 调用                       | `rg "Permission.intersection" src/tool/task.ts`                 |
| task.ts `primary_tools` deny                      | `rg "primary_tools" src/tool/task.ts`                           |
| task.ts `promptWithFallback` 函数定义             | `rg "async function promptWithFallback" src/tool/task.ts`       |
| prompt.ts tools→permission 转换 + 覆盖            | `rg "session.permission = permissions" src/session/prompt.ts`   |
| prompt.ts `@deprecated`                           | `rg "@deprecated" src/session/prompt.ts`                        |
| permission/index.ts `merge`                       | `rg "function merge" src/permission/index.ts`                   |
| permission/index.ts `intersection`                | `rg "function intersection" src/permission/index.ts`            |

若 grep 命中行号与本文不符，说明代码已漂移，以代码块内容为准。
