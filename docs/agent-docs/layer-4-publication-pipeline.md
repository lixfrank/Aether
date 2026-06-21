# Layer 4: Publication Pipeline

> 前置依赖: Layer 0-3（核心安全 + Agent 基础设施 + Research 配置 + MCP 服务器 + Skills/Scripts 计算层）
> 本文档是 5 层重构计划的第四层。置于 research 命名空间下（`owner: research`），复用 research-conventions MCP、research-explorer（承载 paper-search）、gpd-\* skills。
> publication 仅从 `owns: [research]` 的 agent（即 research primary）可达。经 research-worker（phase=`publication`）承载，research-worker 加载 write-paper skill 并在其干净上下文中执行编排逻辑。

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

- **复用 research 基础设施**：所有 agent/skill 为 `owner: research`，复用 `research-conventions` MCP、`research-explorer`（承载 paper-search skill）、gpd-\* skills。
- **单一 skill，双模式**：`write-paper` skill 通过 `mode=write|respond` 区分起草新稿与回复审稿。两模式共用同一条 `Reviewer→Referee→Writer` 循环，差异仅在首轮入口与是否维护 response.tex。
- **编排 skill 经由 research-worker 承载**：Coordinator 不直接加载 publication skill 内容，而是 dispatch research-worker（phase=`publication`），research-worker 加载 write-paper skill 并在其干净上下文中执行编排逻辑（与 phase_analysis/phase_framing 等同构）。
- **State machine 旁路**：publication 是独立工作流 — 不调 `advance_plan`、不经 `validate_file_locations`、不读写 `state.json`。版本历史由 publication 目录下的 manifest.json 管理。
- **三角色职责分离**：
  - **paper-writer**（执行层）：只读 modification-list.md（纯执行指令）→ 改 manuscript.tex → 记录 drafting_reasoning.md
  - **paper-reviewer**（检测层）：只审稿件质量（+ response.tex 一致性）→ 产出 review.md。不接触外部 comments，不接触 modification 文件
  - **paper-referee**（裁决+翻译层）：读 review.md + 外部 comments → 裁决每条 issue → 产出 modification-list.md（给 writer）+ modification-reasoning.md（推理+traceability，审计用）+ response.tex（对外部意见的回复）
- **最小人类介入**：用户只在常规检查点（大纲确认、最终修订版审查）+ 条件性升级（cap+FATAL）介入。
- **版本管理**：每次修订生成版本快照 + CHANGELOG，manifest.json 追踪版本历史。

---

## 架构总览

```
.aether/
├── agent/
│   ├── paper-writer.md           # 新增 — 执行层
│   ├── paper-reviewer.md         # 新增 — 检测层
│   └── paper-referee.md          # 新增 — 裁决+翻译层
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
    └── publication/              # 运行时产物目录
        └── <project>/            # slug 由 coordinator 定义
            ├── manifest.json
            ├── manuscript.tex
            ├── drafting_reasoning.md
            ├── modification-list.md
            ├── modification-reasoning.md
            ├── references.bib
            ├── review.md
            ├── response.tex          # [respond mode]
            ├── figures/
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

Entry Gate 分类表新增一行：

| Condition                                                                                         | Path                    | Workflow                                                          |
| ------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------- |
| Publication task（含"写论文"、"write paper"、"起草稿件"、"回复审稿"、"respond to referee"等意图） | **Path 4: Publication** | Dispatch research-worker (phase=publication, mode=write\|respond) |

**Path 4 分类规则**：

- 用户明确要求写论文/起草稿件，且无外部审稿意见文件 → `mode=write`
- 用户提供审稿意见文件，或明确要求回复审稿 → `mode=respond`
- 歧义时问用户

**Path 4 执行**：

```
1. coordinator 确定 mode (write|respond) + project slug
2. dispatch research-worker:
   task(description: "publication phase",
        subagent_type: "research-worker",
        prompt: {
          phase: "publication",
          mode: [write|respond],
          project_slug: "[slug]",
          journal: "[journal key, write mode]",
          referee_comments: "[path, respond mode]"
        })
