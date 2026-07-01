# Layer 4: Publication Pipeline

> 前置依赖: Layer 0-3（核心安全 + Agent 基础设施 + Research 配置 + MCP 服务器 + Skills/Scripts 计算层）
> 本文档是 5 层重构计划的第四层。置于 research 命名空间下（`owner: research`），复用 research-conventions MCP、research-explorer（承载 paper-search）。
> publication 仅从 `owns: [research]` 的 agent（即 research primary）可达。经 **publication-worker**（专属 subagent）承载，publication-worker 加载 write-paper skill 并在隔离上下文中执行编排逻辑。

---

## 上下文

| Layer       | 状态            | 简介                                                       |
| ----------- | --------------- | ---------------------------------------------------------- |
| Layer 0     | 已完成          | Permission/Discipline/Info 扩展、skill_refs                |
| Layer 1     | 已完成          | output_dir、fallback_models、MCP per-agent、denied tools   |
| Layer 1.1   | 已完成          | owner/owns 组件域可见性闸门                                |
| Layer 2     | 已完成          | Research 配置层（agent/skill md，零核心源改动）            |
| Layer 3     | 已完成          | MCP 服务器 + Skills/Scripts 计算层                         |
| **Layer 4** | **本文档**      | Publication 管线（write-paper skill, mode=write\|respond） |
| Layer 5     | 在 Layer 4 之后 | Background 执行                                            |

---

## 设计原则

- **复用 research 基础设施**：所有 agent/skill 为 `owner: research`，复用 `research-conventions` MCP、`research-explorer`（承载 paper-search skill）。publication 不使用 gpd-\* skill——物理验证是 Path 3 的职责，Path 4 只审核文章表述。
- **单一 skill，双模式**：`write-paper` skill 通过 `mode=write|respond` 区分起草新稿与回复审稿。两模式共用同一条 `Reviewer→Referee→Writer` 循环，差异仅在首轮入口与是否维护 response.tex。
- **编排 skill 经由 publication-worker 承载**：Coordinator 不直接加载 publication skill 内容，而是 dispatch **publication-worker**（Path 4 专属 subagent），publication-worker 加载 write-paper skill 并在隔离上下文中执行编排逻辑。publication-worker **不是** research-worker — 它没有 Path 3 state machine 上下文，旁路是结构性的而非禁止性的（见 §4.3.5 + 附录 §A.1）。
- **State machine 旁路**：publication 是独立工作流 — 不调 `advance_plan`、不经 `validate_file_locations`、不读写 `state.json`。版本历史由 publication 目录下的 manifest.json 管理。脱离 state machine 的必要性论证见 §4.1.5（控制流根本不匹配）。
- **角色职责分离**：
  - **publication-worker**（编排层）：加载 write-paper skill，编排 Reviewer→Referee→Writer 循环 + checkpoint 管理 + manifest.json 维护。Path 4 专属，不经 state machine
  - **paper-writer**（执行层）：只读 modification-list.md（纯执行指令）→ 改 manuscript.tex → 记录 drafting_reasoning.md。需要图表时 dispatch paper-illustrator
  - **paper-reviewer**（检测层）：只审稿件质量（+ response.tex 一致性）→ 产出 review.md。不接触外部 comments，不接触 modification 文件
  - **paper-referee**（裁决+翻译层）：读 review.md + 外部 comments → 裁决每条 issue → 产出 modification-list.md（给 writer）+ modification-reasoning.md（推理+traceability，审计用）+ response.tex（对外部意见的回复）
  - **paper-illustrator**（图表生成层）：接收 writer 的 figure_spec → 从 notepads 数据生成图表（PDF+LaTeX snippet）→ 返回给 writer 插入稿件。纯叶子节点，隔离上下文
- **最小人类介入**：用户只在常规检查点（大纲确认、最终修订版审查）+ 条件性升级（cap+FATAL）介入。
- **版本管理**：每次修订生成版本快照 + CHANGELOG，manifest.json 追踪版本历史。

---

## 架构总览

```
.aether/
├── agent/
│   ├── publication-worker.md      # 新增 — 编排层 (Path 4 专属 subagent)
│   ├── paper-writer.md           # 新增 — 执行层
│   ├── paper-reviewer.md         # 新增 — 检测层
│   ├── paper-referee.md          # 新增 — 裁决+翻译层
│   └── paper-illustrator.md      # 新增 — 图表生成层
├── skills/
│   ├── write-paper/              # 新增 — 编排 skill (mode=write|respond)
│   │   ├── SKILL.md
│   │   └── references/
│   │       ├── dispatch-prompts.md     # 统一 dispatch 模板
│   │       ├── respond-mode.md         # respond 特有逻辑
│   │       ├── version-schema.md       # 统一版本 schema
│   │       ├── edge-cases.md           # 统一边界情况
│   │       └── latexmk-verification.md # latexmk 可用时的编译验证增强
│   └── paper-template/           # 新增 — 模板系统 skill
│       ├── SKILL.md
│       ├── templates/
│       │   ├── prl.tex           # 占位骨架
│       │   ├── prd.tex
│       │   ├── jhep.tex
│       │   └── template_registry.json
│       └── scripts/
│           └── validate_template.py
└── research/
    └── publication/              # 运行时产物目录（单项目，无子目录层）
        ├── manifest.json
        ├── manuscript.tex
        ├── drafting_reasoning.md
        ├── modification-list.md
        ├── modification-reasoning.md
        ├── references.bib
        ├── review.md
        ├── response.tex          # [respond mode]
        ├── templates/            # [discovered/synthesized 模板]
        ├── figures/              # paper-illustrator 产出
        │   ├── fig01.pdf
        │   ├── fig01.png
        │   ├── fig01.tex
        │   └── fig01_gen.py
        └── versions/
            └── v[N]/
                ├── manuscript.tex
                ├── drafting_reasoning.md
                ├── modification-list.md
                ├── modification-reasoning.md
                ├── response.tex      # [respond mode]
                └── CHANGELOG.md
```

---

## 4.1 跨文件改动

Layer 4 除新增 agent/skill 文件外，需修改以下现有文件。

### 4.1.1 `.aether/agent/research.md` — Entry Gate 增 Path 4

#### 分类表新增一行

| Condition                                                                                         | Path                    | Workflow                                          |
| ------------------------------------------------------------------------------------------------- | ----------------------- | ------------------------------------------------- |
| Publication task（含"写论文"、"write paper"、"起草稿件"、"回复审稿"、"respond to referee"等意图） | **Path 4: Publication** | Dispatch publication-worker (mode=write\|respond) |

#### Path 4 分类规则

- 用户明确要求写论文/起草稿件，且无外部审稿意见文件 → `mode=write`
- 用户提供审稿意见文件，或明确要求回复审稿 → `mode=respond`
- 歧义时问用户

#### Path 4 与活跃项目短路规则的交互（关键修订）

现有 Entry Gate 规则：若 STATE.md 显示活跃项目（phase ≠ "not yet started"）→ **skip classification**。
此规则会阻断在 Path 3 进行中触发 Path 4。修订为：**活跃项目短路前先做 Publication Intent Scan**。

**修订后的 Gate Procedure**（替换现有 step 2）：

```
2. 读 STATE.md Current Phase:
   a. 若 "not yet started" → 走原分类流程（Path 0-4 全部参与）
   b. 若有活跃项目 → 执行 Publication Intent Scan（见下）：
      - 命中 publication 意图 → 执行 Path 3 完成度门控（见下）
      - 未命中 → 继续 Path 3 现有工作流（skip classification）
3. 【pending publication 发现】检查 .aether/research/publication/manifest.json:
   → 不存在或 manifest.json.workflow.status == "completed"/"aborted" → 无 pending，继续
   → manifest.json.workflow.status ∈ {"active","paused"} → 发现 pending publication
     → Ask User: "发现未完成的 publication 项目，当前在 [step] (iteration [N])。是否恢复？"
     → 用户确认 → 按 manifest.json.workflow 恢复（见 §4.6 Session Recovery）
     → 用户拒绝 → 标记该 manifest workflow.status="aborted"（用户可后续手动恢复）
```

> publication 的恢复入口**不依赖 STATE.md**——Entry Gate 直接检查
> `publication/manifest.json` 发现 pending。见 §4.1.1 STATE.md 不参与 publication + §4.7.3 manifest schema。

**Publication Intent Scan**（在活跃项目下仍执行）：

检测用户 prompt 是否包含 publication 意图关键词：
"写论文"、"write paper"、"起草稿件"、"投稿"、"submit"、"回复审稿"、"respond to referee"、"response letter"等。
活跃项目下此扫描是**轻量字符串/语义检测**，不重走完整分类流程。

**Path 3 完成度门控**（publication 意图命中后强制执行）：

| 检测场景                                 | 判定方法                                                                       | 门控动作                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| 同一 session 内（state.json.phase 可读） | 读 `state.json.phase`：`completed` → Path 3 已完成；其他值 → 进行中            | 进行中 → **禁止进入 Path 4**，告知用户"研究项目尚未完成（当前 phase: [X]），无法写论文。请先完成研究或显式中止 Path 3。" |
| 新 session（state.json.phase 可读）      | 同上：`completed` 为唯一放行值                                                 | 同上                                                                                                                     |
| state.json 缺失/损坏                     | 读 `persistence/EXECUTION.md` + `persistence/VERIFICATION.md` 是否存在且非模板 | 两者均存在且非模板 → 推断 Path 3 已完成，放行；否则禁止                                                                  |

> 门控的设计意图：publication 需要完整研究结果作为输入。Path 3 未完成时进入 Path 4 会得到空壳稿件。
> 用户若坚持在 Path 3 未完成时写论文，必须先显式中止/废弃当前 Path 3 项目（coordinator 提供选项）。

**write mode 额外检查**：进入 Path 4 前确认 `persistence/VERIFICATION.md` 非模板（含真实 verified results），否则降级为"基于不完整结果写稿"并 Ask User 确认。

**respond mode 额外检查**：确认用户提供的外部审稿意见文件路径存在且非空。

#### Path 4 执行

```
1. coordinator 确定 mode (write|respond)
2. dispatch publication-worker:
   task(description: "publication phase",
        subagent_type: "publication-worker",
        prompt: {
          mode: [write|respond],
          journal: "[journal key, write mode]",
          referee_comments: "[path, respond mode]"
        })
3. publication-worker 加载 /write-paper skill，按 mode 执行
   （注：Path 4 不 invoke /research-coordinator skill — 见 §4.1.3）
4. 遇到 checkpoint → publication-worker 返回 paused digest → coordinator 问用户
5. 完成后 → coordinator 展示最终产物
```

#### Path 4 digest 处理位置

Path 4 的 digest（`phase_result_digest.phase=phase_publication`）由 **research agent 自身处理**（在 research.md 中定义规则），**不**经由 `/research-coordinator` skill。原因：research-coordinator skill 是 Path 3 state machine 的编排器，而 publication 是独立工作流（见 §设计原则 + §4.1.5）。digest 处理规则：

- `status=completed` → Present 最终产物（不走 advance_plan / validate_file_locations / git commit 流程）
- `status=paused` → question tool 问用户（用 checkpoint 字段决定问题内容）
- `status=failed` → 告知用户失败原因

#### STATE.md 不参与 publication

publication **完全不写 STATE.md**。这是 §4.1.5 旁路原则的彻底贯彻：

