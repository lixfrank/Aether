---
name: source-comparison
description: Compare multiple sources on a topic and produce a grounded comparison matrix. Use when comparing papers, tools, approaches, or claims across sources.
---

# Source Comparison

Compare sources for: $@

Derive a short slug from the comparison topic (lowercase, hyphens, no filler words, ≤5 words). Use this slug for all output files.

## In Research Mode

If you are in research mode (the research agent), follow the full research workflow:

1. Classify intent as methodology-comparison in Phase 0 (Intent Gate).
2. Plan comparison dimensions and sources. Write plan to outputs/.plans/<slug>.md.
3. Dispatch researcher subagents to gather evidence for each source.
4. Build the comparison matrix covering: source, key claim, evidence type, caveats, confidence.
5. Dispatch verifier subagent for citation anchoring.
6. Deliver to outputs/<slug>-comparison.md with provenance sidecar.

## In Other Modes

If you are not in research mode (e.g., build or plan mode), do an inline comparison:

1. Use websearch/webfetch to gather source material directly.
2. If paper-search skill is available, use it for academic sources.
3. Build a comparison matrix: source, key claim, evidence type, caveats, confidence.
4. Distinguish agreement, disagreement, and uncertainty clearly.
5. Present the comparison inline. Optionally write to a file if the comparison is large.

## Comparison Matrix Format

| Source          | Key Claim | Evidence Type                   | Caveats | Confidence      |
| --------------- | --------- | ------------------------------- | ------- | --------------- |
| [1] Paper A     | ...       | primary/secondary/self-reported | ...     | high/medium/low |
| [2] Tool B docs | ...       | ...                             | ...     | ...             |

For quantitative metrics, generate charts if possible.
For method/architecture comparisons, use Mermaid diagrams.

End with a Sources section containing direct URLs for every source used.
