# Layer 1.1: Component Domain Visibility — 跨主代理组件可见性闸门（subagent + skill）

> 前置依赖: Layer 0（Permission.intersection、Discipline.compile、Agent.Info 扩展）、Layer 1（output_dir、fallback_models、MCP per-agent、denied tools 优化——已完成）
> 本文档是 agent 基础设施扩展，与 Layer 1 同源（同改 `Config.Agent` / `Agent.Info` schema + merge 循环 + 工具过滤），并扩展到 `Skill` schema 与 `Skill.available` 过滤。
> 完成后：research 组件（6 subagent + 24 skill）仅对声明 `owns: [research]` 的主代理/dispatcher 可见，build/plan 在 task 工具列表、system prompt `<available_skills>`、skill 工具列表三处**均看不到**也**无法按名调用**它们；`explore`/`translator`/`docs` 等无 `owns` 的 agent 不受影响；`general` 作为可派发 subagent 仍全局可见，但其自身 skill 池剔除 research 域 skill（符合隔离目标，`.opencode/skills/*` 通用 skill 仍可见）。

---

## 上下文

| Layer         | 状态       | 简介                                                              |
| ------------- | ---------- | ----------------------------------------------------------------- |
| Layer 0       | 已完成     | 核心安全增强：intersection、compile、task 参数扩展、Info 扩展     |
| Layer 1       | 已完成     | Agent 基础设施：output_dir、fallback_models、MCP per-agent        |
| **Layer 1.1** | **本文档** | 组件域可见性闸门：`owner`/`owns` 模型同时作用于 subagent 与 skill |
| Layer 3.x     | 已完成     | Research 运行时：状态机、skill 链、subagent 派发                  |

---

## 1. 问题分析

### 1.1 核心问题：research 组件（subagent + skill）经多条通道泄漏到 build/plan

research agent 及其 6 个 subagent、24 个 research skill 通过启动期 seeding 安装到用户级 `~/.aether/`。seeding 把 `.aether/agent` 与 `.aether/skills` 全量同步到全局（`migrate.ts:477` `subdirs = ["agent", "mcp"]` + skills，`:478-479`）。副作用：这些 research 组件被全局配置加载器与 skill 发现器加载，并经**多条相互独立的通道**出现在所有主代理（`build`/`plan`）的 LLM 上下文中，可被 dispatch / 加载。

这会：

1. **污染 build/plan 的 task 工具说明**——6 个 research subagent 描述被注入 task 工具 `description`
2. **污染 build/plan 的 system prompt**——24 个 research skill 的 name+description 经 `<available_skills>` 块注入；其中至少 56 处描述文本提及 `research-worker`/`research-explorer`/`local-executor` 等子代理名，使这些名字在 build/plan 上下文中 salient
3. **误用时得到残废/错配的 agent/skill**——dispatch 时权限取交集（`task.ts:125-129`），research subagent 的 `file_scope: .aether/research/**`、research 专用 MCP、研究流程 prompt 在编码上下文完全错配
4. **污染 `.aether/research/` 目录**——`local-executor` 只写 `.aether/research`、强制 uv venv、"禁止 advance_plan"，编码场景误调会往研究目录写入无关产物
5. **工作效果变差**——工具说明与 system prompt 变长、描述误导，build/plan 的组件选择质量下降

### 1.2 泄漏通道全清单（带代码证据）

research 组件经下表所有通道进入 build/plan 上下文。**单通道关闸无效**——必须覆盖每个 per-agent 上下文的列举/调用点。

