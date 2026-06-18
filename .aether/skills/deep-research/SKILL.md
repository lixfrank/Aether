---
name: deep-research
owner: research
description: |
  Phase 1 (phase_analysis) of the Path 3 research state machine.
  Synthesizes information from multiple sources, analyzes local reference materials,
  and writes ROADMAP.md. Invoked automatically by the research agent when a
  research project is classified through the Entry Gate.
  Do NOT invoke this skill for quick lookups (Path 1) or literature reviews (Path 2).
---

# Deep Research — phase_analysis

This skill implements **Phase 1** of the Path 3 research state machine. It is invoked by the research agent after the Entry Gate classifies a prompt as a research project.

## Lifecycle Contract

**Input**: User's research prompt + any local file references

**Output** (MUST write all of these):

1. `.aether/research/persistence/ROADMAP.md` — Project definition, phase breakdown, milestones, expected deliverables
2. `.aether/research/persistence/STATE.md` — Updated with phase=phase_analysis completed
3. `.aether/research/notepads/<slug>/research_analysis.md` — Detailed analysis with citations

**State transition**: phase_analysis → phase_analysis_checkpoint (coordinator presents summary to user for direction confirmation)

**MUST NOT**: Write PLAN.md (that is phase_framing's responsibility). Write VERIFICATION.md (that is phase_execution's responsibility). Write audit reports (that is research-audit's responsibility).

## Procedure

### Step 1: Read Current State

1. Read `.aether/research/persistence/STATE.md` — confirm phase indicates gate classification complete and Path 3 selected (Current Phase field should contain "gate → Path 3" or be empty/not yet started)
2. Read `.aether/research/persistence/state.json` via research-state MCP (`get_state`)
3. Check `convention_lock_status` via research-conventions MCP if physics domain

### Step 2: Clarify the Research Question

- Extract the core research question from the user's prompt
- Identify subtopics, dimensions, and required angles
- Note local reference materials mentioned (files, code, tools)
- Determine the research domain (physics, CS, cross-disciplinary)

### Step 3: Gather Information

- **Local files**: Read any referenced local files (papers, code, data). Use read/glob/grep tools directly, NOT explore subagent.
- **Literature**: Dispatch research-explorer subagent for parallel database searches (arXiv, INSPIRE-HEP, Semantic Scholar)
- **Web**: Use websearch/webfetch for supplementary context
- For physics literature: use paper-search skill for initial search and deeper understanding

### Step 3.5: Download Referenced Papers

1. Collect all arXiv IDs / DOIs referenced in the analysis
2. Check `.aether/research/literatures/index.json` for already downloaded literature (by arXiv ID/DOI) → skip duplicates
3. Prepare `papers_to_download.json` compatible with `download_paper.py --batch` input:
   ```json
   [
     {
       "arxiv_id": "2305.12345",
       "doi": "10.1234/journal.2023.123",
       "title": "Paper title",
       "first_author": "Smith",
       "year": 2023,
       "relevance": "phase_analysis"
     }
   ]
   ```
   Field notes:
   - arxiv_id: required for arXiv papers; at least one of arxiv_id/doi must be filled
   - doi: required for non-arXiv papers; at least one of arxiv_id/doi must be filled
   - title: recommended for file naming and unavailable.md
   - first_author: recommended for file naming; fallback from authors field
   - authors: optional, comma-separated string or array
   - year: recommended for indexing and unavailable.md
   - relevance: optional, source tag (phase_analysis / phase_landscape)
   - Dedup: arxiv_id priority match, then doi. Entries with neither → skip download, record in unavailable.md (reason: "No arXiv ID or DOI provided")
4. Run download script:
   ```bash
   uv run .aether/skills/paper-search/download_paper.py --batch papers_to_download.json --output .aether/research/literatures
   ```
5. Record download results to index.json and unavailable.md
6. Do NOT block on individual download failures

### Step 4: Synthesize Findings

- Identify patterns, themes, and key insights
- Note areas of consensus and disagreement
- Map the research landscape at a high level (schools, approaches, methods)
- Identify what is known vs what needs further investigation
- Prioritize local literature copies (literatures/) for citation verification over secondary web search

### Step 5: Write ROADMAP.md

Write to `.aether/research/persistence/ROADMAP.md` with this structure:

```markdown
# Research Roadmap

## Project: [Project name]

## Research Question

[Core question extracted from user prompt]

## Phase Breakdown

### Phase 1: Analysis (current)

- Goal: [Initial research question clarification and evidence gathering]
- Status: completed
- Deliverables: research_analysis.md

### Phase 2: Landscape Expansion

- Goal: [Broad literature mapping, school classification]
- Status: pending
- Deliverables: landscape_map.md

### Phase 3: Question Framing

- Goal: [Convert gaps into falsifiable research questions]
- Status: pending
- Deliverables: PLAN.md with contract

### Phase 4: User Checkpoint

- Goal: [Present final plan, get user confirmation]
- Status: pending

### Phase 5: Execution

- Goal: [Execute PLAN.md via local-executor, verify results]
- Status: pending
- Deliverables: VERIFICATION.md

## Milestones

[Key checkpoints across phases]

## Expected Deliverables

[Final outputs the user expects]
```

### Step 6: Write Research Analysis

Write to `.aether/research/notepads/<slug>/research_analysis.md`:

```markdown
## Executive Summary

[2-3 sentence overview]

## Key Findings

- **[Finding 1]**: [Brief explanation] [1]
- **[Finding 2]**: [Brief explanation] [2]

## Detailed Analysis

### [Subtopic 1]

[In-depth analysis with citations]

### [Subtopic 2]

[In-depth analysis with citations]

## Literature Coverage Assessment

- Schools identified: [list]
- Key papers found: [count]
- Gaps needing landscape expansion: [list]

## Sources

[1] [Full citation]
[2] [Full citation]
```

### Step 7: Update State

1. Update `.aether/research/persistence/STATE.md`:
   - phase: phase_analysis completed
   - key decisions: [what was decided]
   - blockers: [any identified]
   - next_action: enter phase_analysis_checkpoint (coordinator presents summary to user)
2. Call `advance_plan` via research-state MCP
3. Output a PhaseResultDigest as your final message (see Step 8). The coordinator will route to the next phase based on the digest.

### Step 8: Output PhaseResultDigest

Output a YAML code block as your FINAL message with this schema:

```yaml
phase_result_digest:
  phase: phase_analysis
  sub_phase: null
  cycle: null
  status: completed
  research_question: "[core question from user prompt]"
  domain: [physics | cs | biomedical | cross-disciplinary]
  key_findings:
    - "[Finding 1, max 200 chars]"
    - "[Finding 2, max 200 chars]"
    - "[Finding 3, max 200 chars]"
  gaps_identified:
    - "[Gap 1, max 100 chars]"
    - "[Gap 2, max 100 chars]"
  schools_preview:
    - name: "[School Name]"
      representative_papers: ["arXiv:XXXX.XXXXX"]
  output_paths:
    roadmap: persistence/ROADMAP.md
    analysis: notepads/[slug]/research_analysis.md
  next_phase: phase_analysis_checkpoint
  skip_recommendation: null | "[justification if landscape phase can be skipped — advisory only, actual skip decision made by audit_1]"
```

MUST NOT output any other text after this YAML block. The coordinator parses this digest to route the next phase.

## Subagent Dispatch

- Dispatch `research-explorer` subagent for parallel literature searches
- FORBIDDEN: Dispatching explore or general subagents — use research-explorer only
- Provide clear scope, search terms, and database targets to subagents

## Source Evaluation

- Peer-reviewed journals: highest credibility
- arXiv preprints: check for subsequent peer-reviewed publication
- paper-search skill: verify claims against original paper
- INSPIRE-HEP: citation counts and community endorsement
- Local files: treat as primary sources with direct verification

## Integrity

Never fabricate sources. Never claim verification without evidence.