3. research-worker 加载 /write-paper skill，按 mode 执行
4. 遇到 checkpoint → research-worker 返回 paused digest → coordinator 问用户
5. 完成后 → coordinator 展示最终产物
```

**project slug 定义**（coordinator 负责）：

- 若有 active research project → 从 `ROADMAP.md` 标题或项目目录名推导
- 若无 → 问用户指定名称
- slug 注入 dispatch prompt，research-worker 用它创建 `.aether/research/publication/<slug>/`

### 4.1.2 `.aether/agent/research-worker.md` — Phase Routing 扩展

Phase Routing 表新增：

| phase             | sub_phase | Execution method                         |
| ----------------- | --------- | ---------------------------------------- |
| phase_publication | write     | Invoke /write-paper skill (mode=write)   |
| phase_publication | respond   | Invoke /write-paper skill (mode=respond) |

新增 HARD CONSTRAINT：

```
HARD CONSTRAINT: publication phase MUST NOT call advance_plan or validate_file_locations.
publication 是独立工作流，不经 state machine。版本历史由 manifest.json 管理。
```

新增 `phase_result_digest` schema（publication 专用）：

```yaml
phase_result_digest:
  phase: phase_publication
  sub_phase: write | respond
  mode: write | respond
  status: completed | paused | failed
  project_slug: "[slug]"
  checkpoint: null | "outline" | "template_unverified" | "final_review" | "escalate"
  # checkpoint 非 null 时 status=paused
  output_paths:
    manuscript: "publication/[slug]/manuscript.tex"
    manifest: "publication/[slug]/manifest.json"
    # respond mode 额外:
    response: "publication/[slug]/response.tex"
```

### 4.1.3 `.aether/skills/research-coordinator/SKILL.md` — Phase Dispatch Table

Phase Dispatch Table 新增：

| Phase             | Execution method                  | Worker dispatch parameters                                                       |
| ----------------- | --------------------------------- | -------------------------------------------------------------------------------- |
| phase_publication | Worker invokes /write-paper skill | phase=publication, mode=[write\|respond], project_slug, journal/referee_comments |

coordinator 对 publication phase 的 digest 处理：

- `status=completed` → Present 最终产物（不走 advance_plan / validate_file_locations / git commit 流程）
- `status=paused` → question tool 问用户（用 checkpoint 字段决定问题内容）
- `status=failed` → 告知用户失败原因

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
   b. 通过 → 安装到 ~/.aether/skills/paper-template/templates/<journal>.tex
   → 更新 ~/.aether/skills/paper-template/templates/template_registry.json
   (source: "discovered")
   → 发 Notice: "已安装 [journal] 模板到用户级目录，后续会话可直接复用"
   c. 失败 → 降级为合成 (Mode 2b)
5. 若无可下载模板 → 合成最小模板 (Mode 2b)

### Mode 2b: Synthesize Template

从 guidelines 提取: documentclass / class_options / citation_style / section_structure
生成骨架 .tex → validate_template.py 验证结构 →
安装到 ~/.aether/skills/paper-template/templates/<journal>.tex
→ 更新 registry (source: "synthesized")
→ 发 Notice: "已合成 [journal] 模板（未经编译验证），已安装到用户级目录"

> 注意：模板安装使用 bash (cp/cat) 写入 ~/.aether/ 目录。
> edit/write 工具受 file_scope 限制无法写入此路径，bash 不受此限制。
> 这是 paper-template 唯一允许的 file_scope 外写入。

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

三个 agent 统一 `owner: research`，deny-all + allow-list，`file_scope` 限制写操作到 `.aether/research/publication/**`。

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
  - gpd-conventions
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
  EXCEPTION: paper-template Mode 2 may write templates to ~/.aether/skills/paper-template/
- MUST NOT fabricate citations — every \cite{} must have a .bib entry
- MUST NOT fabricate references — use research-explorer (paper-search) for any new citation
- When dispatching subagents: ONLY dispatch research-explorer (delegation_depth: 0).
  FORBIDDEN: dispatching any other subagent.

## Input

### First draft (write mode, no modification-list.md yet)

Read from .aether/research/persistence/:

- ROADMAP.md — research scope & motivation
- PLAN.md — methodology & contract targets
- VERIFICATION.md — verified results & computational oracle
- EXECUTION.md — execution results & data
  Plus .aether/research/derivations/ and figures/ if present.
  Write manuscript.tex from scratch following the confirmed outline.
  Record in drafting_reasoning.md: persistence→section mapping, narrative
  decisions, data transformations, citation choices.

### Revision (modification-list.md present)

Read modification-list.md — pure execution instructions.
Each item: {location, current, target, priority}.
Apply each modification to manuscript.tex.
Update drafting_reasoning.md with revision reasoning.
Do NOT judge whether modifications are justified — just execute.
Do NOT read review.md, response.tex, or external comments.

## Read/Write Permissions

- READ: modification-list.md, drafting_reasoning.md (previous version),
  persistence files (first draft only)
- WRITE: manuscript.tex, drafting_reasoning.md, references.bib
- DO NOT READ: review.md, modification-reasoning.md, response.tex,
  external referee comments

## Convention Handling

- If convention lock exists: call convention_lock_status MCP →
  add ASSERT_CONVENTION annotations to derivation sections
  (形式由 writer 自行判断 — 可用 LaTeX 注释或自定义宏)

## Citation Pipeline

- Reuse .bib from paper-search downloads (.aether/research/literatures/\*/references.bib)
- For new references during writing → dispatch research-explorer
  (delegation_depth: 0) with search intent → research-explorer loads
  paper-search skill, executes search + download → extract .bib entry
  → append to references.bib
