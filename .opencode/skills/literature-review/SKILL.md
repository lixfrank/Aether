---
name: literature-review
description: Conduct systematic literature reviews with verified citations, PICO scoping, and PRISMA-style screening. Use when conducting systematic reviews, meta-analyses, scoping reviews, or comprehensive literature searches.
category: Research
---

# Literature Review

Conduct a systematic literature review for: $@

Derive a short slug from the review topic (lowercase, hyphens, ≤5 words).

## In Research Mode

If you are in research mode (the research agent), follow the Deep Tier workflow:

1. Classify intent as literature-review in Phase 0 (Intent Gate).
2. Plan — define research question using PICO framework, set inclusion/exclusion criteria, choose databases.
   Write plan to outputs/.plans/<slug>.md. This intent REQUIRES user confirmation before proceeding.
3. Gather — dispatch researcher subagents for multi-database search.
4. Draft — write the review organized thematically (NOT study-by-study).
5. Cite — dispatch verifier subagent for citation anchoring and URL verification.
6. Review — dispatch reviewer subagent for quality check.
7. Deliver — final review + provenance sidecar to outputs/<slug>.md.

## In Other Modes

If you are not in research mode, do an inline literature review:

1. Define scope — PICO question, inclusion/exclusion criteria.
2. Search — use websearch, alpha-research (if available), and arxiv-search for academic sources.
3. Screen — filter results by inclusion/exclusion criteria. Track counts (similar to PRISMA).
4. Synthesize — organize findings thematically, not study-by-study.
5. Cite — verify key URLs with webfetch. Add inline citations [1], [2].
6. Present — inline response with numbered Sources section.

## Review Structure

- Abstract / Summary
- Introduction (research question, PICO, scope)
- Methods (search strategy, databases, screening criteria, PRISMA counts)
- Results (thematic synthesis, evidence tables)
- Discussion (agreements, disagreements, gaps, future directions)
- References (numbered, with URLs)

## Source Quality

- Prefer: peer-reviewed papers, official reports, primary datasets
- Accept with caveats: well-cited secondary sources, established trade publications
- Reject: no author/date, AI-generated without primary backing

For detailed methodology (PICO framework, PRISMA screening, quality assessment tools), see references/methodology.md.

End with a Sources section containing direct URLs for every source used.
