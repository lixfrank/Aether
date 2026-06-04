---
name: literature-review
description: Conduct comprehensive, systematic literature reviews using multiple academic databases (arXiv, INSPIRE-HEP, Semantic Scholar, PubMed, etc.). This skill should be used when conducting systematic literature reviews, meta-analyses, research synthesis, or comprehensive literature searches across physics, scientific, and technical domains. Creates professionally formatted markdown documents and PDFs with verified citations in multiple citation styles (APA, Nature, Vancouver, etc.).
---

# Literature Review

## Overview

Conduct systematic, comprehensive literature reviews following rigorous academic methodology. Search multiple literature databases, synthesize findings thematically, verify all citations for accuracy, and generate professional output documents in markdown and PDF formats.

This skill supports both physics-focused and general scientific literature reviews. For physics domains, primary databases are arXiv and INSPIRE-HEP. For biomedical domains, PubMed and bioRxiv are primary. The skill adapts database selection based on the research domain.

## When to Use This Skill

Use this skill when:

- Conducting a systematic literature review for research or publication
- Synthesizing current knowledge on a specific topic across multiple sources
- Performing meta-analysis or scoping reviews
- Writing the literature review section of a research paper or thesis
- Investigating the state of the art in a research domain
- Identifying research gaps and future directions
- Requiring verified citations and professional formatting

---

## Core Workflow

Literature reviews follow a structured, multi-phase workflow:

### Phase 1: Planning and Scoping

1. **Define Research Question**: Use domain-appropriate framework:
   - For clinical/biomedical reviews: PICO framework (Population, Intervention, Comparison, Outcome)
   - For physics reviews: System-Model-Expectation-Deviation framework:
     - **System**: What physical system or phenomenon?
     - **Model**: What theoretical model or approach?
     - **Expectation**: What does the model predict?
     - **Deviation**: What discrepancies exist between prediction and observation?

2. **Establish Scope and Objectives**:
   - Define clear, specific research questions
   - Determine review type (narrative, systematic, scoping, meta-analysis)
   - Set boundaries (time period, geographic scope, study types)

3. **Develop Search Strategy**:
   - Identify 2-4 main concepts from research question
   - List synonyms, abbreviations, and related terms for each concept
   - Plan Boolean operators (AND, OR, NOT) to combine terms
   - Select minimum 3 complementary databases (see Database Selection below)

4. **Set Inclusion/Exclusion Criteria**:
   - Date range (e.g., last 10 years: 2015-2024)
   - Language (typically English, or specify multilingual)
   - Publication types (peer-reviewed, preprints, reviews)
   - Study designs (experimental, theoretical, computational, observational)
   - Document all criteria clearly

### Phase 2: Systematic Literature Search

