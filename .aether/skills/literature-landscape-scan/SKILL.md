---
name: literature-landscape-scan
owner: research
description: |
  文献景观扫描，可选调用，非强制 phase。产出 <workdir>landscape_map.md。
  由 research-worker 调用。可选——analysis 后 framing 前按需调用。
  若扫描中发现 analysis.md 的 gap 识别有误或遗漏，可回写补充 analysis.md。
---

# Literature Landscape Scan — 文献景观扫描

landscape 是可选 phase。analysis 后 framing 前按需调用，非强制执行。

## Lifecycle Contract

**Input**: `<workdir>analysis.md` + `persistence/research_state.md`

**Output**: `<workdir>landscape_map.md`（若发现 analysis.md 遗漏 gap，可回写补充 analysis.md）

**MUST NOT**: Write PLAN.md (framing's responsibility). Overwrite analysis.md — only append/update gap supplements.

## Procedure

### Step 1: Read State & Context

1. Read `persistence/research_state.md` + `<workdir>analysis.md`
   - 获取 Research Goal / Current Understanding / Failed Attempts
   - Failed Attempts 中的失败方法作为景观扫描的排除线索
   - analysis.md 的 gap 识别作为扫描聚焦点（非无目标泛搜）

### Step 2: Define Scope and Search Terms

1. Extract key concepts from analysis.md's gap identification
2. Identify 3-6 key search terms (primary concepts + synonyms from analysis.md findings)
3. Define time range based on field activity level
4. Determine domain-specific databases:
   - Physics: paper-search skill (arXiv + INSPIRE-HEP + alphaxiv overview)
   - CS: arXiv cs.\*, Semantic Scholar, Google Scholar
   - Biomedical: PubMed, bioRxiv, Semantic Scholar
   - Cross-disciplinary: Semantic Scholar, OpenAlex

### Step 3: Multi-Database Parallel Search

Dispatch research-explorer subagent(s) for parallel searches:

1. **arXiv**: Use paper-search skill with category-appropriate queries
2. **broader coverage**: Use paper-search skill for AI-enhanced discovery beyond keywords
3. **Semantic Scholar**: Cross-disciplinary coverage and citation graphs
4. **INSPIRE-HEP** (physics): Citation tracking and highly-cited paper identification

Scale:

- 2-3 search angles → 1 research-explorer subagent
- 4-6 search angles → 2 research-explorer subagents (concurrent)

### Step 4: Deep Understanding of Key Papers

For papers identified as potentially important:

1. Extract arXiv IDs from search results
2. Use paper-search skill for structured understanding
3. Fallback to arXiv abstract via paper-search skill
4. Classify papers by: theoretical approach, methodology, domain subfield

### Step 5: Map the Landscape

Classify papers into a structured landscape:

1. **domain map**: 研究领域的方法/问题分类图谱。据 analysis.md 的 gap 和 Research Goal 聚焦扫描，非无目标泛搜
2. **school classification**: 识别不同学派/方法路线及其核心差异。据 Failed Attempts 排除已失败方向
3. **timeline**: 关键论文的时间线与演化关系
4. **controversies**: 标注领域内争议点及各方立场（须有 [src:id] 引用支撑）
5. **open problems**: 开放问题列表（供 framing 消费）

### Step 6: Write <workdir>landscape_map.md

```markdown
# Literature Landscape: [Topic]

## Domain Overview

[1-2 paragraph summary]

## Schools of Thought

### School 1: [Name]

- **Core idea**: [summary]
- **Key assumptions**: [list]
- **Representative papers**: [src:id]
- **Proponents**: [key authors/groups]

### School 2: [Name]

[same structure]

## Key Paper Timeline

| Year | Paper | Impact | School |
| ---- | ----- | ------ | ------ |

## Controversies

### Controversy 1: [Topic]

- **Debate**: [what]
- **School A position**: [position + evidence] [src:id]
- **School B position**: [position + evidence] [src:id]

## Open Problems (gap_list)

1. **[Problem 1]**: [Description] — Significance: [H/M/L] — Difficulty: [H/M/E]
2. **[Problem 2]**: [Description] — ...
```

若扫描中发现 analysis.md 的 gap 识别有误或遗漏，可回写补充 analysis.md。

### Step 7: Update persistence/research_state.md

- 推荐更新: Phase History 追加 landscape✓ / Current Understanding 追加景观发现
  （agent 据发现可灵活更新其他节，不限于以上推荐）
- 若回写了 analysis.md，在 Phase History 注明 "analysis.md updated by landscape"

### Step 8: 质量门

1. worker 跑 scripts（bash，确定性）:
   - `check_artifacts.py <research_state.md> <workdir>landscape_map.md` → 验证文件存在非空
   - `check_sources.py <workdir>landscape_map.md` → 验证 landscape_map.md 中 [src:id] 引用都有下载文件
   - 不过 → worker 自补，重跑 scripts
2. worker dispatch research-audit agent（fresh context，避免 self-review bias）:
   - sub-subagent 读 `<workdir>landscape_map.md`，按以下方向审:
     学派分类是否准确 / 时间线是否完整 / 争议标注是否有据 / 覆盖度是否充分
   - 输出 FATAL/CONCERN/PASS 报告
3. worker 读报告:
   - PASS → 通过
   - CONCERN/FATAL → 自修（推荐 2 次），修后重新 dispatch 审计 sub-subagent
   - 严重问题（无法自修）→ 须写明原因，写入 Last Phase Result issues

### Step 9: 回传 status 信号

更新 research_state.md 的 Last Phase Result 节 (phase=landscape / status / summary / issues)，
回传 status 信号 (completed | needs_attention)

## Subagent Dispatch

- Dispatch `research-explorer` subagent for parallel database searches
- FORBIDDEN: Dispatching explore or general subagents — use research-explorer only

## Integrity

Never fabricate sources. Every school, paper, and controversy must cite verifiable references [src:id].
