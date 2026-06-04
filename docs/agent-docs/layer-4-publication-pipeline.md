# Layer 4: Publication Pipeline

> 前置依赖: Layer 0-3（核心安全 + Agent 基础设施 + Research 配置 + MCP 服务器）
> 本文档是 5 层重构计划的第五层。**完全独立于 research agent**，作为特定 subagent + skill 实现。
> 可在任何 agent mode 中通过 task tool 或 skill 调用。

---

## 上下文

| Layer       | 状态       | 简介                                                              |
| ----------- | ---------- | ----------------------------------------------------------------- |
| Layer 0     | 已完成     | Permission/Discipline/Info 扩展                                   |
| Layer 1     | 已完成     | mode-switch/fallback/background                                   |
| Layer 2     | 已完成     | Research 配置层                                                   |
| Layer 3     | 已完成     | MCP 服务器 + 参考文档                                             |
| **Layer 4** | **本文档** | Publication 管线（write-paper、peer-review、respond-to-referees） |

---

## 设计原则

- **完全独立**: 不依赖 research mode，可在 build/plan/general 中通过 skill 或 task tool 调用
- **skill + subagent 双入口**: 用户可以通过 `/write-paper` skill（轻量 inline）或 `task(subagent_type="gpd-paper-writer")` subagent（深度）两种方式使用
- **期刊模板**: 通过参考文档提供，不硬编码

---

## 4.1 gpd-paper-writer Subagent

### 文件

`.opencode/agents/gpd-paper-writer.md`

```yaml
---
description: Write academic manuscripts in LaTeX with journal-specific formatting
mode: subagent
base_agent: general
skill_refs:
  - write-paper
prompt_append: |
  <system-reminder>
  # Paper Writer Role

  Write a complete academic manuscript in LaTeX based on research project artifacts.

  ## Workflow
  1. Read research artifacts (SUMMARY.md, derivations, figures, tables)
  2. Select journal template from references/paper-templates/
  3. Structure paper: Abstract → Introduction → Methods → Results → Discussion → Conclusion
  4. Write LaTeX with proper citations, cross-references, and figure/table labels
  5. Include ASSERT_CONVENTION headers for any physics derivations
  6. Deliver: .tex file + .bib file + any figure scripts

  ## Journal Templates
  Available in .opencode/get-physics-done/paper-templates/:
  - prl.tex (Physical Review Letters)
  - nature.tex (Nature)
  - jhep.tex (Journal of High Energy Physics)
  - apj.tex (Astrophysical Journal)
  - mnras.tex (Monthly Notices of the RAS)
  - jfm.tex (Journal of Fluid Mechanics)

  ## Notation Consistency
  Check conventions via gpd-conventions MCP before writing.
  Ensure all symbols match convention lock throughout the manuscript.
  </system-reminder>
---
```

---

## 4.2 gpd-referee Subagent

### 文件

`.opencode/agents/gpd-referee.md`

```yaml
---
description: Generate point-by-point responses to academic peer review comments
mode: subagent
base_agent: general
skill_refs:
  - respond-to-referee
prompt_append: |
  <system-reminder>
  # Referee Response Role

  Generate professional point-by-point responses to peer review comments.

  ## Three-Part Structure
  For each referee comment:
  1. "The referee wrote:" — exact quote of the comment
  2. "Our reply:" — evidence-based, polite, objective response
  3. "Changes:" — specific manuscript modifications made

  ## Principles
  - Address every comment, even seemingly minor ones
  - Provide evidence (calculations, references, new data) for disputed claims
  - Acknowledge valid criticisms and describe concrete changes
  - Don't dodge or dismiss concerns
  - Use gpd-verification MCP tools to verify any new claims

  ## Output
  LaTeX file: Response-and-changes.tex
  </system-reminder>
---
```

---

## 4.3 write-paper Skill

### 文件

`.opencode/skills/write-paper/SKILL.md`

```yaml
---
name: write-paper
description: Write a complete academic paper in LaTeX from research project files. Supports PRL, Nature, JHEP, ApJ, MNRAS, JFM templates.
---

# Write Paper

Write an academic paper for: $@

## In Research Mode
Use research artifacts (SUMMARY.md, derivations, figures, tables) as source material.
Dispatch gpd-paper-writer subagent via task tool for full manuscript generation.

## In Other Modes
Inline paper writing:
1. Gather material from conversation context + project files
2. Select journal template (default: PRL)
3. Write LaTeX directly, using .opencode/get-physics-done/paper-templates/<journal>.tex as starting point
4. For physics papers, check conventions before writing

## Available Templates
- `/prl` — Physical Review Letters
- `/nature` — Nature
- `/jhep` — Journal of High Energy Physics
- `/apj` — Astrophysical Journal
- `/mnras` — Monthly Notices of the RAS
- `/jfm` — Journal of Fluid Mechanics

## Output
.tex file + .bib file + figure/table scripts
```

---

## 4.4 peer-review Skill

### 文件

`.opencode/skills/peer-review/SKILL.md`

```yaml
---
name: peer-review
description: Systematic peer review of research artifacts and manuscripts. Evaluate methodology, statistics, reproducibility, ethics, and reporting standards.
---

# Peer Review

Review the manuscript/research at: $@

## In Research Mode
Dispatch gpd-reviewer subagent via task tool for systematic review.

## In Other Modes
Inline review using structured dimensions:
- Methodology soundness
- Statistical rigor
- Reproducibility
- Ethics considerations
- Reporting standards
- Figure integrity

For each issue: severity (FATAL/MAJOR/MINOR/INFO) + location + suggested fix.
```

---

## 4.5 respond-to-referees Skill

### 文件

`.opencode/skills/respond-to-referees/SKILL.md`

```yaml
---
name: respond-to-referees
description: Generate point-by-point responses to academic peer review comments and revise the manuscript. Three-part structure: referee quote → reply → changes.
---

# Respond to Referees

Respond to referee comments for: $@

## In Research Mode
Dispatch gpd-referee subagent via task tool for full response generation.

## In Other Modes
Inline response:
1. Read the referee comments and original manuscript
2. For each comment, write three-part response (quote → reply → changes)
3. Use gpd-verification MCP for any new claims
4. Deliver: Response-and-changes.tex + revised manuscript

## Principles
- Address every comment
- Provide evidence for disputed claims
- Acknowledge valid criticisms
- Describe concrete manuscript changes
```

---

## 验收测试

```
T4.1: gpd-paper-writer subagent 可通过 task tool 调用（不依赖 research mode）
T4.2: gpd-referee subagent 可通过 task tool 调用
T4.3: /write-paper skill 可在 build mode 中调用
T4.4: /peer-review skill 可在 build mode 中调用
T4.5: /respond-to-referees skill 可在 build mode 中调用
T4.6: gpd-paper-writer 生成 .tex + .bib 文件
T4.7: gpd-referee 生成 Response-and-changes.tex（三部分结构）
T4.8: journal templates 存在于 .opencode/get-physics-done/paper-templates/ 中
T4.9: 删除所有 publication agent/skill 文件后，核心行为不变
```
