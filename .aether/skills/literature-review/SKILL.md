---
name: literature-review
description: |
  Path 2 of the research agent Entry Gate — independent workflow with its own state machine.
  Conduct comprehensive, systematic literature reviews using multiple academic databases
  (arXiv, INSPIRE-HEP, Semantic Scholar, PubMed, etc.). This skill should be used when
  the user explicitly requests a literature review, survey, or summary of existing research.
  Do NOT invoke for quick lookups (Path 1) or research projects (Path 3).
---

# Literature Review — Path 2 (Independent State Machine)

This skill implements **Path 2** of the research agent, triggered when the Entry Gate classifies a prompt as a literature review request. It has its own internal state machine, independent of the Path 3 state machine.

## Lifecycle Contract

**Input**: User's literature review request (contains "综述", "review", "总结文献", "survey", "literature review")

**Output**:

1. `output_dir/notepads/<slug>/review.md` — Main review document
2. `output_dir/notepads/<slug>/review_state.md` — Review progress tracking
3. `output_dir/notepads/<slug>/screening_log.md` — Inclusion/exclusion decisions

**State machine**: Planning → Search → Screening → Extraction → Synthesis → Verification → Completed

**MUST NOT**: Write to Path 3 persistence files (ROADMAP.md, PLAN.md for research project). Use Path 3 state.json.

**MUST NOT**: Enter Path 3 phases. This is a complete independent workflow.

## Internal State Machine

```
planning → search → screening → extraction → synthesis → verification → completed
```

State is tracked in `output_dir/notepads/<slug>/review_state.md`, NOT in STATE.md or state.json.

## Procedure

### Phase 1: Planning and Scoping

1. **Define Research Question**: Use domain-appropriate framework:
   - Clinical/biomedical: PICO (Population, Intervention, Comparison, Outcome)
   - Physics: System-Model-Expectation-Deviation (SMED)
   - General: Context-Problem-Approach-Evidence

2. **Establish Scope**: Define clear research questions, review type (narrative, systematic, scoping, meta-analysis), boundaries

3. **Develop Search Strategy**: Identify 2-4 main concepts, synonyms, Boolean operators, select minimum 3 databases

4. **Set Inclusion/Exclusion Criteria**: Date range, language, publication types, study designs

5. **Write review_state.md**: Record planning decisions, search parameters, criteria

### Phase 2: Systematic Literature Search

1. **Multi-Database Search**: Select databases based on domain:
   - Physics: arXiv (alpha-research skill), INSPIRE-HEP, alphaxiv overview
   - Biomedical: PubMed, bioRxiv
   - General: Semantic Scholar API, Google Scholar

2. **Dispatch research-explorer subagent(s)** for parallel database searches

3. **Document Search Parameters**: Record date searched, date range, search strings, result counts for each database

4. **Aggregate Results**: Combine all results, export in JSON/markdown format

### Phase 3: Screening and Selection

1. **Deduplication**: Remove duplicate entries
2. **Title Screening**: Review titles against inclusion/exclusion criteria
3. **Abstract Screening**: Read abstracts, apply criteria rigorously
4. **Deep Understanding (alphaxiv)**: For papers needing deeper analysis
5. **Full-Text Screening**: Obtain and review full texts
6. **Create PRISMA Flow Diagram**: Track screening progression
7. **Write screening_log.md**: Document all inclusion/exclusion decisions with reasons

### Phase 4: Data Extraction and Quality Assessment

1. **Extract Key Data** from each included study: metadata, methods, findings, limitations
2. **Assess Study Quality**: Domain-appropriate quality assessment tools
3. **Organize by Themes**: Identify 3-5 major themes, group studies

### Phase 5: Synthesis and Analysis

1. **Write Thematic Synthesis**: Organize by themes, NOT study-by-study
2. **Critical Analysis**: Evaluate methodological strengths, limitations, evidence quality
3. **Write Discussion**: Interpret findings, discuss implications, acknowledge limitations

### Phase 6: Citation Verification

1. **Verify All DOIs**: Use citation verification
2. **Review Verification Report**: Fix errors, re-verify
3. **Format Citations Consistently**: Choose one citation style

### Phase 7: Document Generation and Completion

1. **Write review.md**: Complete literature review document
2. **Quality Checklist**: All DOIs verified, PRISMA diagram included, citations formatted, methodology documented, limitations acknowledged
3. **Update review_state.md**: Mark as completed
4. **Clear gate classification from STATE.md**: Return to idle state
5. **Present results to user**

## MCP Integration

- research-conventions: Call convention_lock_status before starting; convention_check before finalizing
- research-state: NOT used for Path 2 — this path has its own state machine in review_state.md

## Subagent Dispatch

- Dispatch `research-explorer` subagent for parallel database searches
- Delegate verification to `research-verifier` or `gpd-verifier` subagent when needed
- FORBIDDEN: Dispatching explore or general subagents — use research-explorer only

## Notepad Output Structure

Write to: `output_dir/notepads/<slug>/`

```
output_dir/notepads/<slug>/
  review.md          — Main review document
  review_state.md    — Review progress tracking (internal state machine)
  screening_log.md   — Inclusion/exclusion decisions
  search_results/    — Raw search results from each database
```

## Integrity

Never fabricate sources. Never claim verification without evidence.