- publication 的**唯一权威状态源**是 `publication/manifest.json` 的 `workflow` 块
  （见 §4.7.3 schema）。Entry Gate 通过检查 `publication/manifest.json` 发现 pending 项目，
  不依赖 STATE.md 转发。
- Path 3 仍在 STATE.md 中维护自己的状态，publication 不干涉、不复位、不写入。
- 这消除了"进入时写 path 4 标记、退出时复位"的不一致风险——STATE.md 在 publication
  期间保持 Path 3 原值不变。

### 4.1.2 `research-worker.md` — 零修改

publication-worker 是 Path 4 专属 subagent（见 §4.3.5），独立承载 publication 的
phase routing + digest schema。research-worker.md **不做任何修改**——它继续只服务
Path 3 state machine。这消除了"state machine executor 执行非 state machine 工作流"
的上下文污染问题（见附录 §A.1）。

### 4.1.3 Path 4 不 invoke `/research-coordinator` skill

Path 4 的 phase routing 与 digest 处理逻辑全部由 **research.md 自身承载**（见 §4.1.1）。research-coordinator SKILL.md 零修改，回退后无 publication 残留逻辑。论证见附录 §A.1。

### 4.1.4 publication 目录

publication 产物直接放在 `.aether/research/publication/`（无子目录层）。单项目假设：
`.aether/research/` 对应一个研究项目，publication 不引入多项目 slug 抽象。

paper-writer 读取 notepads 数据时 glob `notepads/*/execution/Qn_*.md`（单项目下命中唯一子目录）。
respond mode 的 baseline manuscript 发现：检查 `publication/manuscript.tex` 是否存在。

### 4.1.5 publication 脱离 state machine

publication 的控制流（数据驱动循环 + 双模式）与 state machine（顺序驱动线性 phase）根本不匹配。完整论证见附录 §A.1。

---

## 4.2 paper-template Skill（模板系统）

**文件**：`.aether/skills/paper-template/SKILL.md`

### 两层模板体系

**第一层：预设模板（Preset Tier）**

- 高能物理优先：`prl.tex`、`prd.tex`、`jhep.tex`（起步占位骨架，后续补完整）
- 每个 `.tex` 是可编译的最小骨架（documentclass + 必需包 + section 骨架 + 占位内容）
- `template_registry.json` 记录每个预设的元数据

**第二层：网络发现（Discovery Tier）** — 预设不足时触发

### 模板注册表 (`template_registry.json`)

```json
{
  "prl": {
    "full_name": "Physical Review Letters",
    "documentclass": "revtex4-2",
    "class_options": ["aps", "prl", "reprint", "floatfix"],
    "citation_style": "apsrev4-2",
    "section_structure": [
      "abstract",
      "introduction",
      "method",
      "results",
      "discussion",
      "conclusion",
      "acknowledgments"
    ],
    "figure_format": "single-column",
    "page_limit": 4,
    "source": "preset",
    "last_verified": "2026-06-19"
  }
}
```

### SKILL.md 核心结构

```yaml
---
name: paper-template
owner: research
description: |
  Journal LaTeX template management. Two-tier: preset templates (PRL/PRD/JHEP)
  + web-search discovery for journals without presets. Validates template
  structure.
---
```

```markdown
# Paper Template

## Mode 1: Get Preset Template

Read templates/template_registry.json. If journal key exists, load
templates/<journal>.tex as starting point. Return source="preset".

## Mode 2: Discover Template (no preset)

1. websearch "[journal] latex template author guidelines submission"
2. webfetch 官方 author guidelines 页面
3. 优先级: 官方 Overleaf 模板 > 期刊官网 .zip/CTAN > 第三方
4. 若找到可下载模板:
   a. 下载 → validate_template.py 验证结构
   b. 通过 → 安装到 **项目本地** .aether/research/publication/templates/<journal>.tex
   → 更新 **项目本地** registry (复制 paper-template registry 结构, source: "discovered")
   → 发 Notice: "已安装 [journal] 模板到项目本地目录"
   c. 失败 → 降级为合成 (Mode 2b)
5. 若无可下载模板 → 合成最小模板 (Mode 2b)

### Mode 2b: Synthesize Template

从 guidelines 提取: documentclass / class_options / citation_style / section_structure
生成骨架 .tex → validate_template.py 验证结构 →
安装到 **项目本地** .aether/research/publication/templates/<journal>.tex
→ 更新 **项目本地** registry (source: "synthesized")
→ 发 Notice: "已合成 [journal] 模板（未经编译验证），已安装到项目本地目录"

> **模板安装位置（安全模型修订）**：
> discovered/synthesized 模板**始终**写入项目内 file_scope 范围
> (.aether/research/publication/templates/)，由 edit/write 工具完成。
> **不再**用 bash 绕过 file_scope 写 ~/.aether/skills/ 目录。
>
> **公共复制（可选，用户确认后）**：
> 若用户希望将模板复用到其他项目，write-paper skill 在 Step 3 最终审查时
> 询问用户是否复制到公共路径 ~/.aether/skills/paper-template/templates/。
> 用户确认后，由 coordinator（research agent）执行 bash 复制
> （coordinator 的 file_scope 是 .aether/research/\*\*，bash 不受限，且这是
> 用户显式授权的一次性操作）。复制后更新公共 registry。
>
> 这一设计保证：
>
> - skill 运行时（paper-template/paper-writer）始终在 file_scope 内操作
> - 跨项目复用是用户显式决策，不是 skill 的默认行为
> - 无 file_scope 外的静默写入

## Mode 3: Validate Template

Run: uv run scripts/validate_template.py <template.tex>
Checks: documentclass present, \begin{document}/\end{document} paired,
citation style declared, no unclosed environments.

## Template Augmentation

Even with a preset, search for recent format changes before writing.
If format changed → update preset + bump last_verified date.
```

### `validate_template.py`

PEP 723 脚本（`# /// script` + `dependencies`），静态检查：

- `documentclass` 行存在
- `\begin{document}` / `\end{document}` 配对
- citation style 声明存在
- 无未闭合环境

---

## 4.3 Agent 定义

四个执行 agent（paper-writer/reviewer/referee/illustrator）统一 `owner: research`，deny-all + allow-list，`file_scope` 限制写操作到 `.aether/research/publication/**`。编排 agent publication-worker（§4.3.5）同样 `owner: research`，file_scope 一致。

### 4.3.1 paper-writer（执行层）

**文件**：`.aether/agent/paper-writer.md`

```yaml
---
description: Execute manuscript writing and revision from modification instructions
color: "#059669"
mode: subagent
owner: research
owns:
  - research
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  edit: allow
  write: allow
  bash: allow
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  task: allow
  skill: allow
  codesearch: allow
  external_directory: ask
  research_conventions_*: allow
skill_refs:
  - paper-template
fallback_models:
  - alibaba-cn/deepseek-v4-pro
  - alibaba-cn/qwen3.6-max-preview
mcp:
  research-conventions: true
output_dir: ".aether/research/publication"
file_scope:
  - ".aether/research/publication/**"
---
```

```markdown
<system-reminder>
# Paper Writer — Execution Layer

## Role

Execute manuscript writing and revision. You receive modification instructions
and apply them to manuscript.tex. You record the reasoning behind your writing
decisions in drafting_reasoning.md.

## HARD CONSTRAINTS

- MUST NOT write outside .aether/research/publication (file_scope) — bash included
  EXCEPTION: paper-template Mode 2 may write templates to project-local
  publication/templates/ (see §4.2)
- MUST NOT fabricate citations — every \cite{} must have a .bib entry
- MUST NOT fabricate references — use research-explorer (paper-search) for any new citation
- MUST NOT fabricate figures — every figure must be generated by paper-illustrator
  from verifiable data sources
- When dispatching subagents: ONLY dispatch research-explorer (delegation_depth: 0)
  AND paper-illustrator (delegation_depth: 0).
  FORBIDDEN: dispatching any other subagent.
- MUST NOT write manifest.json — workflow state is managed exclusively by
  publication-worker (write-paper skill context)

## Figure Generation Pipeline

When a section requires a figure:

1. writer 确定 figure_spec:
   - id: fig01, fig02, ...
   - type: line_plot | scatter | heatmap | histogram | bar | errorbar | contour
   - data_source: notepads/\*/execution/ 下的数据文件路径
     (从 Stage 2 读取中识别可绘图数据)
   - caption 概要 + manuscript 引用上下文（1-2 句）
2. 从 paper-template registry 读取 figure_format (e.g. single-column ≈ 3.4in)
   和 font_size (e.g. 8pt for PRL)
3. dispatch paper-illustrator (delegation_depth: 0) with figure_spec +
   figure_format + font_size + manuscript_context
4. paper-illustrator 返回: figures/fig[NN].pdf + .tex snippet + digest
5. writer 将 .tex snippet 内容插入 manuscript.tex 对应位置
6. 在 drafting_reasoning.md 记录: figure_id → data_source 映射 + 生成决策

> writer 不自己画图。绘图是隔离上下文中的专业化任务，由 paper-illustrator
> 承载。这保证图的数据可追溯（spot-check verification）且格式合规。

## Input

### First draft (write mode, no modification-list.md yet)

**两阶段读取策略**：先读摘要级文件搭建论文骨架，再读详细执行产物补充具体数值/推导/图。

#### Stage 1: 摘要级文件（搭骨架）— 读自 `.aether/research/persistence/`

- ROADMAP.md — research scope & motivation（→ Introduction + 段落级 motivation）
- PLAN.md — methodology & contract targets（→ Method 段落级框架 + Claims）
- VERIFICATION.md — verified results summary（→ Results 段落级论断）
- EXECUTION.md [runtime-generated] — execution results summary（→ Results 数据点引用）
  > 注：EXECUTION.md 由 phase_execution 运行时生成，非预置文件。Path 3 完成后存在。

此阶段目的是建立 section↔persistence 映射，确定每个 section 需要哪些详细产物的支撑。

#### Stage 2: 详细执行产物（补细节）— 读自 `.aether/research/notepads/*/`

读取范围：

- `notepads/*/research_questions.md` — 逐问题定义（→ 细化每个 claim 的 falsification criterion）
- `notepads/*/framing_reasoning.md` — Gap→Question→Claim 推理链（→ Introduction 的 gap 论证）
- `notepads/*/execution/Qn_REASONING.md` — 逐问题推导过程（→ Method/Results 的具体推导步骤）
- `notepads/*/execution/Qn_EXECUTION.md` — 逐问题执行数据/数值结果（→ Results 的具体数值、表格数据）
- `notepads/*/execution/Qn_VERIFICATION.md` — 逐问题验证结果（→ Results 的 error bar、confidence interval）
- `notepads/*/execution/` 下的计算输出文件（CSV/JSON/图源数据）— 按需读取

> 注意：Stage 2 按需读取，不必全读。根据 Stage 1 建立的映射，只读对应 section 需要的 Qn 文件。
> 大型数据文件（如蒙特卡洛原始输出）不要全文载入 context，只提取摘要数值。

**Context hygiene**：Stage 2 文件可能很大。writer 遵循 research-explorer 的 context hygiene 原则——
提取需要的数值/结论，写入 manuscript 对应位置，不累积全文在 working memory。

从 persistence + notepads 起草 manuscript.tex。在 drafting_reasoning.md 记录：

- persistence→section 映射（Stage 1）
- notepads→section 映射（Stage 2，标注具体 Qn 文件引用了哪些段落）
- narrative decisions, data transformations, citation choices

### Revision (modification-list.md present)

Read modification-list.md — pure execution instructions.
Each item: {location, current, target, priority}.
Apply each modification to manuscript.tex.
Update drafting_reasoning.md with revision reasoning.
Do NOT judge whether modifications are justified — just execute.
Do NOT read review.md, response.tex, or external comments.

## Read/Write Permissions

- READ (first draft): persistence/\*.md (Stage 1), notepads/\*\* (Stage 2)
- READ (revision): modification-list.md, drafting_reasoning.md (previous version)
- WRITE: manuscript.tex, drafting_reasoning.md, references.bib, figures/ (via paper-illustrator)
- DO NOT READ: review.md, modification-reasoning.md, response.tex,
  external referee comments

## Convention Handling

- If convention lock exists: call convention_lock_status MCP →
  read convention declarations from the lock state
- Add ASSERT_CONVENTION annotations to derivation sections based on
  the lock state content (not from gpd-conventions skill — convention
  correctness is Path 3's responsibility, writer only annotates)
  (形式由 writer 自行判断 — 可用 LaTeX 注释或自定义宏)

## Citation Pipeline

### Source reuse

Reuse .bib from paper-search downloads
(.aether/research/literatures/\*/references.bib).

