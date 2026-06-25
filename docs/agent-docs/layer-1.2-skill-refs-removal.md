# Layer 1.2: 删除 skillRefs 注入与 outputDir —— 回落正常 skill 机制 + 软提示

> 前置依赖: Layer 0（`skill_refs` eager 全文注入分支、`output_dir` system prompt 注入）、Layer 1.1（`owner`/`owns` 域可见性闸门——已完成）
> 本文档**取代**本目录早先版本的 layer-1.2 设计（"lazy 白名单 + `mandatory_skills` 指令标记"双字段模型）。经评估，双字段模型仍属"施工流程化"的复杂度，与"让 research agent 更像通用 agent 系统"的目标相悖。本文采用更彻底的简化：**直接删除 `skillRefs` 与 `outputDir` 两个字段及其全部核心代码消费点，回落到所有普通 agent 一致使用的正常 skill 机制（`Skill.available` 列表 + 按需 skill 工具），需要重点引导的 agent 在其 prompt 正文中以软提示措辞推荐 skill**。
> 完成后：`SystemPrompt.skills` 不再有 eager 注入分支；`skillRefs`/`outputDir` 从 `Agent.Info`/`Config.Agent` schema 与 merge 循环消失；research 子 agent 像 build/plan 一样看到 skill 列表、按需用 skill 工具加载，加载时经 `tool/skill.ts` 拿到 skill 全文 + 基目录 + 文件清单（脚本可达）。

---

## 上下文

| Layer         | 状态       | 简介                                                                    |
| ------------- | ---------- | ----------------------------------------------------------------------- |
| Layer 0       | 已完成     | `skill_refs` eager 全文注入分支（`system.ts:60-78`）、`output_dir` 注入 |
| Layer 1.1     | 已完成     | `owner`/`owns` 跨域可见性闸门（与 skillRefs 正交，**保留不动**）        |
| **Layer 1.2** | **本文档** | 删除 skillRefs + outputDir，回落正常 skill 机制 + prompt 软提示         |
| Layer 3.x     | 已完成     | Research 运行时（叶子 agent 当前依赖 skillRefs 注入，需迁移为软提示）   |

---

## 1. 问题分析

### 1.1 skillRefs 注入是"施工流程化"的体现

`skillRefs`（`Config.Agent.skill_refs` / `Agent.Info.skillRefs`）在 `SystemPrompt.skills`（`system.ts:60-78`）触发 **eager 分支**：会话开始即把每个 skill 全文 + 目录 URL 强制注入 system prompt，并下令 `"do NOT use the skill tool to load them again"`。这是"确定性装备"思路——把 agent 当作固定工序的执行器，而非可灵活决策的 agent。它与"适合各种问题的 agent 系统"的目标冲突：每个带 skillRefs 的叶子 agent 都把全部 skill 全文常驻 system prompt，context 臃肿、行为僵硬。

`skillRefs` 在代码库中**仅 `system.ts:60-63` 一处功能消费**，删除面集中、风险可控。

> **现状勘误（eager 注入实际仅对 1 个 agent 生效）**：`system.ts:57-60` 的执行顺序是**先权限闸门、后 eager 分支**——`if (Permission.disabled(["skill"], agent.permission).has("skill")) return`（`:58`）先于 `if (agent.skillRefs?.length)`（`:60`）。`disabled(["skill"], rules)`（`permission/index.ts:324-333`）对 `"*": deny` 规则：`Wildcard.match("skill","*")`=true（`util/wildcard.ts:4-20`），`pattern==="*" && action==="deny"` → skill 入 disabled 集 → `:60` eager 分支永不执行。5 个 skill_refs agent 中，**仅 research-explorer 在 frontmatter 有 `skill: allow`**（`research-explorer.md:21`）能过闸门、实际触发 eager 注入；gpd-verifier / gpd-reviewer / research-verifier 均 `"*": deny` 且**无 `skill: allow`**（`gpd-verifier.md:8-21` 等），eager 分支对它们是**死代码**——这三个 agent 当前既无 eager 注入、也无 skill 列表，`skill_refs` 是纯死字段。故本文 §1.1/§1.3 早期陈述的"gpd-verifier 当前 context 臃肿/得到 5 skill 全文"与代码事实不符；删除 skillRefs 的实际行为效应**集中在 research-explorer**，对另三个 agent 的真实效应是"补 `skill: allow` + 软提示使其**首次**获得 skill 访问"（见 §5.4、§4.2）。

### 1.2 outputDir 纯属 prompt 文本，无需 schema 字段

`outputDir`（`Agent.Info.outputDir`）经 `SystemPrompt.outputDir`（`system.ts:94-97`）产出一句 `"Your output directory is at <abs>. Write findings to this directory."` 拼进 system prompt。它没有任何超出"文本提示"的副作用——既不创建目录、不约束写入路径、不参与权限。为一个句子维护 schema 字段 + merge 映射 + normalize 逻辑，是不必要的核心代码侵入。