| #      | 通道                                      | 组件      | 当前泄漏机理（代码证据）                                                                                                                                                                                     |
| ------ | ----------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A      | task 工具 subagent **列表**               | subagent  | `task.ts:73-88` factory 按 `Permission.evaluate("task",name,caller.permission)` 过滤；build 权限含 `"*":"allow"`（`agent.ts:111`）→ 恒返回 allow → 6 research subagent 全部入列                              |
| A'     | task 工具**按名 dispatch**                | subagent  | `task.ts:108` `Agent.get(params.subagent_type)` 按名取即继续；`ctx.ask`（`:96-105`）对 build 返回 allow，不构成第二道闸；`subagent_type` 是自由 `z.string()`（`:22`）非枚举约束                              |
| **B**  | **system prompt `<available_skills>` 块** | **skill** | `system.ts:80` `Skill.available(agent)` → `:84` `Skill.fmt`；`available`（`skill/index.ts:390-395`）仅按 `skill` 权限过滤，build `*:allow`→全放行；24 research skill 描述入 system prompt，56 处提及子代理名 |
| **G**  | skill 工具 **description**                | skill     | `skill.ts:12` `Skill.available(ctx?.agent)` → `:29` `Skill.fmt`；与 B 共用 `available`，同机理泄漏                                                                                                           |
| **G'** | skill 工具**按名加载**                    | skill     | `skill.ts:46` `Skill.get(params.name)` 按名取即注入全文；`ctx.ask skill`（`:58-63`）对 build allow；错误消息 `:49` 用 `Skill.all()` 转储全部 skill 名                                                        |
| H      | 斜杠命令 `/deep-research` 等              | skill     | `command/index.ts:151` `Skill.all()` 未过滤即注册为 `/` 命令；用户手敲可触发                                                                                                                                 |
| (M)    | MCP 工具                                  | mcp       | `prompt.ts:897-902` 仅当 `agent.mcp !== undefined` 时过滤，**未定义=全放行**；research MCP 现仅靠"未被 build 触发连接"而隐身——巧合非硬约束（**另案处理**，见 §5.4）                                          |

### 1.3 现有"research-worker only"约束是软的

`research.md`、`research-worker.md` 的"只用 research-worker / 禁用 explore/general"全是 prompt 文本，仅在 research 体系内部生效，对 build/plan 无约束力。`research.md:19` 与 `research-worker.md:19` 当前是 `task: allow`（= allow-all），硬权限层放行所有子代理。

### 1.4 research 组件清单（6 subagent + 24 skill）

**6 个 research subagent**（`.aether/agent/*.md`）：

| subagent          | 现有 dispatch 链                           | 被 build/plan 误用的危害                                 |
| ----------------- | ------------------------------------------ | -------------------------------------------------------- |
| research-explorer | research→worker / Path 2 literature-review | `file_scope:.aether/research/**`、research MCP → 锁死    |
| research-worker   | research 唯一                              | 状态机 prompt → 完全错配                                 |
| research-verifier | autoresearch（在 worker 内）               | 验证协议 prompt → 错配                                   |
| gpd-verifier      | autoresearch（在 worker 内）               | 物理 SymPy prompt、research MCP → 错配                   |
| gpd-reviewer      | research-worker                            | 物理同行评审 prompt → 错配                               |
| local-executor    | research-worker / autoresearch             | uv-venv-only、只写 `.aether/research`、leaf → 错配且污染 |

**24 个 research skill**（`.aether/skills/**/SKILL.md`，全部标 `owner: research`）：

20 个 top-level：autoresearch、deep-research、research-coordinator、research-audit、research-audit-reasoning、research-audit-repair、research-audit-repair-reasoning、literature-review、literature-landscape-scan、paper-search、paper-code-audit、research-question-framing、research-verification、source-comparison、env-setup、health-check、debate-adjudicator、debate-advocate、debate-critic、debate-repair

4 个 `plugins/gpd/*`：gpd-conventions、gpd-domain-check、gpd-errors、gpd-verification

> 注：`.opencode/skills/*`（含 arxiv-search、academic-researcher、read-arxiv-paper 等通用研究助手）**不纳入 research 域**，保持全局可见（决策见 §5.1）。

---

## 2. 当前实现追踪

### 2.1 task 工具 ctx 形态（决定过滤写在哪里）

`Tool.define` 的 factory 收到的 `ctx` 是 `InitContext`（`tool/tool.ts:13-16`），其中 `ctx.agent?: Agent.Info` 是**完整 Info 对象**（`caller.permission` / `caller.owns` 直接可用）。而 `execute(params, ctx)` 中的 `ctx` 是 `Context`（`tool.ts:17-20`），`ctx.agent: string` 仅为 name（`task.ts:111` 通过 `Agent.get(ctx.agent)` 重新解析）。

结论：列表过滤写在 `task.ts:73-88` factory（`caller = ctx.agent` 完整 Info）；execute 硬闸用 `Agent.get(ctx.agent)` 解析 caller。

### 2.2 skill 系统的注入二分支（决定 owns 闸门写在哪里）

`SystemPrompt.skills(agent)`（`system.ts:57-86`）有**互斥二选一**的两个分支：