1. **Multi-Database Search**: Select databases based on domain:

   **Physics & Mathematical Sciences:**
   - Use arxiv-search skill for arXiv preprint search (physics, math, CS, q-bio)
   - For deeper understanding of arXiv papers: use alphaxiv overview (`webfetch https://alphaxiv.org/overview/<arxiv_id>`)
   - Use INSPIRE-HEP via webfetch for high-energy physics literature (https://inspirehep.net)
   - Use Semantic Scholar API for cross-disciplinary searches and citation graphs

   **Biomedical & Life Sciences (optional):**
   - Use PubMed via direct API or webfetch
   - Use bioRxiv/medRxiv for preprints
   - Note: gget and bioservices are optional dependencies, not required

   **General Scientific Literature:**
   - Search Semantic Scholar via API (200M+ papers, cross-disciplinary)
   - Use Google Scholar for comprehensive coverage (manual or careful scraping)

2. **Document Search Parameters**:

   ```markdown
   ## Search Strategy

   ### Database: arXiv

   - **Date searched**: YYYY-MM-DD
   - **Date range**: 2015-01-01 to YYYY-MM-DD
   - **Search string**: `cat:hep-ph AND ti:"dark matter"`
   - **Results**: N articles
   ```

   Repeat for each database searched.

3. **Export and Aggregate Results**:
   - Export results in JSON format from each database
   - Combine all results into a single file
   - Use `scripts/search_databases.py` for post-processing:
     ```bash
     python scripts/search_databases.py combined_results.json \
       --deduplicate \
       --format markdown \
       --output aggregated_results.md
     ```

### Phase 3: Screening and Selection

1. **Deduplication**:

   ```bash
   python scripts/search_databases.py results.json --deduplicate --output unique_results.json
   ```

2. **Title Screening**: Review all titles against inclusion/exclusion criteria

3. **Abstract Screening**: Read abstracts of remaining studies; apply criteria rigorously

4. **Deep Understanding (alphaxiv)**: For papers requiring deeper analysis during screening:
   - Construct alphaxiv overview URL: `https://alphaxiv.org/overview/<arxiv_id>`
   - Use webfetch to retrieve structured overview (Key Findings, Methodology, Limitations, Broader Impact)
   - Use overview content for screening decisions instead of relying solely on abstracts
   - Fallback: if alphaxiv overview unavailable, use the arXiv abstract

5. **Full-Text Screening**: Obtain full texts of remaining studies; document specific exclusion reasons

6. **Create PRISMA Flow Diagram**:
   ```
   Initial search: n = X
   ├─ After deduplication: n = Y
   ├─ After title screening: n = Z
   ├─ After abstract screening: n = A
   └─ Included in review: n = B
   ```

### Phase 4: Data Extraction and Quality Assessment

1. **Extract Key Data** from each included study:
   - Study metadata (authors, year, journal/arXiv ID, DOI)
   - Study design and methods
   - Sample size / system parameters
   - Key findings and results
   - Limitations noted by authors
   - Funding sources and conflicts of interest

2. **Assess Study Quality**:
   - **For RCTs**: Use Cochrane Risk of Bias tool
   - **For observational studies**: Use Newcastle-Ottawa Scale
   - **For systematic reviews**: Use AMSTAR 2
   - **For physics papers**: Evaluate theoretical consistency, computational reproducibility, agreement with experimental data
   - Rate each study: High, Moderate, Low, or Very Low quality

3. **Organize by Themes**: Identify 3-5 major themes; group studies by theme

### Phase 5: Synthesis and Analysis

1. **Create Review Document** from template:

   ```bash
   cp assets/review_template.md my_literature_review.md
   ```

2. **Write Thematic Synthesis** (NOT study-by-study summaries):
   - Organize Results section by themes or research questions
   - Synthesize findings across multiple studies within each theme
   - Compare and contrast different approaches and results

3. **Critical Analysis**: Evaluate methodological strengths, limitations, evidence quality

4. **Write Discussion**: Interpret findings, discuss implications, acknowledge limitations

### Phase 6: Citation Verification

**CRITICAL**: All citations must be verified for accuracy before final submission.

1. **Verify All DOIs**:

   ```bash
   python scripts/verify_citations.py my_literature_review.md
   ```

2. **Review Verification Report**: Check for failed DOIs, correct errors, re-run until all pass

3. **Format Citations Consistently**: Choose one citation style (see `references/citation_styles.md`)

### Phase 7: Document Generation

1. **Generate PDF**:

   ```bash
   python scripts/generate_pdf.py my_literature_review.md \
     --citation-style apa \
     --output my_review.pdf
   ```

2. **Quality Checklist**:
   - [ ] All DOIs verified with verify_citations.py
   - [ ] Citations formatted consistently
   - [ ] PRISMA flow diagram included (for systematic reviews)
   - [ ] Search methodology fully documented
   - [ ] Inclusion/exclusion criteria clearly stated
   - [ ] Results organized thematically (not study-by-study)
   - [ ] Quality assessment completed
   - [ ] Limitations acknowledged
   - [ ] References complete and accurate

## Subagent Dispatch

- When multiple database searches are needed in parallel, dispatch `research-explorer` subagent to execute searches
- When verification of findings is required, delegate to `research-verifier` or `gpd-verifier` subagent
- Provide clear scope and search parameters to subagents

## Notepad Output Structure

Write review outputs to: `output_dir/notepads/<slug>/` where `<slug>` is a URL-safe version of the review topic.

Structure:

```
output_dir/notepads/<slug>/
  review.md          — Main review document
  search_results/    — Raw search results from each database
  screening_log.md   — Inclusion/exclusion decisions
  review.pdf         — Generated PDF (if applicable)
```

## MCP Integration

- **research-conventions**: Before starting, call `convention_lock_status` to check current conventions. Call `convention_check` on any document with ASSERT_CONVENTION headers before finalizing.
- **research-state**: After completing a review phase, call `advance_plan` to advance state. Read current state via `get_state` before beginning work.

## Database-Specific Search Guidance

### arXiv

Use arxiv-search skill for primary search:

```bash
.venv/bin/python [YOUR_SKILLS_DIR]/arxiv-search/arxiv_search.py "your search query" --max-papers N
```

**Search tips**:

- Use category prefixes: `cat:hep-ph` (high-energy physics), `cat:cond-mat` (condensed matter), `cat:gr-qc` (general relativity)
- Field tags: `ti:` (title), `au:` (author)
- Boolean: `ti:"dark matter" AND cat:hep-ph`

**Deep understanding via alphaxiv**:
After obtaining arXiv IDs, for papers requiring deeper analysis:

1. Construct alphaxiv overview URL: `https://alphaxiv.org/overview/<arxiv_id>`
2. Use webfetch to retrieve the overview page
3. The overview provides structured: Key Findings, Methodology, Limitations, Broader Impact
4. Use overview content for research synthesis instead of relying solely on abstracts
5. Fallback: if alphaxiv overview is unavailable, use the arXiv abstract from search results

### INSPIRE-HEP

Access via webfetch: `https://inspirehep.net/api/literature?q=<search_query>`

- High-energy physics literature database
- Citation tracking, author profiles, conference proceedings
- Use for finding highly cited papers and citation networks

### Semantic Scholar

Access via direct API (requires API key, or use free tier):

- 200M+ papers across all fields
- Excellent for cross-disciplinary searches
- Provides citation graphs and paper recommendations

### PubMed / PubMed Central (optional for biomedical)

Access via direct API or webfetch:

- 35M+ citations in biomedical literature
- Use MeSH terms, Boolean operators, field tags
- gget and bioservices are optional dependencies, not required for this skill

### bioRxiv / medRxiv (optional for biomedical)

- Preprints in biology and medicine
- Not peer-reviewed; verify findings with caution

### Citation Chaining

Expand search via citation networks:

1. **Forward citations** (papers citing key papers): Use Semantic Scholar or INSPIRE-HEP APIs
2. **Backward citations** (references from key papers): Extract references from included papers

## Citation Style Guide

Detailed formatting guidelines are in `references/citation_styles.md`. Quick reference:

### APA (7th Edition)

- In-text: (Smith et al., 2023)
- Reference: Smith, J. D., Johnson, M. L., & Williams, K. R. (2023). Title. _Journal_, _22_(4), 301-318. https://doi.org/10.xxx/yyy

### Nature

- In-text: Superscript numbers^1,2^
- Reference: Smith, J. D., Johnson, M. L. & Williams, K. R. Title. _Nat. Rev. Drug Discov._ **22**, 301-318 (2023).

**Always verify citations** with verify_citations.py before finalizing.

## Best Practices

### Search Strategy

1. **Use multiple databases** (minimum 3): Ensures comprehensive coverage
2. **Include preprint servers**: Captures latest unpublished findings
3. **Document everything**: Search strings, dates, result counts for reproducibility
4. **Test and refine**: Run pilot searches, review results, adjust search terms

### Synthesis

1. **Organize thematically**: Group by themes, NOT by individual studies
2. **Synthesize across studies**: Compare, contrast, identify patterns
3. **Be critical**: Evaluate quality and consistency of evidence
4. **Identify gaps**: Note what's missing or understudied

## Dependencies

### Required Python Packages

```bash
pip install requests  # For citation verification
pip install arxiv     # For arXiv search
```

### Required System Tools (optional, for PDF generation)

```bash
brew install pandoc  # macOS
apt-get install pandoc  # Linux
```

Check dependencies:

```bash
python scripts/generate_pdf.py --check-deps
```

## Resources

### Bundled Resources

**Scripts:**

- `scripts/verify_citations.py`: Verify DOIs and generate formatted citations
- `scripts/generate_pdf.py`: Convert markdown to professional PDF
- `scripts/search_databases.py`: Process, deduplicate, and format search results

**References:**

- `references/citation_styles.md`: Detailed citation formatting guide (APA, Nature, Vancouver, Chicago, IEEE)
- `references/database_strategies.md`: Comprehensive database search strategies

**Assets:**

- `assets/review_template.md`: Complete literature review template with all sections

## Tool Requirements

This skill requires the following tools to function properly. Ensure the invoking agent has these permissions:

- **read**: Read source files, search results, and verification reports
- **edit/write**: Write review documents, screening logs, and output files
- **bash**: Run bundled scripts (verify_citations.py, generate_pdf.py, search_databases.py)
- **webfetch**: Fetch alphaxiv overviews, INSPIRE-HEP data, and web search results

If the invoking agent lacks any of these permissions, the skill will degrade: bash-based citation verification and PDF generation will be unavailable; webfetch-based paper understanding will fall back to abstract-only.

## Integrity

Never fabricate sources. Never claim verification without evidence.