- Validate: every \cite{} has a .bib entry; every .bib entry is cited

## Compile Verification (Optional)

After writing .tex: probe `latexmk --version`. If available, follow
references/latexmk-verification.md for compile verification.
If not available → skip + warn in write_digest.

## Output

manuscript.tex + drafting_reasoning.md + references.bib + figures/ (if any)
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
skill_refs:
  - gpd-conventions
  - gpd-verification
  - gpd-errors
  - gpd-domain-check
fallback_models:
  - alibaba-cn/deepseek-v4-pro
mcp:
  research-conventions: true
output_dir: ".aether/research/publication"
file_scope:
  - ".aether/research/publication/**"
---
```

> paper-reviewer 无 `task` 权限 — 纯叶子节点，不 dispatch 任何 subagent。gpd-\* 物理检查通过 skill_refs eager 注入的 skill 内容 + `uv run scripts/xxx.py` 执行。

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

## Physics Manuscripts (additional)

Invoke gpd-\* skills (via skill_refs eager injection):

- gpd-conventions: check ASSERT_CONVENTION annotations present & consistent
- gpd-errors: screen for known LLM physics error patterns
- gpd-domain-check: apply domain-specific review criteria
- gpd-verification: spot-check key derivations via `uv run scripts/<check>.py`

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
skill_refs:
  - gpd-verification
  - gpd-conventions
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

For disputed claims:

- Computational → run gpd-verification scripts via `uv run scripts/<check>.py`
- Literature → dispatch research-explorer (delegation_depth: 0) for new references
- Data → read from research persistence or user files
  All evidence must be verifiable — no fabricated references.

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

### Entry via research-worker

```
[Coordinator] ──task(subagent_type="research-worker",
                      phase="publication",
                      mode=[write|respond],
                      project_slug="[slug]",
                      ...args)──→ [research-worker]
                                                     │
                                                skill tool
                                                     │
[research-worker] ←── write-paper/SKILL.md ── [skill tool]
                                                     │
                                     (干净上下文: dispatch prompt + skill)
                                                     │
                                     内部 dispatch paper-writer/reviewer/referee
                                                     │
                                     遇到 Checkpoint → 返回 paused digest
                                                     │
[Coordinator] ←── paused digest ── [research-worker]
                                                     │
[Coordinator] ──question──→ [User]
                                                     │
[Coordinator] ──re-dispatch research-worker (with answer)──→ ...
```

### Procedure

```markdown
# Write Paper — Manuscript Pipeline

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
     → 继续 / 换期刊 / 手动提供模板
     → 返回 paused digest (checkpoint: "template_unverified")
4. Read research persistence:
   - ROADMAP.md → motivation & scope
   - PLAN.md → methodology & contract targets
   - VERIFICATION.md → verified results
   - EXECUTION.md → execution data
5. 生成大纲 (section structure + 每节内容来源映射)
6. Checkpoint WP-C1 [ASK USER]:
   → 返回 paused digest (checkpoint: "outline", 含大纲)
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
  → 返回 paused digest (checkpoint: "escalate")
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
→ 回到 Step 2a

## Step 3: Final Review (Checkpoint)

### write mode — WP-C2:

1. 复制最终版本 → manuscript.tex
2. 更新 manifest.json current_version
3. Checkpoint WP-C2 [ASK USER]:
   → 返回 paused digest (checkpoint: "final_review",
   含最终稿路径 + 版本历史 + review.md 摘要)
   → 用户: 批准定稿 / 要求进一步修订 (→ 回 Step 2, trigger: "user_revision")