- **eager 分支**（`:60-78`）：`agent.skillRefs?.length` 为真 → `Skill.get(name)` 逐个加载全文 → 拼为 `"## Skills (mandatory)"` + `"You MUST follow"` + `"do NOT use the skill tool to load them again"` 注入 system prompt → **return，不走 lazy 列表**
- **lazy 分支**（`:80-85`）：无 skillRefs → `Skill.available(agent)` → `Skill.fmt` 拼为 `<available_skills>` 列表 + `"Use the skill tool to load a skill when a task matches"`（建议性）

`Skill.available(agent)`（`skill/index.ts:390-395`）是 lazy 分支与 skill 工具列表（`skill.ts:12`）的**共用闸门**——在此加 owner 过滤可同时关闭通道 B 与 G。

### 2.3 skillRefs 的真实语义（注入策略，非可见性声明）

`skillRefs`（`Config.Agent.skill_refs` / `Agent.Info.skillRefs`）在代码库中**仅 `system.ts:60-63` 一处功能消费**——它决定走 eager 全文注入分支。它**不声明可见性/归属**，与 `owner`/`owns` 语义正交。所有 7 个 research agent 的 skillRefs 模式如下：

| agent             | skillRefs                                                                                  | 性质                                               |
| ----------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| research-explorer | `[paper-search]`                                                                           | 叶子执行器，paper 搜索是其存在意义                 |
| research-verifier | `[research-verification]`                                                                  | 叶子，验证协议是唯一职能                           |
| gpd-verifier      | `[research-verification, gpd-verification, gpd-errors, gpd-domain-check, gpd-conventions]` | 叶子，5 skill 必须**同时**遵循                     |
| gpd-reviewer      | `[gpd-errors, gpd-conventions, gpd-domain-check]`                                          | 叶子，3 物理 skill 组合                            |
| research-worker   | 无                                                                                         | 靠 lazy 分支 + SkillTool 加载 state machine skill  |
| local-executor    | `[]`                                                                                       | 纯执行器，无 skill                                 |
| research.md       | 无                                                                                         | coordinator，靠 SkillTool 加载 state machine skill |

skillRefs 的不可替代价值：① 确定性装备（叶子一进入就有核心手册）② 组合强制（gpd-verifier 必须同时遵循 5 skill）③ 防重复加载 ④ "MUST follow"强制语义。详见 §5.2。

### 2.4 schema 与 merge 循环位置

- `Config.Agent` schema：`config.ts:792-859`（`output_dir` 在 `:855-858`）
- `knownKeys` 集合：`config.ts:862-887`（未列入的字段会被丢进 `options`，必须显式登记）
- `Agent.Info` schema：`agent.ts:29-74`（`outputDir` 在 `:73`）
- merge 循环：`agent.ts:280-306`（`item.mode` 在 `:281`，`item.fileScope` 在 `:290`，`item.outputDir` 在 `:296`，`item.skillRefs` 在 `:288`）
- `Skill.Info` schema：`skill/index.ts:32-37`（仅 `name/description/location/content`，**无 owner**，需新增）
- skill frontmatter 解析：`skill/index.ts:232` `Info.pick({ name: true, description: true })`（需加 `owner`）
- `Skill.available`：`skill/index.ts:390-395`

### 2.5 Path 2 / Path 3 的交叉依赖

Path 2 的 `literature-review` skill 会直接 dispatch `research-explorer`（`literature-review/SKILL.md:59,63,74,132`），运行在 `research.md` 会话/权限下。research.md 的合法 dispatch 目标 = `research-worker`（Path 3）+ `research-explorer`（Path 2）。归属模型只需保证 research.md 拥有 `owns:[research]` 即可让全部 research 组件对其可见，无需为 Path 2 特殊处理。

---

## 3. 修复方案：owner / owns 升级为组件域可见性统一原语

### 设计哲学：两层组装模型

`owner`/`owns` 与 `skillRefs` 是**正交互补**的两层，职责分层：

| 层      | 字段                | 位于                             | 解决的问题                                                  | 作用层     |
| ------- | ------------------- | -------------------------------- | ----------------------------------------------------------- | ---------- |
| 第 1 层 | `owner: research`   | subagent / skill（组件侧）       | 跨域可见性：谁能在候选列表里看到这个组件                    | 列表过滤   |
| 第 1 层 | `owns: [research]`  | primary / dispatcher（消费者侧） | 可访问哪些域的组件（subagent + skill）                      | 列表过滤   |
| 第 2 层 | `skill_refs: [...]` | agent（消费者侧）                | 注入策略：哪些 skill 全文在会话开始时强制注入 system prompt | eager 预装 |