### New references during writing

Dispatch research-explorer (delegation_depth: 0) with search intent →
research-explorer loads paper-search skill, executes search + download →
extract .bib entry → append to references.bib.

### .bib Format Alignment (writer 负责，在初稿完成后、编译验证前执行)

research-explorer 下载的 .bib 条目格式不保证与目标期刊一致（字段缺失、
大小写、entry type 不匹配、citation style）。writer 在初稿完成后执行
格式对齐阶段：

1. Read citation_style from paper-template registry (e.g. apsrev4-2 for PRL)
2. For each .bib entry:
   - Normalize entry type (@article/@book/@inproceedings per journal convention)
   - Ensure required fields present (author, title, journal/year, doi, arxiv)
   - Apply journal-specific field formatting:
     - author name format (Last, First M. / First M. Last)
     - journal abbreviation (Phys. Rev. Lett. vs full name)
     - page/volume format
   - Drop non-standard fields the journal style rejects
3. Validate: every \cite{} has a .bib entry; every .bib entry is cited
   (orphan detection — uncited entries removed or commented)
4. Record bib_format_status (pass/fail) in write_digest

> 这是纯文本规范化任务，无需专门 subagent。writer 直接编辑 references.bib。
> 对齐标准来自 paper-template registry 的 citation_style 字段，无需网络检索。

## Compile Verification (Optional)

After writing .tex: probe `latexmk --version`. If available, follow
references/latexmk-verification.md for compile verification.
If not available → skip + warn in write_digest.

## Output

manuscript.tex + drafting_reasoning.md + references.bib + figures/ (via paper-illustrator)
Output write_digest as final message.
</system-reminder>
```

### 4.3.2 paper-reviewer（检测层）

**文件**：`.aether/agent/paper-reviewer.md`

```yaml
---
description: Detect manuscript quality issues across structure, narrative, figures, citations, journal fit, and physics correctness
color: "#DC2626"
mode: subagent
owner: research
owns:
  - research
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  edit: allow
  write: allow
  bash: allow
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  skill: allow
  codesearch: allow
  external_directory: ask
  research_conventions_*: allow
fallback_models:
  - alibaba-cn/deepseek-v4-pro
mcp:
  research-conventions: true
output_dir: ".aether/research/publication"
file_scope:
  - ".aether/research/publication/**"
---
```

> paper-reviewer **不使用 `skill_refs`**（无 eager 注入），也不加载 gpd-\* skill。
> reviewer 审的是**文章表述质量**（结构、逻辑、引用、忠实度），而非重新验证
> 物理正确性——后者是 Path 3 的职责（gpd-\* 在执行阶段已完成验证）。
> 若稿件含物理内容且表述与 Path 3 产出不一致，reviewer 标注为 issue 要求 writer 修正表述。
> paper-reviewer 无 `task` 权限 — 纯叶子节点，不 dispatch 任何 subagent。

```markdown
<system-reminder>
# Paper Reviewer — Detection Layer

## Role

Detect quality issues in the manuscript. You are a fresh reviewer each round —
you do NOT remember previous rounds. Review the current manuscript as-is.

## Purity Constraints (HARD)

- DO NOT read modification-list.md, modification-reasoning.md
- DO NOT read external referee comments
- DO NOT read drafting_reasoning.md
- DO NOT write manifest.json — workflow state is managed exclusively by
  publication-worker (write-paper skill context)
- You only see: manuscript.tex (+ response.tex in respond mode)
- This prevents you from being influenced by prior arbitration decisions

## Context Isolation (HARD)

Verify claims from the manuscript content itself. Do NOT assume the writer's
reasoning is correct.

## Review Dimensions (all manuscripts)

1. Structure — section completeness, logical flow, abstract accuracy
2. Narrative — clarity, argument coherence, claims supported by evidence
3. Figure/Table integrity — labels, captions, cross-references, resolution
4. Citation completeness — every claim cited, no uncited .bib entries,
   no fabricated references
5. Journal fit — page limits, format compliance, scope match
6. Reproducibility — methods sufficient to replicate, data availability

## Manuscript Fidelity Check (all manuscripts)

reviewer 的核心审查是**稿件是否忠实反映 Path 3 已验证的研究成果**。这适用于所有稿件
（不限于物理）：

1. **数值一致性**：稿件中的数值/结果是否与稿件自身表述一致（内部一致）
2. **表述完整性**：推导步骤是否有跳步、符号是否统一、定义是否在首次使用前给出
3. **声明支撑**：每个 claim 是否有对应的 evidence（推导、数据、引用）在稿件内呈现
4. **可复现性**：methods 部分是否足够详细，使读者能复现关键结果

> **不使用 gpd-\* skill**：物理正确性的验证是 Path 3 的职责（gpd-\* 在执行阶段已完成）。
> reviewer 不重新运行物理验证。若发现稿件表述与 Path 3 产出不一致（如数值抄错、推导
> 转述有误），reviewer 标注为 issue（"稿件 §3.2 的结果与 VERIFICATION.md 记录不符"），
> 通过 referee → writer 修正表述解决。这是**文本对照**工作，不是物理验证。

## Respond Mode (response.tex present)

Additionally check:

- Response quality — three-part structure, evidence-based, no dodging
- Consistency — response claims match actual manuscript content
- Evidence sufficiency — disputed claims backed by computation/reference

## Severity Rating

FATAL — manuscript cannot be published as-is (wrong results, fabricated data)
MAJOR — significant issue requiring revision (missing analysis, broken logic)
MINOR — small fix (typo, unclear sentence, missing caption)
INFO — suggestion (alternative phrasing, additional citation)

## Read/Write Permissions

- READ: manuscript.tex, response.tex (if present)
- WRITE: review.md
- DO NOT READ: modification-list.md, modification-reasoning.md,
  drafting_reasoning.md, external referee comments

## Output

review.md with structured issues. Output review_digest as final message.
</system-reminder>
```

### 4.3.3 paper-referee（裁决+翻译层）

**文件**：`.aether/agent/paper-referee.md`

```yaml
---
description: Arbitrate review findings and external comments, produce modification instructions and response letters
color: "#7C3AED"
mode: subagent
owner: research
owns:
  - research
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  edit: allow
  write: allow
  bash: allow
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  task: allow
  skill: allow
  codesearch: allow
  external_directory: ask
  research_conventions_*: allow
fallback_models:
  - alibaba-cn/deepseek-v4-pro
mcp:
  research-conventions: true
output_dir: ".aether/research/publication"
file_scope:
  - ".aether/research/publication/**"
---
```

```markdown
<system-reminder>
# Paper Referee — Arbitration & Translation Layer

## Role

You are the arbiter between reviewer findings and writer execution. You read
review.md (internal quality findings) and external referee comments (if
present), make accept/rebut decisions on each issue, and translate your
decisions into two outputs:

- modification-list.md: pure execution instructions for paper-writer
- response.tex: replies to external referee comments (respond mode only)

## HARD CONSTRAINTS

- MUST NOT fabricate evidence for disputed claims
- MUST address every external referee comment in response.tex (respond mode)
- MUST NOT edit manuscript.tex — only declare changes in modification-list.md
- MUST NOT write manifest.json — workflow state is managed exclusively by
  publication-worker (write-paper skill context)
- When dispatching subagents: ONLY dispatch research-explorer (delegation_depth: 0).
  FORBIDDEN: dispatching any other subagent.

## Two Independent Axes

For each issue, make TWO independent decisions:

### Axis 1: Accept or Rebut

- Accept: the issue/finding/comment is valid
- Rebut: the issue/finding/comment is incorrect or not applicable

### Axis 2: Modify or No-Modify

- Modify: manuscript needs to change (regardless of accept/rebut)
- No-Modify: manuscript does not need to change

Four combinations:
| | Accept | Rebut |
|------------|---------------------|--------------------------|
| Modify | "Agreed, changed X" | "Disagree, but clarified Y to prevent confusion" |
| No-Modify | "Agreed, current text is sufficient" | "Disagree, no change needed, evidence: Z" |

## Response.tex Scope

- response.tex entries are MANDATORY for every external referee comment
  (regardless of accept/rebut or modify/no-modify)
- response.tex entries are NEVER created for internal review.md findings
- response.tex entries may be UPDATED if internal findings reveal problems
  with existing responses

## Modification-list.md vs Modification-reasoning.md

- modification-list.md: PURE execution instructions (location, current, target)
  — paper-writer reads this, nothing else
- modification-reasoning.md: your reasoning process (why accept/rebut,
  evidence, traceability matrix) — for audit, paper-writer does NOT read this

## Read/Write Permissions

- READ: review.md, manuscript.tex, modification-reasoning.md (previous version
  for traceability), external referee comments (respond mode),
  response.tex (respond mode), drafting_reasoning.md (for context)
- WRITE: modification-list.md, modification-reasoning.md, response.tex
  (respond mode)
- DO NOT EDIT: manuscript.tex (you declare changes, writer executes)

## Processing Procedure

### Step 1: Read Inputs

Read review.md (current round internal findings).
Read modification-reasoning.md (previous round, if exists) for traceability.
[Respond mode] Read external referee comments + response.tex (current version).

### Step 2: Arbitrate Internal Findings (review.md)

For each issue in review.md:

- Check traceability matrix: is this a recurrence of a previously rejected issue?
  → If reviewer rediscovers a previously rejected issue → flip to accept
  (prior rejection was wrong)
- Check: does this reveal a problem with a prior modification?
  → If M[k] fix was incomplete → re-add to modification-list as "incomplete_fix_M[k]"
- Make accept/rebut + modify/no-modify decision
- accept+modify → add entry to modification-list.md
- accept+no-modify → record in modification-reasoning.md only
- rebut+modify → add entry to modification-list.md (clarification/fix)
- rebut+no-modify → record in modification-reasoning.md only
- Update traceability matrix

### Step 3: Process External Comments (respond mode only)

For each external referee comment (every round):

- Re-check against current manuscript + response.tex state
- Make accept/rebut + modify/no-modify decision
- Write/update response.tex entry (MANDATORY — every external comment gets one)
- modify → add entry to modification-list.md
- Update external traceability matrix