### respond mode — RT-C1:

(详见 references/respond-mode.md §RT-C1)

1. 复制最终 → manuscript.tex + response.tex
2. 更新 manifest.json current_version + response.current_version
3. Checkpoint RT-C1 [ASK USER]:
   → 返回 paused digest (checkpoint: "final_review",
   含 response.tex + 修订稿 + 版本历史)
   → 用户: 批准定稿 / 要求修改 (→ 回 Step 2, trigger: "user_revision")

## Step 4: Present (Terminal)

输出 manuscript.tex 路径 [+ response.tex 路径] + 版本历史 + 编译状态

## Session Recovery

读 manifest.json current_version + 最后 CHANGELOG trigger:

- trigger == "initial" → 从 Step 2a 恢复 (循环)
- trigger == "self_review_fix" → 从 Step 2a 恢复 (继续 iteration)
- trigger == "user_revision" → 从 Step 2 恢复
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

Input sources (research persistence):

- ROADMAP.md → motivation & scope
- PLAN.md → methodology & contract targets
- VERIFICATION.md → verified results
- EXECUTION.md → execution data

Record persistence→section mapping in drafting_reasoning.md.
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
Verify claims from manuscript content.

For physics manuscripts: invoke gpd-conventions + gpd-errors +
gpd-domain-check + gpd-verification (spot-check key derivations via
`uv run scripts/<check>.py`).

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
Evidence sources (research persistence):

- VERIFICATION.md, EXECUTION.md, ROADMAP.md, PLAN.md

For EACH external comment (MANDATORY — every comment gets a response.tex entry):

1. Make accept/rebut + modify/no-modify decision
2. Write response.tex entry (three-part structure):
   - "The referee wrote:" — exact quote
   - "Our reply:" — evidence-based (accept: agreed; rebut: evidence against)
   - "Changes:" — what was/wasn't changed and why
3. If modify → add modification-list.md entry

For disputed claims: run gpd-verification scripts via `uv run scripts/<check>.py`.
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

For disputed claims: run gpd-verification scripts via `uv run scripts/<check>.py`.
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
    figures: [paths or null]
  compile_status: pass | fail | skipped
  citation_check: { cited: [N], in_bib: [N], orphan_cites: [], uncited_entries: [] }
  modifications_applied: [M1, M2, ...] # null for first draft
```

## §Review Digest (paper-reviewer output)

```yaml
review_digest:
  manuscript_version: [N]
  issues: { fatal: [N], major: [N], minor: [N], info: [N] }
  fatal_list: [issue descriptions]
  major_list: [issue descriptions]
  physics_checks: { conventions: pass|fail, errors: pass|fail, domain: pass|fail }
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
Verification: gpd-verification/ward_identity_check.py returned fail → confirms.
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
- disputed → run gpd-verification scripts via `uv run scripts/<check>.py`
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
  "project": "[slug]",
  "journal": "[journal key]",
  "current_version": "v[N]",
  "created": "[ISO date]",
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

> `response` block 仅 respond mode 使用。write mode 时该字段不存在。

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

- 读 manifest.json current_version + 最后 CHANGELOG trigger
- trigger == "initial" → 从 Step 2a 恢复 (循环)
- trigger == "self_review_fix" → 从 Step 2a 恢复 (继续 iteration)
- trigger == "user_revision" → 从 Step 2 恢复
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

cwd = .aether/research/publication/<project>/