- 第 1 层管"能不能看到"（可见性池），第 2 层管"要不要强制装上"（确定性装备）。
- `owner` 表达"领域归属"（research 域 vs 通用域），`task`/`skill` 权限白名单表达"域内调用拓扑"（谁能调谁）。本文档只引入 `owner`/`owns` 解决**跨域可见性**；research 体系内部的父子拓扑仍维持现有 prompt 软约束。
- **skillRefs 保留不变**——它与 owns 正交，移除是功能回归（详见 §5.2）。

### 闸门覆盖（每个泄漏通道对应一个关闸点）

| 通道                                  | 组件     | 关闸点                                                       | 闸类型         |
| ------------------------------------- | -------- | ------------------------------------------------------------ | -------------- |
| A. task 工具 subagent 列表            | subagent | `task.ts` factory 列表过滤                                   | 列表隐藏       |
| A'. task 工具按名 dispatch            | subagent | `task.ts` execute 加 owner 硬闸                              | 硬闸（服务端） |
| B. system prompt `<available_skills>` | skill    | `Skill.available(agent)` 加 owner 闸                         | 列表隐藏       |
| G. skill 工具 description             | skill    | 同上（共用 `available`）                                     | 列表隐藏       |
| G'. skill 工具按名加载                | skill    | `SkillTool.execute` 加 owner 硬闸 + 错误消息改用 `available` | 硬闸（服务端） |
| H. 斜杠命令面                         | skill    | **不过闸**（决策 §5.3：保持全局，意图调用）                  | —              |
| skillRefs 注入                        | skill    | **不过闸**（`Skill.get` 显式引用，eager 预装）               | —              |
| debug/server/review 列表              | skill    | **不过闸**（基础设施视图，与 agent 无关）                    | —              |
| (M) MCP 工具                          | mcp      | **另案**（决策 §5.4）                                        | —              |

**闸门原则**：枚举点（`available`）与按名调用点（两个 execute）过 owner 闸；显式引用（`skillRefs`→`Skill.get`）与基础设施视图（`Skill.all`）不过闸。

### push 模型（归属声明在 caller 侧）

归属声明放在 caller 侧（`owns`），组件侧只声明归属（`owner`）：

- 新增 research 组件：subagent/skill 加 `owner: research` → 自动对声明 `owns:[research]` 的 caller 可见，无需逐一登记 caller
- build/plan 不声明 `owns` → research 组件自动隐藏，零改动
- research 侧耦合集中在 7 个 agent 的 `owns` 声明

---

## 4. 改动清单

### 4.1 代码（5 文件）

**改动 1: `Config.Agent` schema 新增 `owner` / `owns`**

文件：`packages/opencode/src/config/config.ts`

在 `output_dir`（`:855-858`）之后、`.catchall(z.any())` 之前新增：

```ts
owner: z
  .string()
  .optional()
  .describe(
    "Domain group this subagent belongs to (e.g. 'research'). When set, the subagent is only visible to agents whose `owns` includes this group. Subagents without `owner` remain globally visible.",
  ),
owns: z
  .array(z.string())
  .optional()
  .describe(
    "Domain groups this agent may dispatch subagents / load skills from. Only components whose `owner` is listed here are visible to this agent in the task/skill tool and system prompt. Absent/empty = no owned components visible (plain components still visible).",
  ),
```

在 `knownKeys`（`:862-887`）追加 `"owner"`、`"owns"`。

**改动 2: `Agent.Info` schema + merge 循环**

文件：`packages/opencode/src/agent/agent.ts`

`Agent.Info`（`:73` `outputDir` 之后）新增：

```ts
outputDir: z.string().optional(),
owner: z.string().optional(),
owns: z.string().array().optional(),
```

merge 循环（`:296` `item.outputDir = ...` 之后）追加：

```ts
item.outputDir = value.output_dir ?? item.outputDir
item.owner = value.owner ?? item.owner
item.owns = value.owns ?? item.owns
```

**改动 3: `Skill.Info` schema + 解析 + `available` 闸门**

文件：`packages/opencode/src/skill/index.ts`

`Skill.Info`（`:32-37`）新增 `owner`：

```ts
export const Info = z.object({
  name: z.string(),
  description: z.string(),
  owner: z.string().optional(), // 新增
  location: z.string(),
  content: z.string(),
})
```

`add()` 解析（`:232`）加 `owner`：