system 的 env 块（`system.ts:37-38`）已提供 `Working directory` 与 `Workspace root folder`，模型能自行解析 `.aether/research/` 这类相对路径。outputDir 完全可以由 agent 在 prompt 正文里一句话表达。

### 1.3 关键：skill 工具已返回基目录 + 文件清单，lazy 零损失

`SkillTool.execute`（`tool/skill.ts:108-124`）在 agent 用 skill 工具加载 skill 时，返回的 `<skill_content>` 块**已经包含**：

- `Base directory for this skill: ${base}`（`skill.ts:116`，`base = pathToFileURL(dir).href`）
- `"Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory."`（`skill.ts:117`）
- `<skill_files>` 采样文件列表（最多 10 个，`skill.ts:88-106`，排除 SKILL.md）

即：删除 skillRefs 并补齐 `skill: allow`（§4.2/§5.4）后，`gpd-verifier` 经 skill 工具按需加载 `gpd-verification` 时，**依然能拿到 SymPy 脚本目录路径并执行**。这消除了"必须 eager 注入才能访问 scripts/references"的技术顾虑——回落 lazy 不会丢失目录访问能力。这是本简化成立的前提，**无需对 `tool/skill.ts` 做任何补偿性改动**。

> 前提：本断言依赖 gpd-verifier 能调用 skill 工具，而当前其 `"*": deny` + 缺 `skill: allow` 致使 deny-filter（`prompt.ts:1007-1012` 的 `evaluate("skill","*",...)`）删除 skill 工具。故 `skill: allow` 补齐是本"lazy 零损失"成立的前置条件，见 §5.4。

> 勘误：早先讨论曾认为"回落 lazy 后需在 skill 工具补一行目录提示"。经核对 `tool/skill.ts:116-117`，该提示早已存在，无需补充。

### 1.4 当前字段消费面

`skillRefs`（5 个 agent 使用）与 `outputDir`（5 个 agent 使用）：

| agent             | skillRefs                                                                                  | output_dir         |
| ----------------- | ------------------------------------------------------------------------------------------ | ------------------ |
| research.md       | 无                                                                                         | `.aether/research` |
| research-worker   | 无                                                                                         | `.aether/research` |
| research-explorer | `[paper-search]`                                                                           | `.aether/research` |
| research-verifier | `[research-verification]`                                                                  | 无                 |
| judgment-worker   | 无                                                                                         | `.aether/research` |
| local-executor    | `[]`                                                                                       | `.aether/research` |
| gpd-reviewer      | `[gpd-errors, gpd-conventions, gpd-domain-check]`                                          | 无                 |
| gpd-verifier      | `[research-verification, gpd-verification, gpd-errors, gpd-domain-check, gpd-conventions]` | 无                 |

> **`skill: allow` 现状（与 eager 是否生效直接相关）**：research-explorer 已有 `skill: allow`（eager 实际生效）；gpd-verifier / gpd-reviewer / research-verifier 均 `"*": deny` 且无 `skill: allow`（eager 为死代码，见 §1.1 勘误）；research-worker / research.md / judgment-worker / local-executor 无 `skill_refs`，其 `skill: allow` 与 eager 注入无关、本层不动。本层需为前述 3 个缺 `skill: allow` 的 agent 补齐，见 §4.2/§5.4。

---

## 2. 当前实现追踪

- `Config.Agent` schema：`config.ts`（`skill_refs`、`output_dir` 字段 + transform `knownKeys` 中的 `"skill_refs"`/`"output_dir"`）
- `Agent.Info` schema：`agent.ts:50`（`skillRefs`）、`agent.ts:73`（`outputDir`）
- merge 循环：`agent.ts:290`（`item.skillRefs = value.skill_refs ?? item.skillRefs`）、`agent.ts:298`（`item.outputDir = value.output_dir ?? item.outputDir`）
- `SystemPrompt.skills` eager 分支：`system.ts:60-78`
- `SystemPrompt.outputDir` / `normalizeOutputDir`：`system.ts:88-97`
- system prompt 拼装处 `od` 注入：`prompt.ts:675`（`const od = SystemPrompt.outputDir(agent)`）、`prompt.ts:679`（`...(od ? [od] : [])`）
- skill 工具基目录返回（**保留不动**）：`tool/skill.ts:85-86, 116-117`
- MCP server `get_config`：`.aether/mcp/research-state/server.py:1633-1634`（从 frontmatter 读取 `skill_refs`/`output_dir` 并返回到响应 dict）
- MCP server `_check_skill_chain`：`server.py:1054`（硬编码 `skill_refs_map` 字典，变量名引用已删字段；`:1074` 迭代）