```bash
cd .aether/research/publication/<project>/
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

.aether/research/publication/<project>/
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

publication/<project>/
├── manuscript.tex ◄──────────── paper-writer 写
├── drafting_reasoning.md ◄────── paper-writer 写
├── modification-list.md ──────── paper-referee 写 → paper-writer 读
├── modification-reasoning.md ─── paper-referee 读写 (审计+traceability)
├── review.md ─────────────────── paper-reviewer 写 → paper-referee 读
├── response.tex ──────────────── paper-referee 写 → paper-reviewer 读 (respond mode)
├── references.bib ────────────── paper-writer 读写
├── 外部 referee comments ─────── 用户提供 → paper-referee 读 (respond mode)
└── persistence/\*.md ──────────── paper-writer 读 (首稿时)

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
T4.4: paper-writer skill 经 research-worker 承载 (coordinator 不加载 skill 内容)
T4.5: paper-template 预设模板 prl/prd/jhep 存在且 validate\*template.py 通过
T4.6: 请求无预设期刊时，paper-template discovery 模式通过网络搜索获取模板
T4.7: discovered/synthesized 模板安装到 ~/.aether/skills/paper-template/templates/
T4.8: paper-writer 首稿从 research persistence 读取 (ROADMAP/PLAN/VERIFICATION/EXECUTION.md)
T4.9: paper-writer 产出 drafting_reasoning.md (persistence→article 推理记录)
T4.10: paper-writer 修订时只读 modification-list.md (不读 review.md/response.tex)
T4.11: paper-reviewer 不读 modification-list.md, modification-reasoning.md,
drafting_reasoning.md, 外部 comments (purity)
T4.12: paper-reviewer dispatch prompt 不含 writer 推理上下文 (上下文隔离)
T4.13: paper-reviewer 输出 review.md (severity + location + evidence + suggested fix)
T4.14: paper-reviewer 对物理稿件调用 gpd-conventions 检查 ASSERT_CONVENTION
T4.15: paper-reviewer 无 task 权限 (不 dispatch subagent)
T4.16: paper-referee 产出 modification-list.md + modification-reasoning.md (推理+traceability)
T4.17: paper-referee 不编辑 manuscript.tex (只声明修改)
T4.18: paper-referee 对 disputed claim 通过 gpd-verification 脚本提供计算证据
T4.19: paper-referee accept/rebut 与 modify/no-modify 是两个独立轴 (4 种组合)
T4.20: respond mode 中每个外部 comment 都有 response.tex 条目
T4.21: respond mode 中内部 review 发现不产生 response.tex 新条目
T4.22: paper-referee traceability 矩阵正确追踪外部 comments 和内部 findings
T4.23: paper-referee 检测到 reviewer 重复发现已 reject 的问题 → 翻转为 accept
T4.24: paper-writer/paper-referee dispatch research-explorer 时 delegation_depth=0
T4.25: paper-writer/paper-referee 不 dispatch research-explorer 以外的 subagent
T4.26: Reviewer→Referee→Writer 循环 max 3 iterations
T4.27: 循环终止条件: 无 FATAL+MAJOR 或 无 modifications
T4.28: 循环达 cap 仍有 FATAL → 触发升级问用户
T4.29: 每次修订写入新 versions/v[N]/ (不覆盖已有版本) + CHANGELOG.md + manifest.json 更新
T4.30: 会话中断后读 manifest.json 可恢复到正确 step
T4.31: manuscript.tex 中每个 \cite{} 在 references.bib 有对应条目
T4.32: references.bib 中每个条目至少被 \cite{} 一次
T4.33: 若系统有 latexmk，编译验证执行；无则降级为 skipped + Notice
T4.34: 所有 agent 的 file_scope 限制写操作到 .aether/research/publication/\**
(paper-template Mode 2 例外: bash 写 ~/.aether/skills/paper-template/templates/)
T4.35: write-paper skill 支持 mode=write 和 mode=respond
T4.36: publication phase 不调 advance*plan, 不调 validate_file_locations, 不写 state.json
T4.37: Entry Gate Path 4 正确分类 publication task 并注入 mode 参数
T4.38: coordinator 从 ROADMAP.md 或用户指定名称定义 project slug
T4.39: 删除所有 publication agent/skill 文件后，research/build 核心行为不变
T4.40: 删除 publication agent/skill 后 Agent.list() 不含 paper-\*, Skill.available(build) 不含 write-paper

```

---

## 回退安全

- 删除 `.aether/agent/paper-{writer,reviewer,referee}.md` + `.aether/skills/{write-paper,paper-template}/` + `.aether/research/publication/` 后，research/build 核心行为不变。
- publication agent 为 `owner: research` 子集，删除后不影响 research agent 的其他 subagent（research-worker/explorer/verifier/local-executor/gpd-\*）。
- publication 产物目录 `.aether/research/publication/` 独立于 `.aether/research/persistence/`，删除不影响 research 状态机。
- paper-template 的 discovered/synthesized 模板安装到 `~/.aether/skills/paper-template/templates/`，不影响预设模板。
- research-worker 的 phase routing 表新增 `publication` 条目，删除后退回原有 phase 集合。
- Entry Gate Path 4 新增行，删除后退回 Path 0-3。
- publication 不经 state machine，删除 publication 相关代码不影响 state.json / advance_plan / validate_file_locations。
```