```ts
const parsed = Info.pick({ name: true, description: true, owner: true }).safeParse(md.data)
```

`available()`（`:390-395`）加 owner 闸（一行，同时关 B+G）：

```ts
const available = Effect.fn("Skill.available")(function* (agent?: Agent.Info) {
  const s = yield* getState()
  const list = Object.values(s.skills).toSorted((a, b) => a.name.localeCompare(b.name))
  if (!agent) return list.filter((skill) => !skill.owner)
  return list.filter((skill) => {
    if (Permission.evaluate("skill", skill.name, agent.permission).action === "deny") return false
    if (skill.owner && !agent.owns?.includes(skill.owner)) return false
    return true
  })
})
```

**改动 4: task 工具列表过滤 + execute 硬闸**

文件：`packages/opencode/src/tool/task.ts`

factory 列表（`:73-81`）加 owner 闸：

```ts
const caller = ctx?.agent
const accessibleAgents = agents.filter((a) => {
  if (a.owner && !caller?.owns?.includes(a.owner)) return false
  if (caller && Permission.evaluate("task", a.name, caller.permission).action === "deny") return false
  return true
})
```

execute 复用 `task.ts:111` 已声明的 `callerAgent`（**勿重复 `const` 声明**，否则 SyntaxError），在 `:111` 之后追加 owner 硬闸：

```ts
// task.ts:108-111 保持原样（不改动）：
//   const agent = await Agent.get(params.subagent_type)
//   if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)
//   const callerAgent = ctx.agent ? await Agent.get(ctx.agent) : undefined
// 在 :111 之后插入：
if (agent.owner && !callerAgent?.owns?.includes(agent.owner))
  throw new Error(
    `Agent "${agent.name}" belongs to domain "${agent.owner}", not dispatchable by "${ctx.agent ?? "(none)"}"`,
  )
```

**改动 5: skill 工具 execute 硬闸 + 错误消息**

文件：`packages/opencode/src/tool/skill.ts`

execute（`:46` 取到 skill 后）加硬闸，错误消息 `:49` 改用 `available` 而非 `all()`（避免泄漏 owner skill 名）：

```ts
const skill = await Skill.get(params.name)
if (
  !skill ||
  !(await fs.access(skill.location).then(
    () => true,
    () => false,
  ))
) {
  const caller = ctx.agent ? await Agent.get(ctx.agent) : undefined
  const visible = await Skill.available(caller ?? undefined).then((x) => x.map((s) => s.name).join(", "))
  throw new Error(`Skill "${params.name}" not found. Available skills: ${visible || "none"}`)
}
const caller = ctx.agent ? await Agent.get(ctx.agent) : undefined
if (skill.owner && !caller?.owns?.includes(skill.owner))
  throw new Error(
    `Skill "${params.name}" belongs to domain "${skill.owner}", not loadable by "${ctx.agent ?? "(none)"}"`,
  )
```

### 4.2 Frontmatter（31 文件，37 行新增）

**7 个 research agent**（`.aether/agent/*.md`）：全部加 `owns: [research]`；6 个 subagent 额外加 `owner: research`（research.md 是 primary，无 owner）。

| 文件                     | 新增                                   |
| ------------------------ | -------------------------------------- |
| `research.md`（primary） | `owns: [research]`                     |
| `research-worker.md`     | `owner: research` + `owns: [research]` |
| `research-explorer.md`   | `owner: research` + `owns: [research]` |
| `research-verifier.md`   | `owner: research` + `owns: [research]` |
| `gpd-verifier.md`        | `owner: research` + `owns: [research]` |
| `gpd-reviewer.md`        | `owner: research` + `owns: [research]` |
| `local-executor.md`      | `owner: research` + `owns: [research]` |

> 全部 7 个 research agent 加 `owns`（决策 §5.5）：owns 语义统一为"可访问该域组件（subagent + skill）"。叶子 agent 虽当前靠 skillRefs eager 注入覆盖 skill 需求，加 owns 为一致性与未来通过 SkillTool 访问域内新 skill 预留。

**24 个 research skill**（`.aether/skills/**/SKILL.md`）：frontmatter 加 `owner: research`。

> 特例：`research-coordinator/SKILL.md` 原本**无 frontmatter**（仅有正文 `# Research Coordinator Skill`），导致 `Skill.add()` 因缺 `name`/`description` 而跳过、从未进入 skill 注册表。实现为其补全了完整 frontmatter（`name` + `description` + `owner: research`），使其可被发现与归属过滤。其余 23 个 skill 原有 frontmatter，仅追加 `owner: research`。