---

## 3. 修复方案：删除 + 回落 + 软提示

### 设计哲学：用 agent 的正常行为替代硬编码装备

- **可见性**：仍由 Layer 1.1 的 `owner`/`owns` 闸门 + `skill` 权限 + `Skill.available` 提供（与 build/plan 完全一致）。research 子 agent 看到 owner 匹配的 skill 列表。
- **加载**：按需经 skill 工具加载（与所有普通 agent 一致），加载即得全文 + 基目录 + 文件清单。
- **引导**：原本靠 skillRefs "确定性装备" 的关键 skill，改为在 agent prompt 正文里写一句**软提示**（"凡涉及 X，先调用 Y skill"），依赖 LLM 遵从——这正是通用 agent 系统的引导方式，而非施工流程的硬注入。

不引入 `mandatory_skills`、不保留白名单字段、不保留 eager 注入字段。字段越少，agent 越像可灵活配置的通用组件。

### 软提示措辞原则

- 写在 agent `.md` 的 prompt 正文（body），不进 frontmatter。
- 建议性而非强制性语气（"You should load the X skill when..."），与 system prompt 里 `"Use the skill tool to load a skill when a task matches"` 的基调一致。
- 只点名 skill，不复制 skill 全文（全文由 skill 工具按需返回）。

> **与已有正文的重叠**：多个 agent 的 prompt 正文已包含输出目录约束（如 research-explorer.md:118 "path MUST be within .aether/research/"、research-worker.md:39 "edit/write within .aether/research"、judgment-worker.md:28 "any file under .aether/research"）。§4.2 新增的输出目录软提示与这些既有文本部分重叠。保留这种重复提示是合理的——既有文本是行为约束（FORBIDDEN/HARD CONSTRAINT 语境），新增软提示是产出归集引导，两者互补而非冲突。**例外：judgment-worker 为 READ-ONLY 叶子 agent，返回结构化 YAML、禁止写任何文件，故不对其加输出目录软提示**（见 §4.2 表注），其 `output_dir` frontmatter 字段删除后无替代。

> **skill 内部 `output_dir` 占位符的语义变化**：部分 skill 的 SKILL.md 使用 `output_dir` 作为路径占位符——`literature-review/SKILL.md` 写 `output_dir/notepads/<slug>/review.md`（行 22-24/139/142）、`paper-search/SKILL.md` 写 `<output_dir>/<arxiv_id>/`（行 142）。此前 system prompt 注入的绝对路径句（`Your output directory is at <abs>`）为 agent 提供了将 skill 内 `output_dir` 占位符解析为绝对路径的锚点。删除注入后，agent 需依靠 prompt 正文软提示中的相对路径 `.aether/research/` 自行关联 skill 内的 `output_dir` 占位符——这是回落通用机制的固有代价，可接受但需知晓。

---

## 4. 改动清单

### 4.1 代码（5 文件）

**改动 1: `SystemPrompt.skills` 删除 eager 分支**

文件：`packages/opencode/src/session/system.ts`

删除 `system.ts:60-78`（`if (agent.skillRefs?.length) { ... }` 整个 eager 分支），只保留 lazy 分支：

```ts
export async function skills(agent: Agent.Info) {
  if (Permission.disabled(["skill"], agent.permission).has("skill")) return

  const list = await Skill.available(agent)
  return [
    "Skills provide specialized instructions and workflows for specific tasks.",
    "Use the skill tool to load a skill when a task matches its description.",
    Skill.fmt(list, { verbose: true }),
  ].join("\n")
}
```

**改动 2: 删除 `outputDir` / `normalizeOutputDir`**

文件：`packages/opencode/src/session/system.ts`

删除 `system.ts:88-97`（`normalizeOutputDir` 函数 + `outputDir` 函数）。删除后 `system.ts` 不再使用 `path` / `pathToFileURL`——二者仅被 eager 分支（`:71` 的 `pathToFileURL`/`path.dirname`）与 `normalizeOutputDir`（`:91` 的 `path.join`）消费，`environment()` 等其余函数不引用——故一并删除 `import path`（`:4`）与 `import { pathToFileURL }`（`:5`）。

**改动 3: system prompt 拼装处删除 `od`**

文件：`packages/opencode/src/session/prompt.ts`

删除 `prompt.ts:675`（`const od = SystemPrompt.outputDir(agent)`）与 `prompt.ts:679`（`...(od ? [od] : [])`）。`system` 数组恢复为 `[...environment, ...(skills ? [skills] : []), ...InstructionPrompt.system()]`。

**改动 4: schema + merge 删除两字段**

文件：`packages/opencode/src/agent/agent.ts`

