---
name: analysis
owner: research
description: |
  深度分析 skill。澄清研究目标、收集信息、综合分析、产出 analysis.md 并初始化/更新 research_state.md。
  由 research-worker 调用。产出 <workdir>analysis.md。
---

# Analysis — 深度分析

analysis 是研究起点。澄清研究目标、收集信息、综合分析、产出 analysis.md（详细分析）并初始化/更新 research_state.md（单一状态来源）。

## Lifecycle Contract

**Input**: persistence/research_state.md（恢复上下文）+ 用户研究 prompt（新项目）

**Output** (MUST write all):

1. `<workdir>analysis.md` — 详细分析（含推理过程、[src:id] 引用、gap 识别）
2. `persistence/research_state.md` — 初始化或更新（Research Goal / Current Understanding / Active Workdir / Phase History）

**MUST NOT**: Write PLAN.md (framing's responsibility). Write VERIFICATION.md (execution's responsibility). Write audit reports.

## Procedure

### Step 1: Read research_state.md

1. Read `persistence/research_state.md`
   - 存在 → 恢复上下文（Research Goal / Current Understanding / Phase History / Human Directives）
     - Human Directives：agent 理解意图后自然融入分析，处理后将其标记从 `[pending]` 改为 `[processed×]`（保留可追溯）
   - 不存在 → 新项目，使用 dispatch prompt 中的用户研究 prompt

### Step 1b: Create slug & workdir (新项目时)

从 Research Goal 派生 slug（关键词连字符化，≤30 字符），
读 Workdir History 防冲突（冲突则追加 -2 / -3），
创建 `notepads/<slug>/` 目录，
更新 research_state.md 的 Active Workdir + Workdir History。

回退重入时：不重新创建 slug，使用现有 Active Workdir。

### Step 2: Clarify the Research Question

- Extract the core research question from the user's prompt
- Identify subtopics, dimensions, and required angles
- Note local reference materials mentioned (files, code, tools)
- Determine the research domain (physics, CS, cross-disciplinary)

### Step 3: Gather Information

- **Local files**: Read any referenced local files (papers, code, data). Use read/glob/grep tools directly.
- **Literature**: Dispatch research-explorer subagent for parallel database searches (arXiv, INSPIRE-HEP, Semantic Scholar). 文献下载委托给 research-explorer，analysis 不关注下载路径/registry 细节。
- **Web**: Use websearch/webfetch for supplementary context

### Step 4: Synthesize Findings

- Identify patterns, themes, and key insights
- Note areas of consensus and disagreement
- Map the research landscape at a high level (schools, approaches, methods)
- Identify what is known vs what needs further investigation
- Prioritize local literature copies (literatures/) for citation verification over secondary web search
- Identify gaps — these feed into framing (and optionally landscape)

### Step 5: Write <workdir>analysis.md

analysis.md 是 analysis phase 的详细工作产物，兼具输出与推理记录功能。
须包含详细的推理过程（从文献到 gap/方向的论证链，含 [src:id] 引用与证据），
不能直接简单给出结论。research_state.md 的 Current Understanding 是从中提取的摘要。
下游消费者（landscape/framing/debate/audit）读取 analysis.md 获取详细论证依据。

```markdown
# Analysis: [topic]

## Executive Summary

[当前结论]

## Key Findings

- **[Finding 1]**: [当前成立的发现、证据强度、来源] [src:id]
- **[Finding 2]**: [当前成立的发现、证据强度、来源] [src:id]

## Detailed Analysis

### [Subtopic 1]

[支持当前结论的推理链，含 citations [src:id]]

### [Subtopic 2]

[支持当前结论的推理链，含 citations [src:id]]

## Rejected Directions / Failed Attempts

- [当前已排除的方法及证伪原因]

## Gaps Identified

- [Gap 1]: [供 framing 消费的当前 gap] — significance: [H/M/L]
- [Gap 2]: [供 framing 消费的当前 gap] — significance: [H/M/L]

## Downstream Implications

[对 framing / debate / execution 的影响]

## Revision History / Supersession Notes

[历史版本如何被替代、重启原因、旧结论为何降级或剔除；可引用历史副本，不重复全文]

## Sources / Reproduction

[src:id] [Full citation / script / sample / environment]
```

### Step 6: Initialize or Update persistence/research_state.md

- 新项目: 创建 research_state.md，填充 Research Goal / Current Understanding / Active Workdir / Phase History
- 回退重入: 据发现灵活更新相关节（推荐更新 Current Understanding + Phase History，
  但 agent 据发现可更新其他节如 Failed Attempts / Questions/Claims 等）

research_state.md 模板（13 节）:

```markdown
# Research State

## Active Workdir

notepads/<slug>/

## Workdir History

- notepads/<slug>/ ([date], 目标: [简述])

## Research Goal

[研究目标]

## Current Understanding

[已确认正确(带证据) + 已验证为错(带失败原因) + 不确定性]

## Questions/Claims

- Q1: [问题] — status: open
  method: [方法] dependencies: [] notes: [关键发现]

## Dependency Graph

Q1 → Q2

## Failed Attempts

[验证为错的方法(防止重试)]

## Phase History

- analysis ✓ (commit abc123) — 产出 <workdir>analysis.md

## Last Phase Result

- phase: analysis
- status: completed
- summary: "[简述]"
- issues: []

## Human Directives

- [pending] (待处理)
- [processed×] (已执行, 保留可追溯)

## Open Decisions

- [ ] [待决事项]

## Conventions

[研究约定值，由 agent 灵活写入]

## Next To Handle

[当前要做的事/刚收到的人类指示待办]
```

### Step 7: 质量门与回传（worker 协议）

完成 Step 1-6 后，质量门与回传由 worker 统一执行，不在本 skill 重复：

- 质量门按 `research-audit` skill §1 runbook（worker 跑 scripts + dispatch research-audit agent 审 `analysis.md`，方向见该 skill §2 对应行 + 自修）
- 回传按 `research-worker` Worker Return 协议写入 Last Phase Result（phase=analysis / status / summary / issues）+ 回传 status 信号 (completed | needs_attention)

## Subagent Dispatch

- Dispatch `research-explorer` subagent for parallel literature searches
- FORBIDDEN: Dispatching explore or general subagents — use research-explorer only

## Source Evaluation

- Peer-reviewed journals: highest credibility
- arXiv preprints: check for subsequent peer-reviewed publication
- paper-search skill: verify claims against original paper
- INSPIRE-HEP: citation counts and community endorsement
- Local files: treat as primary sources with direct verification

## Integrity

Never fabricate sources. Every claim must cite [src:id] with a downloaded file.
