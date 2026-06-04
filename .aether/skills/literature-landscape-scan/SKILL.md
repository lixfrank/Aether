---
name: literature-landscape-scan
description: |
  Phase 2 (phase_landscape) of the Path 3 research state machine.
  Scans literature landscape for a research topic. Produces a structured landscape_map.md
  with domain map, school classification, key paper timeline, controversy annotations,
  and open problem list. Can be skipped if ROADMAP.md already contains sufficient
  literature coverage. Integrates with alpha-research, alphaxiv, and research-question-framing.
---

# Literature Landscape Scan — phase_landscape

This skill implements **Phase 2** of the Path 3 research state machine. It expands the literature coverage beyond Phase 1's initial analysis.

## Lifecycle Contract

**Input**: ROADMAP.md from phase_analysis + research_analysis.md findings

**Output** (MUST write all of these):

1. `.aether/research/notepads/<slug>/landscape_map.md` — Structured landscape map
2. `.aether/research/persistence/ROADMAP.md` — Updated with landscape findings (schools, papers, controversies)
3. `.aether/research/persistence/STATE.md` — Updated with phase=phase_landscape completed

**State transition**: phase_landscape → phase_framing

**MUST NOT**: Write PLAN.md (that is phase_framing's responsibility). Overwrite ROADMAP.md — only append/update the landscape section.

**Skip condition**: This phase CAN be skipped ONLY if ROADMAP.md contains ALL of the following:

- A "Schools of Thought" section with ≥3 schools, each with representative papers (arXiv IDs or DOIs)
- A "Key Paper Timeline" section with chronological ordering
- A "Controversies" or "Open Problems" section identifying gaps
  OR: A prior landscape_map.md exists in notepads that covers the same domain (check domain overlap)
  OR: The user's prompt explicitly lists ≥5 specific papers/authors with full citations, covering multiple approaches
- If skipping: write skip justification to STATE.md, call advance_plan via research-state MCP with phase="phase_landscape_skipped", proceed to phase_framing

## Procedure

### Step 1: Read Current State

1. Read `.aether/research/persistence/STATE.md` — confirm phase is phase_analysis completed
2. Read `.aether/research/persistence/ROADMAP.md` — understand project scope and question
3. Read `.aether/research/notepads/<slug>/research_analysis.md` — review Phase 1 findings
4. Check skip condition: Does ROADMAP.md already contain sufficient landscape coverage?
5. Read state.json via research-state MCP (`get_state`)
6. Check `convention_lock_status` via research-conventions MCP if physics domain

### Step 2: Define Scope and Search Terms

1. Extract key concepts from ROADMAP.md research question
2. Identify 3-6 key search terms (primary concepts + synonyms from Phase 1 findings)
3. Define time range based on field activity level
4. Determine domain-specific databases:
   - Physics: arXiv, INSPIRE-HEP, alphaxiv
   - CS: arXiv cs.\*, Semantic Scholar, Google Scholar
   - Biomedical: PubMed, bioRxiv, Semantic Scholar
   - Cross-disciplinary: Semantic Scholar, OpenAlex

### Step 3: Multi-Database Parallel Search

Dispatch research-explorer subagent(s) for parallel searches:

1. **arXiv**: Use alpha-research skill (no-login mode) with category-appropriate queries
2. **alphaxiv Smart Search**: For AI-enhanced discovery beyond keywords
3. **Semantic Scholar**: Cross-disciplinary coverage and citation graphs
4. **INSPIRE-HEP** (physics): Citation tracking and highly-cited paper identification

Scale:

- 2-3 search angles → 1 research-explorer subagent
- 4-6 search angles → 2 research-explorer subagents (concurrent)

### Step 4: Deep Understanding of Key Papers

For papers identified as potentially important:

1. Extract arXiv IDs from search results
2. Use alphaxiv overview for structured understanding
3. Fallback to arXiv abstract if alphaxiv overview unavailable
4. Classify papers by: theoretical approach, methodology, domain subfield

### Step 4.5: Download Representative and Key Papers

For papers classified as representative or key in the landscape:

1. **Collect identifiers** from:
   - Representative papers of each school (arXiv IDs / DOIs)
   - Foundational and influential papers in the timeline
   - Papers central to identified controversies
2. **Prepare batch file**: Create `key_papers.json` with metadata:
   ```json
   [
     {"arxiv_id": "2401.12345", "doi": "...", "title": "...", "authors": "...", "year": 2024, "relevance": "representative"},
     ...
   ]
   ```
3. **Run download script**:
   ```bash
   uv run .aether/skills/literature-review/scripts/download_paper.py --batch key_papers.json --output .aether/research/literatures --relevance representative
   ```
4. **Record results**: Successfully downloaded papers go to `literatures/index.json`; unavailable papers go to `literatures/unavailable.md` (title, authors, journal, DOI, URL, reason)
5. **Do NOT block on failures**: If a paper has no OA version, note it in unavailable.md and proceed — landscape scan focuses on mapping, not full archiving

### Step 5: Map the Landscape

Classify papers into a structured landscape:

1. **Schools of Thought**: Group papers by theoretical framework or methodology
   - Name each school
   - List representative papers and authors
   - Note key assumptions and distinguishing features

2. **Key Paper Timeline**: Chronological ordering of foundational and influential papers
   - Mark foundational, influential, and recent breakthrough papers

3. **Controversy Annotations**: Identify active disagreements
   - What is debated, which schools hold which positions, what evidence supports each

4. **Open Problems (gap_list)**: List unsolved questions and gaps
   - Each problem: description, significance, difficulty level, related school(s)
   - This gap_list feeds directly into research-question-framing skill

### Step 6: Write Landscape Map

Write to `.aether/research/notepads/<slug>/landscape_map.md`:

```markdown
# Literature Landscape: [Topic]

## Domain Overview

[1-2 paragraph summary]

## Schools of Thought

### School 1: [Name]

- **Core idea**: [summary]
- **Key assumptions**: [list]
- **Representative papers**: [arXiv IDs/DOIs]
- **Proponents**: [key authors/groups]

### School 2: [Name]

[same structure]

## Key Paper Timeline

| Year | Paper | Impact | School |
| ---- | ----- | ------ | ------ |

## Controversies

### Controversy 1: [Topic]

- **Debate**: [what]
- **School A position**: [position + evidence]
- **School B position**: [position + evidence]

## Open Problems (gap_list)

1. **[Problem 1]**: [Description] — Significance: [H/M/L] — Difficulty: [H/M/E]
2. **[Problem 2]**: [Description] — ...
```

### Step 7: Update ROADMAP.md

Append landscape findings to ROADMAP.md:

- Add schools of thought section
- Add key papers to milestones
- Update phase 2 status to "completed"

### Step 8: Update State

1. Update `.aether/research/persistence/STATE.md`:
   - phase: phase_landscape completed
   - key decisions: [landscape decisions]
   - blockers: [any gaps in coverage]
   - next_action: enter phase_framing
2. Call `advance_plan` via research-state MCP
3. Output a PhaseResultDigest as your final message (see Step 9). The coordinator will route to the next phase based on the digest.

### Step 9: Output PhaseResultDigest

Output a YAML code block as your FINAL message with this schema:

```yaml
phase_result_digest:
  phase: phase_landscape
  sub_phase: null
  cycle: null
  status: completed
  schools:
    - name: "[School Name]"
      core_idea: "[1 sentence summary]"
      representative_papers: ["arXiv:XXXX.XXXXX"]
  gap_list:
    - id: gap_1
      description: "[1 sentence]"
      significance: [H | M | L]
      difficulty: [H | M | E]
    - id: gap_2
      description: "[1 sentence]"
      significance: [H | M | L]
      difficulty: [H | M | E]
  controversies:
    - topic: "[debate topic]"
      positions: ["School A: position X", "School B: position Y"]
  output_paths:
    landscape_map: notepads/[slug]/landscape_map.md
    literatures_index: research/literatures/index.json
  next_phase: phase_framing
```

MUST NOT output any other text after this YAML block.

## Subagent Dispatch

- Dispatch `research-explorer` subagent for parallel database searches
- FORBIDDEN: Dispatching explore or general subagents — use research-explorer only

## MCP Integration

- research-conventions: Call convention_lock_status before scanning physics domains
- research-state: Call get_state before starting; advance_plan after completing

## Integrity

Never fabricate sources. Every school, paper, and controversy must cite verifiable references.
