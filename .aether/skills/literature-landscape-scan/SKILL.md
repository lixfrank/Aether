---
name: literature-landscape-scan
description: Scan literature landscape for a research topic. Produces a structured landscape_map.md with domain map, school classification, key paper timeline, controversy annotations, and open problem list. Integrates with arxiv-search, alphaxiv, and research-question-framing.
---

# Literature Landscape Scan

Produce a comprehensive, structured map of the literature landscape for a research topic, identifying schools of thought, key papers, controversies, and open problems.

## When to Use

Use this skill when:

- Starting a new research project and need to understand the field landscape
- Identifying open problems and research gaps before framing questions
- Mapping competing theories and approaches before deep investigation
- Providing input for research-question-framing (gap_list feeds into question framing)

## Procedure

### Step 1: Define Scope and Search Terms

1. Clarify the research topic and domain
2. Identify 3-6 key search terms (primary concepts + synonyms)
3. Define time range (e.g., last 10 years for active fields, longer for foundational fields)
4. Determine domain-specific databases:
   - **Physics**: arXiv (primary), INSPIRE-HEP (citation networks), alphaxiv (deep understanding)
   - **Computer Science**: arXiv cs.\*, Semantic Scholar, Google Scholar
   - **Biomedical**: PubMed, bioRxiv, Semantic Scholar
   - **Cross-disciplinary**: Semantic Scholar, OpenAlex

### Step 2: Multi-Database Parallel Search

Execute parallel searches across selected databases:

1. **arXiv**: Use arxiv-search skill with category-appropriate queries

   ```bash
   .venv/bin/python [YOUR_SKILLS_DIR]/arxiv-search/arxiv_search.py "cat:hep-ph AND ti:search_term" --max-papers 50
   ```

2. **alphaxiv Smart Search**: For AI-enhanced discovery beyond keywords:
   - Use webfetch on `https://alphaxiv.org/search?q=<search_query>` for semantic search results
   - Identifies papers beyond exact keyword matches

3. **Semantic Scholar**: Cross-disciplinary coverage and citation graphs
4. **INSPIRE-HEP** (physics): Citation tracking and highly-cited paper identification

### Step 3: Deep Understanding of Key Papers

For papers identified as potentially important:

1. Extract arXiv IDs from search results
2. For each key paper, use alphaxiv overview for structured understanding:
   - `webfetch https://alphaxiv.org/overview/<arxiv_id>`
   - Overview provides: Key Findings, Methodology, Limitations, Broader Impact
3. Fallback to arXiv abstract if alphaxiv overview unavailable
4. Classify papers by: theoretical approach, methodology, domain subfield

### Step 4: Map the Landscape

Classify papers into a structured landscape:

1. **Schools of Thought**: Group papers by theoretical framework or methodology
   - Name each school (e.g., "String Theory approach", "Lattice QCD approach")
   - List representative papers and authors for each school
   - Note key assumptions and distinguishing features

2. **Key Paper Timeline**: Chronological ordering of foundational and influential papers
   - Mark foundational papers (started the field/subfield)
   - Mark influential papers (shifted direction, resolved key questions)
   - Mark recent breakthroughs

3. **Controversy Annotations**: Identify active disagreements
   - What is being debated?
   - Which schools hold which positions?
   - What evidence supports each position?
   - What would resolve the controversy?

4. **Open Problems**: List unsolved questions and gaps
   - Each problem should have: description, significance, difficulty level, related school(s)
   - This gap_list feeds directly into research-question-framing skill

### Step 5: Write Landscape Map

Write output to `output_dir/notepads/<slug>/landscape_map.md` using this structure:

```markdown
# Literature Landscape: [Topic]

## Domain Overview

[1-2 paragraph summary of the field, its scope, and current state]

## Schools of Thought

### School 1: [Name]

- **Core idea**: [1-2 sentence summary]
- **Key assumptions**: [List]
- **Representative papers**: [arXiv IDs or DOIs with brief description]
- **Proponents**: [Key authors/groups]

### School 2: [Name]

[Same structure]

## Key Paper Timeline

| Year | Paper          | Impact                                    | School        |
| ---- | -------------- | ----------------------------------------- | ------------- |
| YYYY | [arXiv ID/DOI] | Foundational / Influential / Breakthrough | [School name] |

## Controversies

### Controversy 1: [Topic]

- **Debate**: [What is being argued]
- **School A position**: [Position + supporting evidence]
- **School B position**: [Position + supporting evidence]
- **Resolution path**: [What would settle this]

### Controversy 2: [Topic]

[Same structure]

## Open Problems (gap_list)

1. **[Problem 1]**: [Description] — Significance: [High/Medium/Low] — Difficulty: [Hard/Medium/Easy] — Related: [School(s)]
2. **[Problem 2]**: [Description] — ...
```

### Step 6: Quality Check

Evaluate landscape scan quality:

1. **Coverage**: Did we search enough databases? Are all major schools represented?
2. **Balance**: Is each school represented with similar depth? No school over/under-represented?
3. **Time span**: Does the timeline cover foundational to recent work?
4. **Controversy completeness**: Are known debates captured?

## Integration with Other Skills

- **research-question-framing**: The gap_list output feeds directly into question framing, converting open problems into structured research questions
- **deep-research**: For deeper investigation of specific papers or subtopics identified in the landscape
- **literature-review**: For systematic review of specific themes identified in the landscape
- **arxiv-search + alphaxiv**: For paper discovery and deep understanding

## MCP Integration

- **research-conventions**: Call `convention_lock_status` before scanning physics domains to check metric_signature, natural_units, etc.
- **research-state**: Call `get_state` to check current project phase; `advance_plan` after completing landscape scan

## Integrity

Never fabricate sources. Every school, paper, and controversy must cite verifiable references.