- `Agent.Info` schema 删除 `skillRefs: z.array(z.string()).optional(),`（`agent.ts:50`）与 `outputDir: z.string().optional(),`（`agent.ts:73`）
- merge 循环删除 `item.skillRefs = value.skill_refs ?? item.skillRefs`（`agent.ts:290`）与 `item.outputDir = value.output_dir ?? item.outputDir`（`agent.ts:298`）

文件：`packages/opencode/src/config/config.ts`

- `Config.Agent` schema 删除 `skill_refs`（`:872`）与 `output_dir`（`:901`）字段
- transform `knownKeys` 集合删除 `"skill_refs"` 与 `"output_dir"`

**改动 5: MCP server 清理 `skill_refs`/`output_dir` 引用**

文件：`.aether/mcp/research-state/server.py`

两处改动：

1. **`get_config` 工具（`:1607-1653`）**：删除响应 dict 中的 `"output_dir": fm.get("output_dir", ""),`（`:1633`）与 `"skill_refs": fm.get("skill_refs", []),`（`:1634`）两行。删除后 `fm.get("skill_refs"...)`/`fm.get("output_dir"...)` 两处调用消失——`get_config` 不再从 frontmatter 读取这两个已删字段，响应不再携带死字段。同时更新 docstring（`:1610` `Includes agent definitions, MCP config, skills.paths, and output_dir settings.`）删除 "and output_dir settings" 字样。

2. **`_check_skill_chain` 函数（`:1050-1080`）**：将硬编码变量 `skill_refs_map`（`:1054`）重命名为 `expected_skill_chain`（同步更新 `:1074` 的 `for key, skill_name in skill_refs_map.items():` 引用）。此变量是硬编码的 SKILL.md 存在性检查清单，**不读 frontmatter**——它列出每个 agent 预期可访问的 skill，删除 `skill_refs` 字段后这些 skill 仍经 skill 工具可达，检查表内容不变。重命名仅为消除对已删字段的命名引用。函数内注释如有 `skill_refs` 字样一并替换。

### 4.2 Frontmatter（agent 定义迁移）

`.aether/agent/*.md`：删除 frontmatter 中的 `skill_refs:` 与 `output_dir:` 键，改写为 prompt 正文软提示。

| 文件                   | 删除 frontmatter               | prompt 正文新增软提示                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `research.md`          | `output_dir`                   | "Write all research artifacts to `.aether/research/`."                                                                                                                                                                                                                                                                                           |
| `research-worker.md`   | `output_dir`                   | "Write all research artifacts to `.aether/research/`."                                                                                                                                                                                                                                                                                           |
| `research-explorer.md` | `skill_refs`、`output_dir`     | "For any literature/paper lookup, load the `paper-search` skill first." + 输出目录句                                                                                                                                                                                                                                                             |
| `research-verifier.md` | `skill_refs`                   | "For verification protocol, load the `research-verification` skill."                                                                                                                                                                                                                                                                             |
| `judgment-worker.md`   | `output_dir`                   | **不加输出目录软提示**——该 agent 为 READ-ONLY（permission `*` deny + 仅 read/grep/glob/list），返回结构化 YAML 作为最终消息、禁止写任何文件（prompt 正文多处 HARD CONSTRAINT 反复申明 "no file writes"）。输出目录概念对其无意义，加软提示反而与 READ-ONLY 约束自相矛盾、制造文件内部歧义。其 `file_scope: .aether/research/**` 已限定读取范围。 |
| `local-executor.md`    | `skill_refs: []`、`output_dir` | 输出目录句（无 skill 提示，本就无 skill）                                                                                                                                                                                                                                                                                                        |
| `gpd-reviewer.md`      | `skill_refs`                   | "For physics peer review, load `gpd-errors`, `gpd-conventions`, `gpd-domain-check` skills."                                                                                                                                                                                                                                                      |
| `gpd-verifier.md`      | `skill_refs`                   | "For physics SymPy verification, load `gpd-verification`, `gpd-errors`, `gpd-domain-check`, `gpd-conventions`, `research-verification` skills."                                                                                                                                                                                                  |

**prompt 正文残留清理（非 frontmatter）**：`research.md:164-166` 正文当前含 `Path 3 subagent: research-worker ONLY (with skill_refs for paper-search, health-check, debate-advocate, debate-critic, debate-adjudicator, debate-repair)`——其中 `with skill_refs for ...` 是对已删字段的残留引用，且本就与现状矛盾（research-worker frontmatter 并无 `skill_refs`）。一并改写为 `Path 3 subagent: research-worker ONLY (with access to paper-search, health-check, debate-advocate, debate-critic, debate-adjudicator, debate-repair skills)`，消除 `skill_refs` 字样。