20 top-level：autoresearch、deep-research、research-coordinator、research-audit、research-audit-reasoning、research-audit-repair、research-audit-repair-reasoning、literature-review、literature-landscape-scan、paper-search、paper-code-audit、research-question-framing、research-verification、source-comparison、env-setup、health-check、debate-adjudicator、debate-advocate、debate-critic、debate-repair

4 个 `plugins/gpd/*`：gpd-conventions、gpd-domain-check、gpd-errors、gpd-verification

skill frontmatter 示例：

```yaml
---
name: deep-research
description: |
  Phase 1 (phase_analysis) of the Path 3 research state machine.
  ...
owner: research # 新增：归属于 research 域
---
```

### 4.3 总计

**5 代码文件 + 31 md 文件 = 36 文件**（全小改，机械无逻辑风险）。核心新增代码量：config.ts 约 12 行、agent.ts 约 4 行、skill/index.ts 约 8 行、task.ts 约 6 行、skill.ts 约 6 行；frontmatter 52 行（含 research-coordinator 补全的 9 行完整 frontmatter）。

**不改的东西**：

- `build`/`plan` 内置定义（`agent.ts:132-171`）——零改动，无 `owns` → research 组件自动隐藏
- seeding 流程（`migrate.ts:465-506`）——`subdirs` 已含 `agent`/skills，改后 .md 正常 sync
- `ConfigPaths.directories()` / `loadAgent()` / `scanAllSkillPaths()` 发现逻辑
- `Permission` / `Discipline` / `evaluate` 机制
- `general`/`explore` 内置 subagent；`translator`/`docs`/`triage`/`duplicate-pr`（.opencode subagent）
- `.opencode/skills/*`（不纳入 research 域，保持全局可见）
- `skillRefs` 机制（保留不变，与 owns 正交）
- research 体系内部的 task 权限（维持 `task: allow`，域内拓扑仍为 prompt 软约束）
- `SystemPrompt.skills` 的二分支结构（eager/lazy 不变，仅 lazy 分支经 `available` 受 owns 闸）

---

## 5. 设计决策与权衡

### 5.1 skill 域边界：仅 `.aether/skills/*`

仅 `.aether/skills/**/SKILL.md`（24 个）标 `owner: research`；`.opencode/skills/*`（含 arxiv-search、academic-researcher、read-arxiv-paper、alpha-research、replication 等通用研究助手）保持全局可见。

理由：`.aether/skills` 是 research 状态机专用 skill（与 research agent 强耦合、含子代理名、研究流程 prompt）；`.opencode/skills` 是通用工具型 skill（独立于 research 体系、对编码场景有用）。边界清晰、与打包结构一致，避免逐个判定 .opencode skill 归属的模糊性。

### 5.2 `skillRefs` 与 `owns` 的职责边界

`skillRefs` 与 `owner`/`owns` 语义正交，各司其职：

- `skillRefs`（`system.ts:60-63` 唯一消费点）决定走 eager 全文注入分支（`"MUST follow"`）——会话开始即把指定 skill 全文强制注入 system prompt；它不参与可见性过滤。
- `owns` 管 lazy 分支的 `<available_skills>` 列表与 SkillTool 列表的可见性过滤。

当前 5 个叶子 agent 依赖 `skillRefs` 实现确定性预装：research-explorer（paper-search）、research-verifier（research-verification）、gpd-verifier（5 个物理 skill 必须**同时**遵循，lazy 下 LLM 可能漏载 `gpd-conventions` 致物理验证致命）、gpd-reviewer（3 个物理 skill）、local-executor（`[]`）。本次改动**不触碰 `skillRefs`**——eager 注入走 `Skill.get` 显式引用，不过 owner 闸，行为不变。

`research-worker` 与 `research.md`（coordinator）**无 `skill_refs`**，本身走 lazy 分支，靠 `owns:[research]` 解锁 SkillTool 访问 state machine skill（autoresearch/deep-research/research-coordinator 等）。两层互补不替代。

### 5.3 斜杠命令面不过闸

`command/index.ts:151` 用 `Skill.all()` 把 skill 注册为 `/` 命令。保持不过闸（全局可见）：

- 用户手敲 `/deep-research` 属**意图调用**，与 LLM 自动上下文不同
- 命令模块构建列表时不持有 agent 上下文（需重构为 agent-aware），工作量与耦合上升
- 保留为用户可达入口，符合"用户意图优先"原则

