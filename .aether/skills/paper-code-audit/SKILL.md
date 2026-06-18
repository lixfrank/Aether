---
name: paper-code-audit
owner: research
description: Compare a paper's claims against its public codebase and identify mismatches, omissions, and reproducibility risks. Use for auditing papers, checking code-claim consistency, and verifying reproducibility.
---

# Paper-Code Audit

Audit the paper and codebase for: $@

Derive a short slug from the audit target (lowercase, hyphens, no filler words, ≤5 words).

## In Research Mode

If you are in research mode (the research agent), follow the full research workflow:

1. Classify intent in Phase 0 (Intent Gate).
2. Plan audit: identify paper claims and corresponding code. Write plan to outputs/.plans/<slug>.md.
3. Dispatch researcher subagents to:
   - Read the paper (use webfetch alphaxiv overview for structured understanding)
   - Inspect the code repo (use webfetch to read GitHub repo files)
4. Compare claimed methods, defaults, metrics, and data handling against actual code.
5. Call out: missing code, mismatches, ambiguous defaults, reproduction risks.
6. Dispatch verifier subagent for citation anchoring.
7. Deliver to outputs/<slug>-audit.md with provenance sidecar.

## In Other Modes

If you are not in research mode:

1. Use webfetch to read the paper (arxiv HTML or PDF).
2. Use webfetch to read the repo files directly.
3. Compare claims vs code inline.
4. Present findings inline or write to a file.

## Audit Dimensions

- **Method match**: Does the code implement what the paper describes?
- **Default divergence**: Do code defaults differ from paper-reported settings?
- **Metric consistency**: Are evaluation metrics computed the same way?
- **Data handling**: Is dataset processing consistent between paper description and code?
- **Missing code**: Are any claimed features or experiments not present in the repo?
- **Reproduction risk**: Can the results be reproduced from the code alone?

End with a Sources section containing paper URL and repository URL.