**`skill: allow` 权限补齐（3 个 agent，强制改动）**：`gpd-verifier.md` / `gpd-reviewer.md` / `research-verifier.md` 的 `permission` 块当前为 `"*": deny` 且缺 `skill: allow`。如 §1.1 勘误所述，`system.ts:58` 权限闸门 + `prompt.ts:1007-1012` deny-filter 双重拦截 skill——既无 skill 列表、也无 skill 工具，故 §4.2 表中给这三个 agent 写的软提示（"load gpd-verification skill" 等）在补齐前**不可执行**。本层在三者 frontmatter 的 `permission` 块新增一行 `skill: allow`（与 research-explorer / research-worker 一致），使其回落正常 skill 机制后能看列表、调工具。这是软提示方案对这三个 agent 生效的**硬前置**，非可选核查项。

| 文件                   | permission 块新增                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `gpd-verifier.md`      | `skill: allow`（插在 `codesearch: allow` 与 `external_directory: ask` 之间，对齐既有顺序）                                     |
| `gpd-reviewer.md`      | `skill: allow`（插在 `bash: allow` 之后——该 agent permission 块无 `codesearch`/`external_directory`，故紧跟最后一个 allow 项） |
| `research-verifier.md` | `skill: allow`（插在 `codesearch: allow` 与 `external_directory: ask` 之间，对齐既有顺序）                                     |

frontmatter 中 `owner`/`owns`/`mcp`/`fallback_models` 等**不动**（属其他层）。`permission` 块除上述 3 处补 `skill: allow` 外不动。

### 4.3 总计

**5 代码文件 + 8 agent md 文件（删 frontmatter；7 个加软提示、judgment-worker 因 READ-ONLY 不加；其中 3 个另需在 `permission` 块补 `skill: allow`）**。核心代码净删约：system.ts ~30 行、prompt.ts 2 行、agent.ts 4 行、config.ts ~12 行、server.py 2 行 + 重命名 1 变量。新增核心代码 0 行（`skill: allow` 为 frontmatter，非代码）。

**不改的东西**：

- `tool/skill.ts`（基目录 + 文件清单返回是 lazy 可行的前提，保留）
- Layer 1.1 `owner`/`owns` 域可见性闸门（与 skillRefs 无关，保留）
- `Skill.available` / `Skill.fmt` / `Skill.get` / `Skill.all`
- `Skill` schema 的 `owner` 字段（Layer 1.1）
- `.aether/skills/**/SKILL.md`（24 个 skill 定义零改动。注意：部分 skill 如 `literature-review`、`paper-search` 使用 `output_dir` 作为路径占位符，语义变化见 §3 软提示措辞原则的说明，本层不改 skill 文件本身）
- seeding 流程、`Permission` / `Discipline` 机制
- `server.py` 的 `output_dir_default`（`:1649`）与 `OUTPUT_DIR`（`:1656`）常量（项目级默认输出目录，非 agent 字段，保留）

---

## 5. 设计决策与权衡

### 5.1 为何不保留 `mandatory_skills` 指令标记（早先 layer-1.2 方案）

早先 layer-1.2 提出"lazy 白名单 + `mandatory_skills` 指令标记"双字段模型，仍是为了给 gpd-verifier 的"5 skill 必须**同时**遵循"提供确定性。未采纳，理由：

1. 双字段仍是 schema 复杂度，与"更像通用 agent"目标相悖。
2. skill 工具已返回基目录（§1.3），eager 注入的独占能力（脚本访问）已被 lazy 覆盖。
3. "必须同时遵循"用 prompt 软提示同样可表达，且更灵活（agent 可按任务实际需要调整加载顺序）。
4. mandatory_skills 的"指令标记"本就依赖 LLM 遵从（非确定性强制），与其维护一个字段，不如直接写进 prompt 正文。

### 5.2 软提示的可靠性

软提示依赖 LLM 遵从，本场景风险可控：

1. **可见集已由 owner/owns 隔离**——research 子 agent 只看到 research 域 skill，无 build/plan 噪声干扰选择。
2. **任务本身需要这些 skill**——gpd-verifier 的职能就是物理验证，所列 skill 是其工作前提，LLM 无理由跳过。
3. **system prompt 已有引导**——`"Use the skill tool to load a skill when a task matches its description"` 是所有 agent 共有的基线引导，agent 正文软提示是其强化。
4. **加载即得全文 + 脚本目录**——即便漏载一次，任务推进受阻时 LLM 会回溯加载（agent 的正常自我修正行为）。

残留风险：LLM 漏载某个 skill。这与所有普通 agent 面临的"是否调对 skill"风险等同，是通用 agent 系统的固有特性，可接受。

### 5.3 为何 outputDir 不改成"自动建目录"而直接删

outputDir 当前只是 prompt 文本，不建目录、不约束写入。若未来需要"agent 产物自动归集到固定目录"的**硬约束**，应作为独立机制设计（如 write 工具的 file_scope 已能约束写入路径，见 `Discipline.compile` 的 `file_scope`），而非借一个 prompt 文本字段。本次只做"删除侵入核心代码的 prompt 注入"，不引入新机制。