### 5.4 MCP 残余泄漏另案处理

`prompt.ts:897-902` 仅当 `agent.mcp !== undefined` 时过滤 MCP 工具，**未定义=全放行**。research MCP 现仅靠"未被 build 触发连接"而隐身——巧合非硬约束。

本次聚焦 subagent + skill（用户指定范围）。MCP 残余泄漏单独成一改动（如反转默认为"未定义=隐藏"或给 MCP server 加 owner），单独评估其回归面。

### 5.5 全部 7 个 research agent 加 `owns`

owns 语义统一为"可访问该域组件（subagent + skill）"。叶子 agent（research-explorer/verifier/gpd-verifier/gpd-reviewer）虽当前靠 skillRefs eager 注入覆盖 skill 需求，加 owns 为一致性与未来通过 SkillTool 加载域内新 skill 预留能力。每个 research agent 既 `owner:research` 归属该域、又 `owns:[research]` 可访问该域，对称清晰。

### 5.6 owner 闸与现有权限过滤的关系

两者串联在各过滤点，先后独立：

1. owner 闸（本改动）：归属组件只对 `owns` 含该组的 caller 可见——解决**跨域可见性**
2. `Permission.evaluate("task"/"skill", name, permission)`（已有）：caller 的权限规则——解决**域内调用契约**（当前 research 体系为 `task: allow`/`skill: allow`，未做白名单）

任一返回 deny 即隐藏/拒绝。owner 在前是因为它更廉价（字符串比较）且覆盖面更广。

---

## 6. 影响面核对

| 场景                                                                                      | 预期                                        | 依据                                                                                                                                                   |
| ----------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| build/plan 的 task 工具列表                                                               | 不含 6 research subagent                    | build/plan 无 owns，subagent 有 owner:research → 闸门隐藏                                                                                              |
| build/plan 的 system prompt `<available_skills>`                                          | 不含 24 research skill                      | build/plan 无 owns，skill 有 owner:research → `available` 过滤                                                                                         |
| build/plan 的 skill 工具列表                                                              | 不含 24 research skill                      | 同上（共用 `available`）                                                                                                                               |
| build/plan 按名硬调 task `subagent_type:"research-worker"`                                | execute 抛错                                | task.ts execute owner 硬闸                                                                                                                             |
| build/plan 按名硬调 skill `name:"deep-research"`                                          | execute 抛错                                | skill.ts execute owner 硬闸                                                                                                                            |
| research.md dispatch research-worker（Path 3）                                            | 可见可调                                    | research.md owns:[research] + research-worker owner:research                                                                                           |
| research.md dispatch research-explorer（Path 2）                                          | 可见可调                                    | literature-review 在 research.md 会话内 dispatch；同上归属匹配                                                                                         |
| research-worker dispatch 5 个叶子                                                         | 可见可调                                    | research-worker owns:[research] + 叶子 owner:research                                                                                                  |
| research-worker 通过 SkillTool 加载 autoresearch 等 state machine skill                   | 可见可调                                    | research-worker 无 skill_refs，走 lazy 分支；owns:[research] 匹配 skill owner:research                                                                 |
| 叶子 agent 的 skillRefs eager 注入（research-explorer/gpd-verifier 等）                   | 正常注入                                    | skillRefs 走 `Skill.get` 不过闸                                                                                                                        |
| `explore`（built-in subagent）                                                            | 全局可见，行为不变                          | 无 owner；且 explore 权限未放行 `skill`，本就不持有 skill 池                                                                                           |
| `general`（built-in subagent）                                                            | 全局可见；其 skill 池剔除 research 域 skill | 无 owner → 作为可派发 subagent 仍可见；但 general 无 owns，其 `<available_skills>`/skill 工具不再含 24 research skill（`.opencode` 通用 skill 仍可见） |
| `translator`/`docs`/`triage`/`duplicate-pr`（.opencode subagent）                         | 全局可见，行为不变                          | 无 owner                                                                                                                                               |
| `.opencode/skills/*`（arxiv-search 等）                                                   | 全局可见，行为不变                          | 不纳入 research 域，无 owner                                                                                                                           |
| 斜杠命令 `/deep-research`                                                                 | 全局可达                                    | command 不过闸（决策 §5.3）                                                                                                                            |
| seeding 到 `~/.aether/`                                                                   | 正常                                        | migrate.ts 已含 agent/skills，无需改                                                                                                                   |
| dispatch 时权限交集（`task.ts:125-129`）                                                  | 不变                                        | owner 只影响可见性 + execute 硬闸，不改交集/ask 逻辑                                                                                                   |
| `delegation_depth: 0` → `task: deny *`（leaf）                                            | 不变                                        | 与 owner 正交                                                                                                                                          |
| v0.6.0 fallback（`task.ts:135-140`）                                                      | 不变                                        | 不涉及 owner                                                                                                                                           |
| `ctx.agent` 为 `undefined`（registry 未传 agent / `prompt.ts:359` subtask 路径无参 init） | 仅保留无 owner 的组件（默认安全）           | `caller?.owns ?? []` = `[]` → 带 owner 的组件全隐藏；subtask 路径 subagent_type 已预定，无功能影响                                                     |
| debug/server/review 列表（`Skill.all`）                                                   | 全量可见                                    | 不过闸（基础设施视图）                                                                                                                                 |