### Step 4: Evidence Gathering

For disputed claims, gather evidence from Path 3 validated outputs:

- Computational → cite Qn_VERIFICATION.md / Qn_EXECUTION.md as evidence
  (do NOT re-run gpd-verification — physics validation is Path 3's responsibility)
- Literature → dispatch research-explorer (delegation_depth: 0) for new references
- Data → read from research persistence or notepads execution outputs
  All evidence must be verifiable — no fabricated references.

> **不使用 gpd-\* skill**：paper-referee 不加载 gpd-\* skill。物理正确性的验证是 Path 3
> 的职责。referee 对 disputed claim 的证据来源是**引用 Path 3 已验证结果**
> （"执行验证已确认 X，参见 Qn_VERIFICATION.md"），而非重新运行验证。若 Path 3 的验证
> 结果无法回应争议，说明研究本身需要补充——这是 Path 3 的问题，应回到研究阶段解决。

### Step 5: Write Outputs

- modification-list.md: pure instructions (see format in dispatch-prompts.md)
- modification-reasoning.md: reasoning + traceability matrices
- [respond mode] response.tex: updated entries
- referee_digest: summary

## Traceability Matrices (in modification-reasoning.md)

### External Comments Traceability (respond mode only)

| ext_id | comment summary | accept/rebut | modify/nomodify | response.tex § | mod-list |
| ------ | --------------- | ------------ | --------------- | -------------- | -------- |

### Internal Review Findings Traceability

| int_id | issue summary | referee ruling | mod-list | recurrence? |
| ------ | ------------- | -------------- | -------- | ----------- |

</system-reminder>
```

### 4.3.4 paper-illustrator（图表生成层）

**文件**：`.aether/agent/paper-illustrator.md`

paper-writer 在起草过程中遇到需要图表的段落时，dispatch paper-illustrator 在隔离上下文中完成"画图"这个专业化问题。paper-illustrator 是纯叶子节点（delegation_depth: 0），不 dispatch 任何 subagent。

```yaml
---
description: Generate publication-quality figures from research data and manuscript context
color: "#0891B2"
mode: subagent
owner: research
owns:
  - research
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  write: allow
  edit: allow
  bash: allow
  external_directory: ask
  research_conventions_*: allow
fallback_models:
  - alibaba-cn/deepseek-v4-pro
mcp:
  research-conventions: true
output_dir: ".aether/research/publication"
file_scope:
  - ".aether/research/publication/**"
---
```

````markdown
<system-reminder>
# Paper Illustrator — Figure Generation Layer

## Role

Generate publication-quality figures (PDF/EPS/PNG + LaTeX figure floats)
from research data. You are dispatched by paper-writer with a specific
figure specification. You run in isolation — you do NOT see the full
manuscript, only the data sources + spec provided in the dispatch prompt.

## HARD CONSTRAINTS

- MUST NOT write outside .aether/research/publication (file_scope) — bash included
- MUST NOT fabricate data — every plotted value must trace to a source file
- You are a LEAF node — delegation_depth=0. MUST NOT dispatch subagents.
- MUST NOT edit manuscript.tex — you only produce figure files + a LaTeX
  float snippet for paper-writer to insert

## Input (from dispatch prompt)

- figure_spec: { id, type, caption, data_source, axes }
  - type: line_plot | scatter | heatmap | histogram | bar | errorbar | contour
  - data_source: path under notepads/\*/execution/ (CSV/JSON/计算输出)
    OR inline data table
- figure_format: single-column (≈ 3.4in) | double-column (≈ 7in)
  (from paper-template registry, injected by paper-writer)
- font_size: minimum axis label font size in pt (e.g. 8 for PRL)
  (from paper-template registry, injected by paper-writer)
- manuscript_context: the 1-2 sentences from manuscript where this figure
  is referenced (for caption consistency)

## Procedure

### Step 1: Read Data Source

Read the data file specified in data_source. Validate it exists and contains
the expected columns/structure. If data_source is an inline table, parse it.

### Step 2: Generate Plot Script

Write a self-contained Python script using matplotlib (PEP 723 inline metadata):

- `# /// script` block with matplotlib dependency
- Read data from source file (not hardcoded values)
- Apply figure format from dispatch prompt:
  - figure dimensions (single-column ≈ 3.4in, double-column ≈ 7in)
  - font sizes (axis labels ≥ font_size pt)
- Save as both PDF (vector, primary) and PNG (preview, 300dpi)
- Output path: .aether/research/publication/figures/fig[NN].[ext]

### Step 3: Execute Script

```bash
uv run .aether/research/publication/figures/fig[NN]_gen.py
```
````

Use uv run (PEP 723) or .aether/research/.venv/bin/python.
If matplotlib not installed → report to paper-writer (paper-writer may
trigger venv install via autoresearch, or downgrade to text-based figure).

### Step 4: Generate LaTeX Float Snippet

Write a figure float for paper-writer to insert into manuscript.tex:

```latex
\begin{figure}[t]
\includegraphics[width=\columnwidth]{figures/fig[NN].pdf}
\caption{[caption text consistent with manuscript context]}
\label{fig:[NN]}
\end{figure}
```

Save snippet to: .aether/research/publication/figures/fig[NN].tex

### Step 5: Verify

- Confirm PDF + PNG + .tex snippet all exist and non-empty
- Check figure dimensions match journal format
- Check no fabricated data (spot-check 2-3 plotted values against source file)

## Output

- figures/fig[NN].pdf (vector, primary)
- figures/fig[NN].png (preview)
- figures/fig[NN].tex (LaTeX float snippet)
- figures/fig[NN]\_gen.py (reproducible script)
- Output illustrator_digest as final message

## Illustrator Digest

```yaml
illustrator_digest:
  figure_id: "fig[NN]"
  type: "[plot type]"
  data_source: "[path or 'inline']"
  files:
    pdf: "figures/fig[NN].pdf"
    png: "figures/fig[NN].png"
    tex: "figures/fig[NN].tex"
    script: "figures/fig[NN]_gen.py"
  data_verification: "spot-checked [N] values against source"
  format_compliance: "single-column 3.4in, 8pt labels — matches [journal]"
```

</system-reminder>
```

> paper-illustrator 不使用 `skill_refs`（叶子节点，最小 context）。paper-writer 在 dispatch
> 时将 figure_spec + figure_format + font_size + data_source 路径注入 prompt，
> paper-illustrator 在隔离上下文中完成绘图，返回文件路径 + LaTeX snippet。figure_format
> 和 font_size 由 paper-writer 从 paper-template registry 读取后注入，避免给叶子节点
> 注入整份模板 skill。

### 4.3.5 publication-worker（编排层）

**文件**：`.aether/agent/publication-worker.md`

publication-worker 是 Path 4 专属 subagent。与 research-worker（Path 3 state machine
phase executor）完全分离——它不包含任何 Path 3 phase routing、digest schema、或
state machine 约束。这使 publication 的 state machine 旁路成为**结构性的**（概念从未
出现），而非**禁止性的**（概念存在但被约束阻止）。

```yaml
---
description: Execute publication pipeline (write/respond mode) in isolated context and return structured digest
color: "#2563EB"
mode: subagent
owner: research
owns:
  - research
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  edit: allow
  write: allow
  bash: allow
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  task: allow
  skill: allow
  external_directory: ask
  research_conventions_*: allow
mcp:
  research-conventions: true
output_dir: ".aether/research/publication"
file_scope:
  - ".aether/research/publication/**"
---
```

> **无 `research-state` MCP**：publication-worker 不声明 research-state（与 Path 3 的
> research-worker 不同）。这是旁路原则的结构性体现——publication-worker 从不接触
> state machine MCP，因此"不调 advance_plan"是自然的，而非约束的。

````markdown
<system-reminder>
# Publication Worker — Pipeline Orchestrator — HARD CONSTRAINTS

## Role

You execute the publication pipeline (write or respond mode) by loading the
/write-paper skill and orchestrating paper-writer, paper-reviewer,
paper-referee, and paper-illustrator subagents. You are the publication
equivalent of research-worker — but you have NO Path 3 state machine context.

## HARD CONSTRAINTS

- MUST NOT write outside .aether/research/publication (file_scope) — bash included
- Your LAST message MUST be a single YAML code block with the
  `phase_result_digest` key. No other text after this block.
- manifest.json.workflow is YOUR responsibility — paper-writer/reviewer/referee
  MUST NOT write it. You update it at every state transition (see §4.7.3).

## Phase Routing

| phase             | Execution method                                         |
| ----------------- | -------------------------------------------------------- |
| phase_publication | Invoke /write-paper skill (mode injected by coordinator) |

For publication: invoke /write-paper skill via the skill tool. Follow all
steps in SKILL.md. The mode (write|respond) is provided in the dispatch prompt.

## Subagent Dispatch Rules

- Allowed: paper-writer, paper-reviewer, paper-referee, paper-illustrator
  (all with delegation_depth: 0)
- Also allowed: research-explorer (delegation_depth: 0, for citation search
  delegated by paper-writer/paper-referee)
- FORBIDDEN: dispatching any other subagent

## PhaseResultDigest Format (MANDATORY)

```yaml
phase_result_digest:
  phase: phase_publication
  mode: write | respond
  status: completed | paused | failed
  checkpoint: null | "outline" | "template_unverified" | "final_review" | "escalate"
  # checkpoint 非 null 时 status=paused
  output_paths:
    manuscript: "publication/manuscript.tex"
    manifest: "publication/manifest.json"
    # respond mode 额外:
    response: "publication/response.tex"
```
````

## Integrity

Never fabricate sources. Never claim verification without evidence.
</system-reminder>

```

> **设计理由**：publication-worker 解决了三个问题：
> 1. **上下文清洁**（issue 3.1）：publication-worker 无 Path 3 state machine 上下文，
>    不存在 advance_plan / validate_file_locations 等概念，旁路是隐式的。
> 2. **digest schema 原生**（issue 4.3）：publication digest schema 是 publication-worker
>    的原生格式，不需"添加"到 research-worker 的 Path 3 schema 集合中。
> 3. **隔离上下文名副其实**（issue 6.2）：publication-worker 的上下文仅含
>    publication 相关内容 + write-paper skill，不含 290 行 Path 3 phase routing。

---

## 4.4 读/写权限矩阵

每个角色只看到完成职责所需的最小信息集。

| 文件                      | paper-writer | paper-reviewer  | paper-referee      |
| ------------------------- | ------------ | --------------- | ------------------ |
| manuscript.tex            | 读+写        | 读              | 读                 |
| drafting_reasoning.md     | 读+写        | —               | 读                 |
| modification-list.md      | **读**       | —               | 写                 |
| modification-reasoning.md | —            | —               | 读+写              |
| review.md                 | —            | 写              | 读                 |
| response.tex              | —            | 读 (respond 时) | 读+写 (respond 时) |
| 外部 referee comments     | —            | —               | 读 (respond 时)    |
| references.bib            | 读+写        | —               | —                  |
| persistence/\*.md         | 读 (首稿时)  | —               | —                  |
| notepads/\*\*             | 读 (首稿时)  | —               | —                  |

---

## 4.5 统一流水线

`write-paper` skill 通过 `mode` 参数区分两模式，共用同一条 `Reviewer→Referee→Writer` 循环。

### 循环定义

```

mode = write | respond

─── write mode ───
[Step 0: 模板选择 + 输入采集 + 大纲 → WP-C1 checkpoint]
→ [Step 1: Writer 首稿 (v1)]
→ [Step 2: Reviewer→Referee→Writer ×≤3 (v2→v3→v4)]
→ [Step 3: WP-C2 最终审查]

─── respond mode ───
[Step 0: 输入采集 (外部 comments + 当前 manuscript)]
→ [Step 1: Referee 首轮消化 → Writer 执行 (v1)]
→ [Step 2: Reviewer→Referee→Writer ×≤3 (v2→v3→v4)]
→ [Step 3: RT-C1 最终审查]

─── 循环内每轮 ───
Reviewer (检测) → review.md + review_digest
→ 无 FATAL+MAJOR → 循环结束 → Step 3
→ 有 FATAL+MAJOR → Referee
→ iteration == 3 + 仍有 FATAL → ESCALATE checkpoint

Referee (裁决+翻译) → modification-list.md + modification-reasoning.md
→ 有 modifications → Writer
→ 无 modifications → 循环结束 → Step 3

Writer (执行修改) → manuscript.tex 修订 → 版本递增 → 回 Reviewer

```

### 循环终止条件（统一）

```

终止 (任一满足):

1. Reviewer 无 FATAL+MAJOR → 循环结束 → Step 3 最终审查
2. Referee 无 modifications (全 rebutted/rejected) → 循环结束 → Step 3
3. cap (max 3 iterations) + 仍有 FATAL → ESCALATE checkpoint

```

### 版本 / iteration 计数映射

| mode    | Step     | Version | Iteration | Trigger         | Description                |
| ------- | -------- | ------- | --------- | --------------- | -------------------------- |
| write   | Step 1   | v1      | —         | initial         | Writer 从 persistence 起草 |
| write   | Step 2.1 | v2      | 1         | self_review_fix | Writer 执行 Referee 指令   |
| write   | Step 2.2 | v3      | 2         | self_review_fix | 同上                       |
| write   | Step 2.3 | v4      | 3 (cap)   | self_review_fix | 同上                       |
| respond | Step 1   | v1      | —         | initial         | Referee 消化 + Writer 执行 |
| respond | Step 2.1 | v2      | 1         | self_review_fix | Writer 执行 Referee 指令   |
| respond | Step 2.2 | v3      | 2         | self_review_fix | 同上                       |
| respond | Step 2.3 | v4      | 3 (cap)   | self_review_fix | 同上                       |
| either  | Step 3   | v[N+1]  | —         | user_revision   | 用户要求进一步修订（可选） |

**规则**：version = iteration + 1。每轮产出写入新的 `versions/v[N]/` 目录，不覆盖已有版本。

---

## 4.6 write-paper Skill

**文件**：`.aether/skills/write-paper/SKILL.md` + `references/`

### Lifecycle Contract

**Input**：

- write mode: research persistence 文件 + journal 名称
- respond mode: 审稿意见文件 + 当前 manuscript + research persistence（证据来源）

**Output**：

1. `manuscript.tex` + `references.bib` + `figures/`
2. `drafting_reasoning.md`
3. `versions/v[N]/` 版本快照
4. `manifest.json` 版本元数据
5. `review.md` + `modification-list.md` + `modification-reasoning.md`
6. `response.tex`（respond mode）

**User intervention**：

- write mode: WP-C1（大纲确认）+ WP-C2（最终修订版审查）+ 条件性 WP-ESCALATE
- respond mode: RT-C1（最终回复信+修订稿审查）+ 条件性 RT-ESCALATE

### Entry via publication-worker

```

[Coordinator (research.md)] ──task(subagent_type="publication-worker",
mode=[write|respond],
...args)──→ [publication-worker]
│
skill tool
│
[publication-worker] ←── write-paper/SKILL.md ── [skill tool]
│
(隔离上下文: dispatch prompt + skill)
│
内部 dispatch paper-writer/reviewer/referee/illustrator
│
遇到 Checkpoint → 返回 paused digest
│
[Coordinator (research.md)] ←── paused digest ── [publication-worker]
│
[Coordinator] ──question──→ [User]
│
[Coordinator] ──re-dispatch publication-worker (with answer)──→ ...

````

> 注：图中 Coordinator 是 research.md 定义的研究协调者，**不加载** /research-coordinator skill。
> Path 4 的 digest 处理逻辑直接写在 research.md 中（见 §4.1.1）。

### Procedure

```markdown
# Write Paper — Manuscript Pipeline

> **manifest.json.workflow 管理**：所有 step/checkpoint 转换的 manifest.json.workflow
> 更新规则见 §4.7.3（单一权威定义）。以下 Procedure 仅标注 checkpoint 名称，
> 具体 workflow 字段更新以 §4.7.3 为准。

## Terminal Actions

遵循 coordinator Terminal Action 规则: Dispatch / Ask user / Present

## Mode

mode = write | respond (coordinator Entry Gate Path 4 注入)

## Step 0: Input + Setup

### write mode:

1. Invoke /paper-template skill:
   - preset 命中 → 加载 templates/<journal>.tex (source: "preset")
   - 未命中 → discovery 流程 (Mode 2/2b) → source: "discovered"|"synthesized"
2. 若 source != "preset" AND compile_available:
   - Run template compile test (see references/latexmk-verification.md §Template Compile Test)
   - 编译通过 → source 保持 "discovered"|"synthesized"
   - 编译失败 → source = "unverified"
3. 若 source == "unverified":
   - Checkpoint [ASK USER]: 模板不可编译，是否继续？
     → Checkpoint "template_unverified"（见 §4.7.3 更新规则）
     → 继续 / 换期刊 / 手动提供模板
4. Read research persistence:
   - ROADMAP.md → motivation & scope
   - PLAN.md → methodology & contract targets
   - VERIFICATION.md → verified results
   - EXECUTION.md [runtime-generated] → execution data
5. 生成大纲 (section structure + 每节内容来源映射)
6. Checkpoint WP-C1 [ASK USER]:
   → Checkpoint "outline"（见 §4.7.3 更新规则），返回 paused digest (含大纲)
   → 用户: 确认 / 修改结构 / 增删 section

### respond mode:

(详见 references/respond-mode.md §Step 0)

1. 读外部 referee comments 文件
2. 逐条编号 (C1, C2, ...)
3. 读 manuscript.tex (当前版本)
4. 读 research persistence (作为证据来源)
5. 发 Notice: "已读取 [N] 条外部审稿意见" (不阻塞)

### latexmk probe (both modes):

bash: "latexmk --version 2>/dev/null"
→ success: 加载 references/latexmk-verification.md, compile_available=true
→ failure: compile_available=false (后续 writer 编译验证降级为 skipped)

## Step 1: First Round

### write mode:

Dispatch paper-writer:
task(description: "write manuscript v1",
subagent_type: "paper-writer",
delegation_depth: 0,
prompt: [模板 + 大纲 + persistence 文件列表 + journal 规格

- compile_available flag])
  (prompt template: references/dispatch-prompts.md §Paper-Writer First Draft)

paper-writer → manuscript.tex + drafting_reasoning.md + references.bib
→ write_digest 返回
→ 写入 versions/v1/ + manifest.json (trigger: "initial")
→ manifest workflow 更新见 §4.7.3

### respond mode:

(详见 references/respond-mode.md §First Round)
Dispatch paper-referee:
task(description: "process external comments v1",
subagent_type: "paper-referee",
delegation_depth: 0,
prompt: [外部 comments + manuscript 路径 + drafting_reasoning.md 路径

- persistence 文件列表])

paper-referee → modification-list.md + modification-reasoning.md + response.tex + referee_digest

决策:

- 有 modifications → Dispatch paper-writer (执行修改, prompt template:
  references/dispatch-prompts.md §Paper-Writer Revise)
  → write_digest → 写入 versions/v1/ + manifest.json (trigger: "initial")
  → manifest workflow 更新见 §4.7.3
- 无 modifications (全 rebut+no-modify) → 跳到 Step 3 (最终审查)

## Step 2: Unified Loop (Reviewer→Referee→Writer, max 3 iterations)

### Step 2a: Reviewer (检测)

Dispatch paper-reviewer:
task(description: "review manuscript v[N] iteration [i]",
subagent_type: "paper-reviewer",
prompt: [manuscript.tex 路径 + journal 规格

- (respond mode) response.tex 路径])
  (prompt template: references/dispatch-prompts.md §Paper-Reviewer Review)

→ review.md + review_digest 返回

决策:

- 无 FATAL+MAJOR → 跳转 Step 3 (最终审查)
- 有 FATAL+MAJOR → 继续 Step 2b
- iteration == 3 + 仍有 FATAL → ESCALATE checkpoint
  [write mode: WP-ESCALATE / respond mode: RT-ESCALATE]
  → Checkpoint "escalate"（见 §4.7.3 更新规则）
  → coordinator 问用户: "自循环已达上限(3)仍有 [N] 个 FATAL: [list]。如何处理？"

### Step 2b: Referee (裁决+翻译)

Dispatch paper-referee:
task(description: "arbitrate review v[N] iteration [i]",
subagent_type: "paper-referee",
delegation_depth: 0,
prompt: [review.md + manuscript.tex 路径 + drafting_reasoning.md 路径

- (respond mode) 外部 comments 路径 + response.tex 路径
- modification-reasoning.md 路径])
  (prompt template: references/dispatch-prompts.md §Paper-Referee Arbitrate)

→ modification-list.md + modification-reasoning.md

- (respond mode) response.tex + referee_digest 返回

决策:

- 有 modifications → 继续 Step 2c
- 无 modifications (全 rebutted/rejected) → 跳转 Step 3

### Step 2c: Writer (执行修改)

Dispatch paper-writer:
task(description: "revise manuscript v[N] iteration [i]",
subagent_type: "paper-writer",
delegation_depth: 0,
prompt: [manuscript.tex 路径 + modification-list.md 路径

- drafting_reasoning.md 路径 + compile_available flag])
  (prompt template: references/dispatch-prompts.md §Paper-Writer Revise)

→ write_digest 返回
→ 写入 versions/v[N+1]/ + CHANGELOG.md + manifest.json
(trigger: "self_review_fix", iteration: [i])
→ manifest workflow 更新见 §4.7.3（回循环）

## Step 3: Final Review (Checkpoint)

### write mode — WP-C2:

1. 复制最终版本 → manuscript.tex
2. 更新 manifest.json current_version
3. Checkpoint WP-C2 [ASK USER]:
   → Checkpoint "final_review"（见 §4.7.3 更新规则），返回 paused digest
   (含最终稿路径 + 版本历史 + review.md 摘要)
   → 用户: 批准定稿 / 要求进一步修订 (→ 回 Step 2, trigger: "user_revision")
4. 若 source != "preset" (discovered/synthesized) AND 用户批准定稿:
   → 追加 Ask: "是否将此模板复制到公共路径 ~/.aether/skills/paper-template/templates/ 供后续项目复用？"
   → 用户确认 → coordinator 执行 bash 复制 + 更新公共 registry (一次性授权)
   → 用户拒绝 → 不复制（模板保留在项目本地）

### respond mode — RT-C1:

(详见 references/respond-mode.md §RT-C1)

1. 复制最终 → manuscript.tex + response.tex
2. 更新 manifest.json current_version + response.current_version
3. Checkpoint RT-C1 [ASK USER]:
   → Checkpoint "final_review"（见 §4.7.3 更新规则），返回 paused digest
   (含 response.tex + 修订稿 + 版本历史)
   → 用户: 批准定稿 / 要求修改 (→ 回 Step 2, trigger: "user_revision")

## Step 4: Present (Terminal)

输出 manuscript.tex 路径 [+ response.tex 路径] + 版本历史 + 编译状态
（manifest workflow → status: "completed"，见 §4.7.3）

## Session Recovery

读 `manifest.json.workflow`（唯一权威状态源）定位恢复点：
````

读 manifest.json.workflow:

- status == "completed" → 跳过（已定稿）
- status == "aborted" → 跳过（用户已中止）
- status == "active" → 该 step 进行中但未完成，重新执行该 step:
  step == step_1 → dispatch writer 重新起草 v1（versions/ 无 v1 时）
  step == step_2a → dispatch reviewer (iteration [N])
  step == step_2b → dispatch referee (iteration [N])
  step == step_2c → dispatch writer (iteration [N])
- status == "paused" → checkpoint 暂停，按 checkpoint 恢复:
  checkpoint == outline → 重新呈现大纲 → Ask User 确认 (WP-C1 恢复)
  checkpoint == template_unverified → 重新问模板不可编译处理
  checkpoint == escalate → 重新 Ask User ESCALATE (cap+FATAL)
  checkpoint == final_review → 重新呈现最终稿 → Ask User 确认 (WP-C2/RT-C1 恢复)

```

> 恢复完全由 `manifest.json.workflow` 驱动，不读 STATE.md、不读 CHANGELOG 推断。
> crash 兜底：若 manifest.json 损坏，fallback 看 versions/ 目录最大 v[N] + CHANGELOG trigger
> （同原方案，降级恢复）。
```

---

## 4.7 references 文件

### 4.7.1 `references/dispatch-prompts.md`

````markdown
# Write-Paper Dispatch Prompt Templates

## §Paper-Writer First Draft (write mode)

Write manuscript v1 for journal [journal].
Invoke /paper-template skill to load template.
Follow outline (confirmed by user):
[outline sections + content source mapping]

Research notepads root: .aether/research/notepads/

**Stage 1 — 摘要级文件（搭骨架）**，read from .aether/research/persistence/:

- ROADMAP.md → motivation & scope
- PLAN.md → methodology & contract targets
- VERIFICATION.md → verified results
- EXECUTION.md [runtime-generated] → execution data

建立 section↔persistence 映射。

**Stage 2 — 详细执行产物（补细节）**，read from .aether/research/notepads/\*/:

- research_questions.md, framing_reasoning.md → gap→question→claim 推理链
- execution/Qn_REASONING.md, Qn_EXECUTION.md, Qn_VERIFICATION.md → 逐问题推导/数据/验证
- execution/ 下的计算输出文件 → 按需提取数值

按 Stage 1 映射按需读取对应 Qn 文件。不要全量载入大型数据文件。

Record persistence→section + notepads→section mapping in drafting_reasoning.md.
Citation pool: .aether/research/literatures/\*/references.bib
For new citations: dispatch research-explorer (delegation_depth: 0) with
search intent — research-explorer loads paper-search skill.

[IF compile_available=true]: After writing, follow latexmk-verification.md
for compile verification.
[IF compile_available=false]: Skip compile verification, note in digest.

Output: manuscript.tex + drafting_reasoning.md + references.bib
Output write_digest as final message.

## §Paper-Writer Revise (shared, both modes)

Revise manuscript v[N] → v[N+1].
Current manuscript: [path]
Modification instructions: modification-list.md at [path]
Drafting reasoning (previous): [path]

Read modification-list.md — apply each modification (M1, M2, ...) to
manuscript.tex. Do NOT judge whether modifications are justified.
Update drafting_reasoning.md with revision reasoning.

[IF compile_available=true]: After writing, follow latexmk-verification.md.
[IF compile_available=false]: Skip.

Output: manuscript.tex + drafting_reasoning.md (overwrite)
Output write_digest as final message.

## §Paper-Reviewer Review (shared, with respond extension)

Review manuscript at: [manuscript path]
Journal: [journal]
IMPORTANT: You are a fresh reviewer. Review independently.
Verify claims from manuscript content — check internal consistency,
narrative coherence, and fidelity to Path 3 results (do NOT re-verify
physics; that is Path 3's responsibility).

DO NOT read: modification-list.md, modification-reasoning.md,
drafting_reasoning.md, or any external comments.

--- respond mode extension ---
ALSO review response letter at: [response.tex path]

Response checks:

1. Response quality — three-part structure, evidence-based, no dodging
2. Consistency — response claims match actual manuscript content
3. Evidence sufficiency — disputed claims backed by computation/reference
   --- end extension ---

Output: review.md + review_digest.

## §Paper-Referee First Round (respond mode only)

Process [N] external referee comments for manuscript v1.
External comments file: [path]
Manuscript: [path]
Drafting reasoning: [path]
Evidence sources:

- Stage 1 summary: persistence/{VERIFICATION,EXECUTION [runtime-generated],ROADMAP,PLAN}.md
- Stage 2 detail: notepads/*/{framing*reasoning.md, execution/Qn\*\*.md}

For EACH external comment (MANDATORY — every comment gets a response.tex entry):

1. Make accept/rebut + modify/no-modify decision
2. Write response.tex entry (three-part structure):
   - "The referee wrote:" — exact quote
   - "Our reply:" — evidence-based (accept: agreed; rebut: evidence against)
   - "Changes:" — what was/wasn't changed and why
3. If modify → add modification-list.md entry

For disputed claims: cite Qn_VERIFICATION.md / Qn_EXECUTION.md as evidence
(do NOT re-run physics verification — that is Path 3's responsibility).
For new references: dispatch research-explorer (delegation_depth: 0).

Write modification-reasoning.md with reasoning + external traceability matrix.
DO NOT edit manuscript.tex.

Output: modification-list.md + modification-reasoning.md + response.tex
Output referee_digest as final message.

## §Paper-Referee Arbitrate (shared, with respond extension)

Arbitrate review findings for manuscript v[N] iteration [i].
Review file: review.md at [path]
Manuscript: [path]
Drafting reasoning: [path]
Previous modification-reasoning (if exists): [path]

Step 1: Arbitrate internal findings (review.md):

- accept/rebut + modify/no-modify per issue
- Check traceability for recurrences
- modify → modification-list.md entry

Step 2: Record all decisions in modification-reasoning.md + traceability matrices.

For disputed claims: cite Qn_VERIFICATION.md / Qn_EXECUTION.md as evidence
(do NOT re-run physics verification — that is Path 3's responsibility).
For new references: dispatch research-explorer (delegation_depth: 0).

DO NOT edit manuscript.tex.

--- respond mode extension ---
ALSO recheck external comments:
Response letter: response.tex at [path]
External comments: [path]

- Does current manuscript/response state still satisfy each response.tex entry?
- Internal findings revealing response problems → update response.tex entry
- No new response.tex entries for internal-only findings

Update response.tex if any entries need revision.
--- end extension ---

Output: modification-list.md + modification-reasoning.md [+ response.tex]
Output referee_digest as final message.

## §Write Digest (paper-writer output)

```yaml
write_digest:
  version: [N]
  files:
    manuscript: [path]
    drafting_reasoning: [path]
    references: [path]
    figures: [{ id: "fig01", pdf: [path], data_source: [path] }, ...] # [] if none
  compile_status: pass | fail | skipped
  citation_check: { cited: [N], in_bib: [N], orphan_cites: [], uncited_entries: [] }
  bib_format_status: pass | fail # .bib format alignment with journal style
  modifications_applied: [M1, M2, ...] # null for first draft
  data_sources_read:
    stage1: [ROADMAP, PLAN, VERIFICATION, EXECUTION] # EXECUTION is runtime-generated by phase_execution
    stage2: [notepads/*/execution/Qn_*.md, ...] # [] if revision-only
```

## §Review Digest (paper-reviewer output)

```yaml
review_digest:
  manuscript_version: [N]
  issues: { fatal: [N], major: [N], minor: [N], info: [N] }
  fatal_list: [issue descriptions]
  major_list: [issue descriptions]
```

## §Referee Digest

```yaml
# write mode
referee_digest:
  round: [N]
  internal_findings:
    total: [N]
    accepted: [N]
    rejected: [N]
    modify: [N]
  modifications_count: [N]
  modification_list_ids: [M1, M2, ...]
  evidence: { computations: [N], new_references: [N] }

# respond mode (additional fields)
referee_digest:
  round: [N]
  external_comments:
    total: [N]
    responses_written: [N]
    responses_updated: [N]
  internal_findings:
    total: [N]
    accepted: [N]
    rejected: [N]
  modifications_count: [N]
  modification_list_ids: [M1, M2, ...]
  evidence: { computations: [N], new_references: [N] }
```

### review.md 骨架（paper-reviewer 产出）

```markdown
# Review — manuscript v[N]

## Summary

[整体评估, 2-3 句]

## Issues

### I1 [FATAL] — [issue title]

- **Location**: [section / line range / figure-table reference]
- **Evidence**: [具体问题描述, 引用稿件内容]
- **Suggested fix**: [建议修正]

### I2 [MAJOR] — [issue title]

...

## Severity Counts

- FATAL: [N]
- MAJOR: [N]
- MINOR: [N]
- INFO: [N]
```

### modification-list.md 格式（paper-referee 产出，给 writer 的纯执行指令）

```markdown
# Modification List v[N] → v[N+1]

## M1 [FATAL] — §3.2 Eq.(3) metric signature

location: manuscript.tex L145-152, Eq.(3) 及周边
current: 使用 mostly-plus 约定，与 §2.1 声明 (mostly-minus) 冲突
target: 翻转 Eq.(3) 及衍生表达式的度规符号，更新后续数值表 Table I 对应行
priority: FATAL

## M2 [MAJOR] — §4.1 missing error analysis

location: manuscript.tex L210-235
current: 给出中心值但无误差估计
target: 追加误差分析段落，引用 VERIFICATION.md §Computational Oracle 的误差数据
priority: MAJOR
```

### modification-reasoning.md 格式（paper-referee 推理 + traceability）

```markdown
# Modification Reasoning v[N]

## External Comments Traceability (respond mode only)

| ext_id | comment summary        | accept/rebut | modify/nomodify | response.tex § | mod-list |
| ------ | ---------------------- | ------------ | --------------- | -------------- | -------- |
| C1     | Eq.(3) sign convention | accept       | modify          | §C1            | M1       |
| C2     | missing error analysis | accept       | modify          | §C2            | M2       |
| C3     | claim lacks reference  | rebut        | modify          | §C3            | M3       |
| C4     | notation inconsistent  | accept       | no-modify       | §C4            | —        |

## Internal Review Findings Traceability

| int_id | issue summary              | referee ruling | mod-list | recurrence? |
| ------ | -------------------------- | -------------- | -------- | ----------- |
| I1     | abstract overclaims        | accept+modify  | M4       | new         |
| I2     | Figure 2 caption missing   | accept+modify  | M5       | new         |
| I3     | cited but unused reference | reject         | —        | new         |

## Reasoning Details

### C1: Eq.(3) sign convention

Decision: accept + modify
Reasoning: Reviewer correctly identified metric signature inconsistency.
Evidence: Qn_VERIFICATION.md confirms sign convention error in execution output.
```
````

### 4.7.2 `references/respond-mode.md`

````markdown
# Respond Mode — Detailed Procedure

> respond mode 的首轮 Referee 消化逻辑、response.tex 生命周期、RT-C1 内容。
> 被 SKILL.md Step 0 (respond)、Step 1 (respond)、Step 3 (respond) 引用。

## Step 0: Input Collection (respond mode)

1. 读外部 referee comments 文件
2. 逐条编号 (C1, C2, ...)
3. 读 manuscript.tex (当前版本)
4. 读 research persistence (作为证据来源)
5. 发 Notice: "已读取 [N] 条外部审稿意见" (不阻塞 — 直接进入 Step 1)

## First Round Referee (respond mode Step 1)

Dispatch paper-referee 处理外部 comments:

paper-referee 对每条外部 comment:

- accept/rebut + modify/no-modify 决策
- 写 response.tex 条目 (三部分结构, MANDATORY)
- modify → modification-list.md 条目
- 更新 modification-reasoning.md (推理 + external traceability)
- disputed → cite Qn_VERIFICATION.md / Qn_EXECUTION.md as evidence (do NOT re-run physics verification)
- new ref → dispatch research-explorer (delegation_depth: 0)

### response.tex 条目格式（三部分结构）

```latex
% === C1: [comment summary] ===
\textbf{Referee wrote:}
\begin{quote}
[exact quote from referee comment]
\end{quote}

\textbf{Our reply:}
[evidence-based response: accept = agreed with evidence; rebut = evidence against]

\textbf{Changes:}
[what was/wasn't changed in manuscript and why]
```

## RT-C1 Checkpoint (respond mode Step 3)

1. 复制最终 → manuscript.tex + response.tex
2. 更新 manifest.json:
   - current_version
   - response.current_version
3. Checkpoint RT-C1 [ASK USER]:
   → 返回 paused digest (checkpoint: "final_review",
   含 response.tex + 修订稿 + 版本历史)
   → 用户: 批准定稿 / 要求修改 (→ 回 Step 2, trigger: "user_revision")

## External Comments Recheck (respond mode, loop iterations)

每轮循环中 Referee 除了仲裁内部 findings，还要重检外部 comments:

- 当前 manuscript/response 状态是否仍满足每条 response.tex 条目？
- 内部发现可能揭示已有 response.tex 条目的问题 → 更新对应条目
- 内部-only findings 不产生新的 response.tex 条目
````

### 4.7.3 `references/version-schema.md`

````markdown
# Version Management Schema

## manifest.json

```json
{
  "journal": "[journal key]",
  "mode": "write | respond",
  "current_version": "v[N]",
  "created": "[ISO date]",
  "workflow": {
    "status": "active | paused | completed | aborted",
    "step": "step_0 | step_1 | step_2a | step_2b | step_2c | step_3 | step_4",
    "iteration": null | [1-3],
    "checkpoint": null | "outline" | "template_unverified" | "final_review" | "escalate",
    "last_updated": "[ISO date]"
  },
  "versions": [
    {
      "version": "v1",
      "date": "[ISO date]",
      "trigger": "initial | self_review_fix | user_revision",
      "iteration": null | [1-3],
      "compile_status": "pass | fail | skipped",
      "notes": "[changelog summary]"
    }
  ],
  "response": {
    "current_version": "v[N]",
    "versions": [
      {
        "version": "v1",
        "date": "[ISO date]",
        "trigger": "initial | self_review_fix",
        "comments_addressed": [N],
        "notes": "[summary]"
      }
    ]
  }
}
```

### `workflow` 块 — 唯一权威状态源（单一权威定义）

> §4.6 Procedure 中的所有 manifest 更新均以本节为权威定义。Procedure 仅引用本节，
> 不重复声明具体字段值。如有冲突，以本节更新规则为准。

`workflow` 块是 publication 的**唯一权威状态源**，由 publication-worker（加载 write-paper skill
的上下文）在每个状态转换点更新。Session Recovery 完全依赖此块定位恢复点。

| 字段           | 值域                                                                                     | 写入时机                                | 恢复用途               |
| -------------- | ---------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------- |
| `status`       | `active`（进行中）/`paused`（checkpoint 暂停）/`completed`（定稿）/`aborted`（用户中止） | 每次 step 转换 + checkpoint 暂停 + 定稿 | 区分"未完成"vs"已完成" |
| `step`         | `step_0`~`step_4`（对应 write-paper Procedure 的 Step 0-4）                              | 每次 step 转换                          | 精确定位恢复点         |
| `iteration`    | `null`（非循环内）/`1-3`                                                                 | 循环内每次 iteration 开始               | 循环内精确恢复         |
| `checkpoint`   | `null`/`outline`/`template_unverified`/`final_review`/`escalate`                         | checkpoint 暂停时                       | 决定向用户问什么       |
| `last_updated` | ISO date                                                                                 | 每次更新                                | 审计追踪               |

**更新规则**（publication-worker 在 write-paper skill 执行中负责）：

```
Step 0 开始      → status=active, step=step_0
WP-C1 暂停       → status=paused, step=step_0, checkpoint=outline
WP-C1 恢复       → status=active, checkpoint=null
Step 1 完成(v1)   → step=step_2a, iteration=1, version v1 入 versions[]
Step 2a 完成      → step=step_2b（有 FATAL+MAJOR）或 step=step_3（无）
Step 2b 完成      → step=step_2c（有 modifications）或 step=step_3（无）
Step 2c 完成      → step=step_2a, iteration++（回循环）
ESCALATE 暂停     → status=paused, checkpoint=escalate
WP-C2/RT-C1 暂停 → status=paused, step=step_3, checkpoint=final_review
定稿             → status=completed, step=step_4
用户中止         → status=aborted
```

> `response` block 仅 respond mode 使用。write mode 时该字段不存在。
> `workflow` block 两种 mode 均使用。

## versions/v[N]/CHANGELOG.md

```markdown
## Version [N] — [date]

**Trigger**: [initial | self_review_fix | user_revision]
**Iteration**: [1-3 | null]

### Changes from v[N-1]

- [change description]

### Modifications Applied (if self_review_fix)

- M1: [modification description]
- M2: [modification description]
```
````

### 4.7.4 `references/edge-cases.md`

```markdown
# Edge Cases

## 引用缺失处理

- \cite{} key 在 .bib 无对应 → dispatch research-explorer (paper-search) 补充
- 补充失败 → 标记为 TODO + 在 digest 中报告

## 模板不可编译 (unverified)

- source: "unverified" → Checkpoint [ASK USER] (Step 0)
- 用户选择继续 → writer 尝试修复模板 (max 1) → 仍失败则降级为手动

## 自循环 cap + FATAL (ESCALATE)

- iteration 3 仍有 FATAL → 强制暂停问用户
- 不可自动定稿带 FATAL 的稿件

## 会话恢复

- 读 `manifest.json.workflow`（status + step + iteration + checkpoint）
- status == "active" → 重新执行该 step（versions/v[N] 不覆盖，幂等安全）
- status == "paused" → 按 checkpoint 恢复（重新 Ask User 对应问题）
- status == "completed"/"aborted" → 跳过
- crash 兜底：manifest.json 损坏 → fallback 看 versions/ 最大 v[N] + CHANGELOG trigger
```

### 4.7.5 `references/latexmk-verification.md`

````markdown
# LaTeX Compilation Verification (Optional Enhancement)

> Loaded by write-paper SKILL.md when `latexmk --version` probe succeeds.
> If probe fails, this file is NOT loaded — compilation is skipped.

## Probe

bash: "latexmk --version 2>/dev/null"
→ success: compile_available=true, load this file
→ failure: compile_available=false, skip (compile_status: "skipped")

## Working Directory

cwd = .aether/research/publication/

```bash
cd .aether/research/publication/
latexmk -pdf -interaction=nonstopmode -output-directory=build/ manuscript.tex
```
````

Intermediate files (.aux, .log, .fls, etc.) go to build/ subdirectory.

## Compile Verification (after each writer output)

1. Run latexmk (command above)
2. Failure → read build/manuscript.log → identify error → fix → retry (max 2)
3. 2 次仍失败 → compile_status="fail" + 在 digest 报告错误摘要
4. 成功 → compile_status="pass"

## Template Compile Test (write-paper Step 0, for non-preset templates)

对 paper-template 返回的非预设模板（discovered/synthesized）试编译:

```bash
cd /tmp/template_check/
latexmk -pdf -interaction=nonstopmode <journal>.tex
```

- 编译通过 → source 保持 "discovered"|"synthesized"
- 不可编译 → source = "unverified" → 触发 Step 0 Checkpoint

> 此测试仅在 compile_available=true 时执行。compile_available=false 时
> 所有非预设模板保持原 source，不经编译验证。

```

---

## 4.8 版本管理

### 目录结构

```

.aether/research/publication/
├── manifest.json # 版本元数据
├── manuscript.tex # 当前版本（最新）
├── drafting_reasoning.md # writer 推理记录
├── modification-list.md # 最新修改指令（给 writer）
├── modification-reasoning.md # 最新裁决推理 + traceability（审计）
├── references.bib
├── review.md # 最新审稿报告
├── response.tex # [respond mode] 最新回复信
├── figures/
├── build/ # [latexmk 可用时] 编译中间文件
└── versions/
├── v1/
│ ├── manuscript.tex
│ ├── drafting_reasoning.md
│ ├── modification-list.md # 产生 v2 的指令
│ ├── modification-reasoning.md
│ ├── response.tex # [respond mode]
│ └── CHANGELOG.md
├── v2/
│ └── ...
└── ...

```

### 版本触发类型

| trigger | 含义 | 产生者 |
|---|---|---|
| `initial` | 首稿 / 首轮回复 | Step 1 |
| `self_review_fix` | 自循环修订 | Step 2c writer 执行 referee 指令 |
| `user_revision` | 用户要求的修订 | 最终审查后用户选择"进一步修订" |

---

## 4.9 Checkpoint 分布

| 流程 | 用户介入 | Agent 自循环 | 条件性升级 |
|---|---|---|---|
| write mode | WP-C1 大纲 + WP-C2 最终版 | Reviewer→Referee→Writer (max 3) | WP-ESCALATE (cap+FATAL) |
| respond mode | RT-C1 最终回复信+修订稿 | Referee首轮→Writer→Reviewer→Referee→Writer (max 3) | RT-ESCALATE (cap+FATAL) |

### Notice vs Ask

| 类型 | 行为 | 用途 |
|---|---|---|
| **Notice** | 信息性，不阻塞，继续下一步 | 模板加载、分类完成、编译结果 |
| **Ask** | 返回 paused digest，coordinator 问用户，阻塞等回复 | 大纲确认、最终审查、cap+FATAL 升级 |

### 介入点时序

```

write mode:
WP-C1 大纲 ──→ [Writer首稿(v1)] ──→ [Reviewer→Referee→Writer ×≤3 (v2→v3→v4)] ──→ WP-C2 最终版
↑ (cap+FATAL 时 WP-ESCALATE)

respond mode:
[Referee首轮消化→Writer(v1)] ──→ [Reviewer→Referee→Writer ×≤3 (v2→v3→v4)] ──→ RT-C1 最终版
↑ (cap+FATAL 时 RT-ESCALATE)

```

---

## 4.10 信息流全景

```

publication/
├── manuscript.tex ◄──────────── paper-writer 写
├── drafting_reasoning.md ◄────── paper-writer 写
├── modification-list.md ──────── paper-referee 写 → paper-writer 读
├── modification-reasoning.md ─── paper-referee 读写 (审计+traceability)
├── review.md ─────────────────── paper-reviewer 写 → paper-referee 读
├── response.tex ──────────────── paper-referee 写 → paper-reviewer 读 (respond mode)
├── references.bib ────────────── paper-writer 读写
├── figures/ ──────────────────── paper-illustrator 写 (经 paper-writer dispatch)
├── templates/ ────────────────── paper-template 写 (discovered/synthesized)
├── manifest.json ─────────────── publication-worker 写 (唯一权威状态源)
├── 外部 referee comments ─────── 用户提供 → paper-referee 读 (respond mode)
└── persistence/\*.md + notepads/\*\* ── paper-writer 读 (首稿时)

```

角色信息可见性：

- **paper-writer**: manuscript, drafting_reasoning, modification-list, references.bib, persistence (首稿)
- **paper-reviewer**: manuscript, response.tex (如有) — 纯净，不接触 modification/reasoning/外部 comments
- **paper-referee**: review.md, manuscript, modification-reasoning, response.tex, 外部 comments, drafting_reasoning（唯一同时看"外部意见"和"内部发现"的角色）

### 跨流程信息传递（文件系统）

```

/write-paper (mode=write) prl
│ 产出 manuscript.tex + drafting_reasoning.md (v4, 经自循环打磨)
│ + manifest.json (版本历史)
▼
(投稿 → 收到真实审稿意见)
│
▼
/write-paper (mode=respond) referee_comments.txt
│ 读取当前 manuscript.tex 作为基线
│ 读取 persistence 作为证据来源
│ 产出 response.tex + manuscript.tex (修订) + manifest.json
▼
定稿投稿

```

流程间**不共享 subagent 上下文** — 信息只通过文件系统（publication 目录）传递。

---

## 验收测试

```

T4.1: paper-writer 可通过 task tool 调用 (owner: research)
T4.2: paper-reviewer 可通过 task tool 调用
T4.3: paper-referee 可通过 task tool 调用
T4.4: write-paper skill 经 publication-worker 承载 (coordinator 不加载 skill 内容)
T4.4b: publication-worker 是独立 subagent (不含 Path 3 state machine 上下文)
T4.5: paper-template 预设模板 prl/prd/jhep 存在且 validate\*template.py 通过
T4.6: 请求无预设期刊时，paper-template discovery 模式通过网络搜索获取模板
T4.7: discovered/synthesized 模板写入项目内 .aether/research/publication/templates/
T4.7b: 公共复制到 ~/.aether/skills/paper-template/templates/ 需用户确认后由 coordinator 执行
T4.8: paper-writer 首稿从 research persistence 读取 (ROADMAP/PLAN/VERIFICATION/EXECUTION.md, 后者 runtime-generated)
T4.9: paper-writer 产出 drafting_reasoning.md (persistence→article 推理记录)
T4.10: paper-writer 修订时只读 modification-list.md (不读 review.md/response.tex)
T4.11: paper-reviewer 不读 modification-list.md, modification-reasoning.md,
drafting_reasoning.md, 外部 comments (purity)
T4.12: paper-reviewer dispatch prompt 不含 writer 推理上下文 (上下文隔离)
T4.13: paper-reviewer 输出 review.md (severity + location + evidence + suggested fix)
T4.14: paper-reviewer 不加载 gpd-\* skill (物理验证归 Path 3, 审稿只做表述对照)
T4.14b: paper-reviewer 无 skill_refs, 不使用 skill tool 加载 gpd-\*
T4.15: paper-reviewer 无 task 权限 (不 dispatch subagent)
T4.16: paper-referee 产出 modification-list.md + modification-reasoning.md (推理+traceability)
T4.17: paper-referee 不编辑 manuscript.tex (只声明修改)
T4.18: paper-referee 对 disputed claim 引用 Qn_VERIFICATION.md 作为证据 (不重新运行 gpd-verification)
T4.19: paper-referee accept/rebut 与 modify/no-modify 是两个独立轴 (4 种组合)
T4.20: respond mode 中每个外部 comment 都有 response.tex 条目
T4.21: respond mode 中内部 review 发现不产生 response.tex 新条目
T4.22: paper-referee traceability 矩阵正确追踪外部 comments 和内部 findings
T4.23: paper-referee 检测到 reviewer 重复发现已 reject 的问题 → 翻转为 accept
T4.24: paper-writer/paper-referee dispatch research-explorer 时 delegation_depth=0
T4.24b: paper-writer dispatch paper-illustrator 时 delegation_depth=0
T4.25: paper-writer/paper-referee 不 dispatch research-explorer/paper-illustrator 以外的 subagent
T4.25b: paper-illustrator 是叶子节点，不 dispatch 任何 subagent
T4.25c: paper-illustrator 产出的每个 figure 有可追溯的 data_source（无 fabricated data）
T4.26: Reviewer→Referee→Writer 循环 max 3 iterations
T4.27: 循环终止条件: 无 FATAL+MAJOR 或 无 modifications
T4.28: 循环达 cap 仍有 FATAL → 触发升级问用户
T4.29: 每次修订写入新 versions/v[N]/ (不覆盖已有版本) + CHANGELOG.md + manifest.json 更新
T4.30: 会话中断后读 manifest.json.workflow (status+step+iteration+checkpoint) 可恢复到正确 step
T4.30b: Entry Gate 检查 publication/manifest.json 发现 pending 项目（不依赖 STATE.md）
T4.30c: publication 完全不写 STATE.md（旁路原则彻底贯彻）
T4.30d: publication-worker 不声明 research-state MCP（旁路结构性体现）
T4.31: manuscript.tex 中每个 \cite{} 在 references.bib 有对应条目
T4.32: references.bib 中每个条目至少被 \cite{} 一次
T4.32b: references.bib 格式对齐期刊 citation_style（字段规范、entry type、缩写）
T4.33: 若系统有 latexmk，编译验证执行；无则降级为 skipped + Notice
T4.34: 所有 agent 的 file_scope 限制写操作到 .aether/research/publication/\*\*
(paper-template Mode 2 写项目本地 publication/templates/，
不再写 ~/.aether/skills/ — 公共复制由 coordinator 经用户确认执行)
T4.35: write-paper skill 支持 mode=write 和 mode=respond
T4.36: publication phase 不调 advance_plan, 不调 validate_file_locations, 不写 state.json, 不写 STATE.md
T4.36b: research-worker.md 零修改 (publication-worker 独立承载 Path 4)
T4.37: Entry Gate Path 4 正确分类 publication task 并注入 mode 参数
T4.39: 删除所有 publication agent/skill 文件后，research/build 核心行为不变
T4.40: 删除 publication agent/skill 后 Agent.list() 不含 paper-\*/publication-worker, Skill.available(build) 不含 write-paper

```

---

## 回退安全

- 删除 `.aether/agent/{publication-worker,paper-writer,paper-reviewer,paper-referee,paper-illustrator}.md` + `.aether/skills/{write-paper,paper-template}/` + `.aether/research/publication/` 后，research/build 核心行为不变。
- publication agent 为 `owner: research` 子集，删除后不影响 research agent 的其他 subagent（research-worker/explorer/verifier/local-executor/gpd-\*）。
- **research-worker.md 零修改**——publication-worker 独立承载 Path 4，删除 publication-worker.md 即可完全回退。
- publication 产物目录 `.aether/research/publication/` 独立于 `.aether/research/persistence/` 和 `.aether/research/notepads/`，删除不影响 research 状态机。
- publication 不写 STATE.md / state.json，删除 publication 后 Entry Gate 的 `publication/manifest.json` 检查无结果，自动跳过，无残留逻辑。
- manifest.json.workflow 块是 publication 唯一权威状态源，删除 publication 目录即清理全部 publication 状态。
- paper-template 的 discovered/synthesized 模板写入项目内 `publication/templates/`，公共复制需用户确认由 coordinator 执行，不影响预设模板。
- Entry Gate Path 4 新增行，删除后退回 Path 0-3。
- publication 不经 state machine，删除 publication 相关代码不影响 state.json / advance_plan / validate_file_locations。
```

---

## 附录

### A.1 publication 脱离 state machine 的必要性论证

#### 核心论证：控制流根本不匹配

publication 的控制流与 Path 3 state machine 的控制流**根本不匹配**，强行适配会引入更多复杂度。

**state machine 提供的能力 vs publication 的需求**：

| state machine 能力                           | publication 是否需要 | 不匹配原因                                                                                                        |
| -------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `advance_plan` 线性 phase 推进               | ❌ 不需要            | publication 是**数据驱动的循环**（Reviewer→Referee→Writer ×N），不是线性 phase                                    |
| `validate_file_locations` persistence 白名单 | ❌ 不需要            | publication 产物在 `publication/`，不在 persistence/                                                              |
| audit-repair loop（repair_count + re-audit） | ❌ 语义不匹配        | state machine 的 audit loop 是 2 角色（audit + repair）；publication 循环是 3 角色（reviewer + referee + writer） |
| debate multi-round（5 sub_phases）           | ❌ 无关              | publication 无辩论机制                                                                                            |
| `state.json.execution` 波次管理              | ❌ 无关              | publication 无执行波次                                                                                            |
| `phase_commits` git rollback                 | ⚠️ 部分需要          | 已由 versions/v[N] + manifest.json 版本管理覆盖                                                                   |

**若强行塞入 state machine 的代价**：

1. **phase 定义膨胀**：需新增 `phase_publication_draft` / `_review` / `_referee` / `_revise` / `_final` 等 5+ phase，每个都要在 `VALID_PHASES` 注册 + advance_plan 处理转换。但 publication 循环是**数据驱动**的（review 有无 FATAL 决定是否继续），不是顺序驱动，硬塞会得到扭曲的状态机。

2. **respond mode 的非线性更难适配**：respond 首轮是 Referee→Writer（跳过 Reviewer），后续才是 Reviewer→Referee→Writer。这种"首轮特殊 + 后续统一"在 state machine 里需特殊 phase（如 `phase_respond_first_round`），进一步膨胀。

3. **Session Recovery 反而更复杂**：若走 state machine，恢复需解析 `state.json.publication` 子对象（iteration, checkpoint, mode, sub_step...）。独立的 manifest.json 只需 `status + paused_at` 两字段。state machine 的恢复逻辑（session-recovery.md 284 行）远超 publication 所需。

#### 脱离的代价（已由独立机制缓解）

| 代价                        | 缓解机制                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| 需独立 Session Recovery     | manifest.json workflow 块（status+step+iteration+checkpoint，见 §4.7.3 + §4.6 Session Recovery） |
| 需独立版本管理              | versions/v[N] + CHANGELOG + manifest.json                                                        |
| STATE.md 不参与 publication | publication 不写 STATE.md，Entry Gate 检查 publication/manifest.json 发现 pending（见 §4.1.1）   |

#### 结论

脱离是必要的。publication 的控制流（数据驱动循环 + 双模式）与 state machine（顺序驱动线性 phase）根本不匹配。代价是独立的恢复机制，但该机制因 publication 状态空间小（`{step} × {iteration 1-3} × {checkpoint}`）而简单。