### 5.4 `skill: allow` 权限补齐（本层强制改动，非旁支）

gpd-verifier / gpd-reviewer / research-verifier 的 `permission` 块为 `"*": deny` 且缺 `skill: allow`。删除 eager 注入后，skill 访问须经两道闸门：

1. **列表闸门** `system.ts:58`：`Permission.disabled(["skill"], agent.permission).has("skill")`——对 `*: deny` 规则，`Wildcard.match("skill","*")`=true、`pattern==="*" && action==="deny"` → 返回 true → `SystemPrompt.skills` return undefined（无 skill 列表）。
2. **工具闸门** `prompt.ts:1007-1012` deny-filter：`Permission.evaluate("skill","*",effectivePermission)` 命中 `*: deny` → action=deny → skill 工具被删（即便改用 `disabled`，`disabled(["skill"])` 对 `*: deny` 同样返回 disabled，结论不变）。

且 dispatch 时的 `Permission.intersection`（`permission/index.ts:294-319`）**不继承 caller 的 `skill: allow`**：其主循环只处理 child 自身规则，末尾清理循环只补 parent 的 deny 规则——故 research-worker（有 `skill: allow`）dispatch gpd-verifier，gpd-verifier 仍无 skill 访问。

结论：这三者若不补 `skill: allow`，§4.2 写的软提示不可执行、§6 预期的"skill 列表"不会出现。故补 `skill: allow` 是本层**强制交付项**（已在 §4.2 列出具体改动），而非"落地时再核查"。Layer 1.4（删 Discipline）与此正交——`*: deny` 来自 agent 自己的 frontmatter、非 `Discipline.compile` 生成，删 Discipline 既不让 `skill: allow` 失效、也不放行 skill；故不能借 Layer 1.4 解决，必须在本层 frontmatter 显式补齐。

### 5.5 与 Layer 1.1 的关系

Layer 1.1 的 `owner`/`owns` 闸门在 `Skill.available` 与 `SkillTool.execute` 两处过滤，与 skillRefs 无关。删除 skillRefs 后，owner/owns 仍独立生效：research 域 skill 只对 `owns:[research]` 的 caller 可见；build/plan 仍看不到。两者正交，互不影响。

---

## 6. 影响面核对

| 场景                                              | 预期                                                                                                   | 依据                                                             |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| research-explorer 的 system prompt                | `<available_skills>` 列表（owner 过滤后），无 paper-search 全文                                        | eager 分支删除，走 lazy 分支                                     |
| research-explorer 用 skill tool 加载 paper-search | 正常，返回全文 + 基目录 + 文件清单                                                                     | `tool/skill.ts:116-117`，未改                                    |
| gpd-verifier 的 system prompt                     | **现状**：无列表无全文（`*: deny` 挡闸）；**改后**：skill 列表（owner 过滤后）、无 5 skill 全文        | `system.ts:58` 闸门 + §4.2 补 `skill: allow`                     |
| gpd-verifier 用 skill tool 加载 gpd-verification  | **现状**：skill 工具被删；**改后**：正常，返回 SymPy 脚本目录                                          | deny-filter + §4.2 补 `skill: allow`；`tool/skill.ts:85-86` 未改 |
| gpd-verifier prompt 正文                          | 含软提示列出 5 个 skill 名（软提示需 `skill: allow` 才可执行）                                         | §4.2 frontmatter 迁移 + `skill: allow` 补齐                      |
| research-worker（无 skill_refs）system prompt     | skill 列表，不变                                                                                       | 本就无 skillRefs，行为不变                                       |
| research.md（primary）system prompt               | 不再含 outputDir 句，改由 prompt 正文表达                                                              | `od` 注入删除                                                    |
| 产物写入目录                                      | 可写 agent 按 prompt 正文软提示写 `.aether/research/`；judgment-worker 为 READ-ONLY 不写文件、无软提示 | 软提示 + env 块 workspace root；judgment-worker 见 §4.2 表注     |
| build/plan 的 system prompt / skill 工具          | 不含 research skill（owner 闸），不变                                                                  | Layer 1.1 不受影响                                               |
| `Agent.Info`/`Config.Agent` schema                | 不再有 `skillRefs`/`outputDir`/`skill_refs`/`output_dir`                                               | §4.1 改动 4                                                      |
| `.aether/skills/**/SKILL.md`                      | 零改动                                                                                                 | skill 定义与字段无关                                             |
| MCP `get_config` 响应                             | 不再含 `skill_refs`/`output_dir` 字段                                                                  | §4.1 改动 5                                                      |
| MCP `_check_skill_chain`                          | 变量 `skill_refs_map` 重命名为 `expected_skill_chain`，检查内容不变                                    | §4.1 改动 5                                                      |