---

## 7. 验收清单

### 7.1 跨主代理可见性（核心目标）

1. build agent 的 task 工具 `description` 不含 6 个 research subagent
2. plan agent 同上
3. build/plan 的 system prompt `<available_skills>` 块不含 24 个 research skill
4. build/plan 的 skill 工具 `description` 不含 24 个 research skill
5. build/plan 即便按名硬调 task（如 `subagent_type:"research-explorer"`），execute owner 硬闸抛错
6. build/plan 即便按名硬调 skill（如 `name:"deep-research"`），execute owner 硬闸抛错

### 7.2 research 体系功能不回归

7. research agent 的 task 工具列表仍含全部 6 个 research subagent
8. research agent 的 system prompt / skill 工具列表仍含全部 24 个 research skill
9. research-worker 的 task 工具列表仍含 5 个叶子执行器
10. research-worker（无 `skill_refs`）通过 SkillTool 加载 autoresearch/deep-research 等 state machine skill 正常（owns:[research] 匹配）
11. 叶子 agent 的 skillRefs（research-explorer 的 paper-search、gpd-verifier 的 5 物理 skill 等）仍正常 eager 注入（走 `Skill.get`，不过闸）
12. Path 3：research → research-worker → 叶子 全链路正常 dispatch
13. Path 2：research → literature-review skill → research-explorer 正常 dispatch（归属匹配）
14. Path 1（quick lookup）/ Path 0（非研究）不受影响

### 7.3 通用组件不回归

15. `general`/`explore` 仍出现在所有主代理的 task 列表
16. `translator`/`docs`/`triage`/`duplicate-pr` 仍全局可见
17. `.opencode/skills/*`（arxiv-search 等）仍出现在所有主代理的 system prompt 与 skill 工具
18. 斜杠命令 `/deep-research` 仍全局可达

### 7.4 类型与构建

19. `bun typecheck` 在 `packages/opencode` 通过（勿用 `tsc` 直接）
20. 启动后 seeding 把改后的 .md 正常同步到 `~/.aether/`，无报错

### 7.5 边界

21. 组件无 `owner` → `owns` 缺失的 caller 仍可见它（向后兼容）
22. caller 无 `owns` → 仅看到无 `owner` 的组件（默认安全）
23. `owner` 值不在任何 caller 的 `owns` 中 → 该组件对所有 caller 隐藏（配置错误的安全失败方向）

---

## 8. 测试策略

### 8.1 手动验证

1. 在 `.aether/agent/` 与 `.aether/skills/` 应用改动后重启，确认 `~/.aether/agent/*.md`、`~/.aether/skills/**/SKILL.md` 已含 `owner`/`owns`
2. 切换到 build agent，让其描述可用 subagent 与 skill，确认不含 research 组件
3. 切换到 research agent，触发 Path 3 dispatch，确认 research-worker 可被调用
4. 在 research-worker 内触发叶子 dispatch 与 SkillTool 加载 autoresearch，确认均正常
5. 在 build agent 内尝试 `subagent_type:"research-worker"` 与 `name:"deep-research"`，确认 execute 抛错

### 8.2 单元测试（可选）

在 `skill/index.ts` 的 `available` 与 `task.ts`/`skill.ts` 的 execute 过滤上添加：构造 `Agent.Info`/`Skill.Info` mock（含/不含 owner）+ caller mock（含/不含 owns），断言可见列表与 execute 抛错行为。当前过滤逻辑无独立单测，可在后续随该文件测试补全。