---

## 7. 验收清单

### 7.1 删除生效

1. `Agent.Info` schema 不含 `skillRefs`/`outputDir`；`bun typecheck` 在 `packages/opencode` 通过
2. `Config.Agent` schema 不含 `skill_refs`/`output_dir`；transform `knownKeys` 不含两者
3. `SystemPrompt.skills` 无 eager 分支，只有 lazy 分支
4. `system.ts` 不含 `normalizeOutputDir`/`outputDir`
5. `prompt.ts` system 拼装不含 `od`
6. 全仓 `rg "skillRefs|output_dir|skill_refs|outputDir"` 在 `packages/opencode/src` 下无命中（测试文件除外）。**注意排除同名无关符号**：`pdf-converter/{types,index,util,markdown-assembler,pdf-renderer}.ts`、`markdown-translator/{index,types}.ts`、`server/routes/file.ts` 中的 `outputDir`/`output_dir` 是 PDF/翻译/文件路由的本地参数与 HTTP query schema，与 agent 字段无关，不属本层删除范围。为避免误报，建议收窄正则为 `agent\.skillRefs|item\.skillRefs|value\.skill_refs|agent\.outputDir|item\.outputDir|value\.output_dir|SystemPrompt\.outputDir|normalizeOutputDir`。
7. MCP server `.aether/mcp/research-state/server.py` 的 `get_config` 响应不含 `skill_refs`/`output_dir` 字段；`_check_skill_chain` 中变量名为 `expected_skill_chain`（非 `skill_refs_map`）。验证命令：`rg 'skill_refs|"output_dir"' .aether/mcp/research-state/server.py`（加引号匹配 dict key，排除 `output_dir_default` 和 `OUTPUT_DIR` 这两个项目级常量——它们与 agent 字段无关，保留）。预期仅命中 `expected_skill_chain` 注释中的历史引用（如有），无 frontmatter 读取或响应字段。

### 7.2 行为回落

8. research-explorer 的 system prompt 含 `<available_skills>` 列表、不含任何 skill `content` 全文
9. research-explorer 用 skill tool 加载 paper-search，返回含 `Base directory` + `<skill_files>`
10. gpd-verifier 的 system prompt 含 skill 列表（补 `skill: allow` 后）、不含 5 skill 全文；其 prompt 正文含软提示列出 5 skill 名
11. gpd-verifier 的 `permission` 块含 `skill: allow`；用 skill tool 加载 gpd-verification 成功（对比现状：skill 工具被 deny-filter 删除）
12. research.md / research-worker.md 的 system prompt 不含 outputDir 句；其 prompt 正文含输出目录句

### 7.3 不回归

13. Layer 1.1 owner/owns 闸门不受影响：build/plan 仍看不到 research skill
14. research-worker 通过 skill tool 加载 autoresearch/deep-research 等 state machine skill 正常（无 skillRefs，本就走 lazy）
15. Path 3：research → research-worker → 叶子 全链路 dispatch 正常
16. MCP `get_config` 调用正常，health-check 的 `_check_skill_chain` 检查结果不受影响（检查内容不变，仅变量重命名）
17. seeding 把改后的 .md 正常同步到 `~/.aether/`，无报错

---

## 8. 测试策略

### 8.1 现有测试更新

| 测试文件                                       | 改动                                                                                                                                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/layer-0/skill-refs-injection.test.ts`    | **删除或重命名**：skillRefs 注入已不存在。若保留，改为断言 `SystemPrompt.skills` 走 lazy 分支、不注入全文                                                                       |
| `test/layer-0/agent-info-extensions.test.ts`   | 删除 `skillRefs`/`outputDir` 字段断言                                                                                                                                           |
| `test/layer-2/research-subagents.test.ts`      | 删除 `skillRefs`/`outputDir` 值断言。注意 `:97` 测试描述字符串含 `skill_refs`（`T2.14: gpd-reviewer with gpd skill_refs`），一并改写为不含字段名的措辞                          |
| `test/layer-2/research-primary.test.ts`        | 删除 `outputDir` 断言                                                                                                                                                           |
| `test/layer-1/skill-refs-url.test.ts`          | 改为验证 skill 工具返回基目录（非 skillRefs 路径），保留该断言价值                                                                                                              |
| `test/layer-1/output-dir.test.ts`              | **整文件删除**：被测对象 `SystemPrompt.outputDir`/`normalizeOutputDir` 与 `output_dir` schema 已不存在                                                                          |
| `test/layer-2/config-load-order.test.ts`       | 删除内联 `skill_refs`/`output_dir` config（行 154/156/168/169）与 `agent?.skillRefs`/`agent?.outputDir` 断言（行 182-183）                                                      |
| `test/layer-2/skills-and-file-loading.test.ts` | 删除内联 `output_dir`/`skill_refs` config（行 71/121/168）与 `r?.outputDir`/`e?.skillRefs` 断言（行 89/139）                                                                    |
| `test/layer-2/fixture.ts`                      | 删除所有内联 config 中的 `skill_refs`（行 68/95/121/143）与 `output_dir`（行 46）。此 fixture 为多个 layer-2 测试提供 `Config.Agent` 对象，删除字段后这些 config 不再携带已删键 |
| `test/layer-0/discipline-compile.test.ts`      | **无需改动**：行 58 仅在测试描述字符串里出现 "output_dir"（`file_scope denies nested output_dir paths`），无字段断言                                                            |

### 8.2 新增测试点

- `SystemPrompt.skills`：任意 agent（含原 skillRefs 的）都走 lazy 分支，输出含 `Skill.fmt` 列表、不含 skill `content`（已覆盖：`skill-refs-injection.test.ts`）
- `SystemPrompt` 拼装：不含 outputDir 句（结构保证：`outputDir` 函数与 `od` 注入均已删除）
- schema：`Agent.Info`/`Config.Agent` parse 时 `skill_refs`/`output_dir` 键被忽略（进 options 或丢弃），不报错（已覆盖：`config-load-order.test.ts`）
- **`skill: allow` 补齐生效**：构造 gpd-verifier config（`*: deny` + `skill: allow`），断言 `Permission.disabled(["skill"], permission)` 返回空集（skill 不被禁）、`evaluate("skill","*",...)` ≠ deny；且 `SystemPrompt.skills` 返回列表（非 undefined）（已覆盖：`skill-refs-injection.test.ts` 的 `*: deny + skill: allow yields skill list` 测试）
- **MCP server 清理**：调用 `get_config` MCP 工具，断言响应中 agents 列表的每个 agent 不含 `skill_refs`/`output_dir` 键；`_check_skill_chain` 正常返回（变量已重命名，检查内容不变）（Python 侧，待 MCP 测试覆盖）

### 8.3 手动验证

1. 应用改动后重启，确认 `~/.aether/agent/*.md` 已删 `skill_refs`/`output_dir`、可写 agent 的 prompt 正文含输出目录软提示（judgment-worker 除外——READ-ONLY 不加）；gpd-verifier/gpd-reviewer/research-verifier 的 `permission` 块含 `skill: allow`
2. 切换到 gpd-verifier（经 research-worker dispatch），检查 system prompt 含 skill 列表（对比现状：无列表）、无全文，prompt 正文含 5 skill 软提示
3. 在 gpd-verifier 内用 skill tool 加载 gpd-verification，确认返回含 SymPy 脚本目录（对比现状：skill 工具不可用）
4. 切换到 research-explorer，确认 system prompt 含 skill 列表、prompt 正文含 paper-search 软提示 + 输出目录句
5. 调用 MCP `get_config`，确认响应不含 `skill_refs`/`output_dir` 字段；触发 health-check，确认 `_check_skill_chain` 结果不受影响
6. `bun typecheck` 通过

### 8.4 历史文档说明

以下历史设计文档仍含 `skill_refs` eager 注入 / `output_dir` 相关描述，本次**不做修改**（保留历史变更记录）：

- `docs/agent-docs/layer-0-core-security.md`
- `docs/agent-docs/layer-1.1-subagent-ownership.md`（§2.3 skillRefs 语义表等）
- `docs/agent-docs/research-agent-v2-overview.md`
- `docs/agent-docs/layer-3-research-infrastructure.md`
- `docs/agent-docs/layer-3.3-context-isolation.md`
- `docs/agent-docs/layer-3.5-environment-isolation.md`
- `docs/agent-docs/layer-3.6-health-check.md`
- `docs/agent-docs/layer-3.8-debate-phase.md`
- `docs/agent-docs/layer-4-publication-pipeline.md`
- `docs/agent-docs/layer-5-background-execution.md`
- `docs/agent-docs/layer-1.4-remove-discipline.md`（已自注 "Layer 1.2 删，非本文"，无需改动）
- `docs/agent-docs/layer-1.6-simplify-uv-install.md`

> **`docs/agent-docs/research-agent-runtime-design.md` 需注明**：该文档行 341 将 "skill_refs 替换" 列为 `research-agent-v2-overview.md` 的关键设计决策摘要。此描述已过时——`skill_refs` 已删除，回落正常 skill 机制 + 软提示。**需在该文档对应处加注**（如脚注或行内括注）："`skill_refs` 已于 Layer 1.2 删除，见 `layer-1.2-skill-refs-removal.md`"，避免读者误以为 `skill_refs` 仍为现行机制。

**以本文档为准**：`skillRefs`/`outputDir` 已删除，回落正常 skill 机制 + prompt 软提示。查阅上述历史文档时请以此为准。
