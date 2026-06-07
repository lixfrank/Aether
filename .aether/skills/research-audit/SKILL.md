---
name: research-audit
description: |
  Audit skill for Path 3 research state machine. Used in phase_audit_1 (light mode)
  and phase_audit_2 (full mode). Verifies citation support, factual accuracy,
  method applicability, and domain coverage of ROADMAP.md, research_analysis.md,
  and landscape_map.md. Produces structured audit reports in persistence/audits/.
---

# Research Audit — phase_audit_1 / phase_audit_2

This skill implements the audit phases of the Path 3 research state machine. It verifies the knowledge foundation produced by analysis and landscape phases before framing and debate consume it.

## Lifecycle Contract

**Input**: Audit target files + audit scope (light/full) + audit_round number

**Output** (MUST write all of these):

1. `.aether/research/persistence/audits/audit_[1|2]_round[N].md` — Structured audit report (YAML Summary + Findings)
2. PhaseResultDigest with has_citation_gaps, issues_found, findings_summary

**State transition**: audit digest → coordinator routes per §Coordinator Routing

**MUST NOT**: Repair files (that is research-audit-repair's responsibility). Modify ROADMAP.md, research_analysis.md, or landscape_map.md.

## Audit Modes

### Light Mode (phase_audit_1)

Scope: Citation verification only

Audit targets:

- `research_analysis.md`
- `ROADMAP.md`

Check items:

| Check item                 | Severity | Description                                                         |
| -------------------------- | -------- | ------------------------------------------------------------------- |
| Claim without citation     | MISSING  | Claim lacks any citation support                                    |
| Citation does not support  | CONCERN  | Citation exists but content does not match                          |
| Factual misstatement       | FATAL    | Method applicability, formula, conclusion incorrectly described     |
| Missing foundational lit   | MISSING  | Well-known foundational literature not cited                        |
| Unreliable citation source | CONCERN  | Citation from non-peer-reviewed source without reliable alternative |

### Full Mode (phase_audit_2)

Scope: Citation verification + domain coverage + method applicability

Audit targets:

- `landscape_map.md` (new)
- `ROADMAP.md` (landscape-updated version)
- `research_analysis.md` (potentially supplemented by landscape)

Additional check items beyond light mode:

| Check item                         | Severity      | Description                                                   |
| ---------------------------------- | ------------- | ------------------------------------------------------------- |
| Incomplete domain coverage         | MISSING       | landscape_map.md missing important school or branch           |
| Inaccurate classification          | CONCERN       | Paper assigned to wrong school, or school definition vague    |
| Timeline gaps                      | MISSING       | Key papers missing from timeline                              |
| Unsupported controversy annotation | CONCERN       | Marked controversy lacks literature support                   |
| audit_1 gaps resolved by landscape | CONCERN/FATAL | Whether landscape supplementation actually fills audit_1 gaps |

## Procedure

### Step 1: Read Current State

1. Read `.aether/research/persistence/STATE.md` — confirm phase is phase_audit_1 or phase_audit_2
2. Read `state.json` via research-state MCP (`get_state`) — confirm audit.audit_round
3. Determine audit mode from phase:
   - phase_audit_1 → light mode
   - phase_audit_2 → full mode
4. Read all audit target files

### Step 2: Extract and Catalog Claims

For each audit target file:

1. Parse document structure — identify sections, claims, citations
2. For each factual claim or methodological statement:
   - Extract the claim text
   - Identify associated citations (if any)
   - Record section and claim location
3. Build a claim catalog: `{section, claim_text, citations, has_citation}`

### Step 3: Verify Citations (light and full mode)

For each claim in the catalog:

1. **No citation** → mark as MISSING
   - Provide `suggested_search`: keywords, domain, time period
2. **Has citation** → verify citation content:
   - First check `.aether/research/literatures/` for local copy → read directly
   - Local copy unavailable → web search + alphaxiv overview
   - Record `verification_source: local | web_search | alphaxiv`
3. **Citation does not match claim** → mark as CONCERN
   - Record `current_ref`, `suggested_ref`
4. **Factual misstatement detected** → mark as FATAL
   - Cross-verify with at least 2 independent sources (web search + original comparison)
   - For physics domain FATAL (formula/derivation errors): optionally call SymPy spot-check via gpd-verification skill
   - Provide `evidence` (why this is wrong) + `suggested_fix`
5. **Unreliable source** → mark as CONCERN
   - Record `current_ref`, `suggested_ref`

### Step 4: Verify Domain Coverage (full mode only)

For landscape_map.md:

1. **School completeness**: Check if all significant schools/approaches are represented
   - Cross-reference with known domain taxonomy
   - Missing important school → MISSING
2. **Classification accuracy**: Verify papers are correctly assigned to schools
   - Paper in wrong school → CONCERN
3. **Timeline completeness**: Verify key papers appear in chronological timeline
   - Missing key paper → MISSING
4. **Controversy support**: Verify annotated controversies have literature evidence
   - Unsupported controversy → CONCERN
5. **audit_1 gap resolution**: For each audit_1 MISSING/CONCERN finding:
   - Check if landscape supplementation addressed it
   - Unresolved → CONCERN or FATAL (depending on severity)

### Step 5: Write Audit Report

Write to `.aether/research/persistence/audits/audit_[1|2]_round[N].md`:

````markdown
# Audit [1|2] Report — Round [N]

## Summary

```yaml
total_claims_checked: [N]
citation_gaps: [N] # MISSING class citation absence count
issues_found: [N] # total issue count
has_citation_gaps: [true/false] # determines landscape skip eligibility
audit_1_gaps_resolved: "[N/M]" # audit_2 only: N gaps resolved out of M audit_1 gaps
```
````

## Findings

### [FATAL] Section X, Claim Y

- claim: "original claim text"
- issue: factual misstatement / method misdescription
- evidence: why this is wrong (at least 2 independent sources cross-verify)
- suggested_fix: recommended correction direction
- verification_source: local | web_search | alphaxiv

### [MISSING] Section X, Claim Z

- claim: "original claim text"
- issue: no citation support / missing foundational literature
- suggested_search: recommended search direction (keywords, domain, time period)

### [CONCERN] Section X, Claim W

- claim: "original claim text"
- issue: citation does not support / unreliable source
- current_ref: current citation
- suggested_ref: suggested replacement or supplementary citation
- verification_source: local | web_search | alphaxiv

````

### Step 6: Output PhaseResultDigest

**audit_1 digest schema**:

```yaml
phase_result_digest:
  phase: phase_audit_1
  sub_phase: audit
  cycle: null
  audit_round: [N]
  status: completed
  total_claims_checked: [N]
  citation_gaps: [N]
  issues_found: [N]
  has_citation_gaps: [true/false]
  findings_summary:
    fatal: [N]
    missing: [N]
    concern: [N]
  output_paths:
    audit_report: persistence/audits/audit_1_round[N].md
  next_phase: phase_landscape | phase_audit_1 | phase_framing
````

**audit_2 digest schema**:

```yaml
phase_result_digest:
  phase: phase_audit_2
  sub_phase: audit
  cycle: null
  audit_round: [N]
  status: completed
  total_claims_checked: [N]
  citation_gaps: [N]
  issues_found: [N]
  has_citation_gaps: [true/false]
  audit_1_gaps_resolved: "[N/M]"
  findings_summary:
    fatal: [N]
    missing: [N]
    concern: [N]
  output_paths:
    audit_report: persistence/audits/audit_2_round[N].md
  next_phase: phase_audit_2 | phase_framing
```

MUST NOT output any other text after this YAML block. The coordinator routes based on digest fields (has_citation_gaps, issues_found).

## Cross-Verification Strategy

For each FATAL/CONCERN finding, at least 2 independent sources must be used:

- Web search (general academic search engines)
- Original paper comparison (via literatures/ local copy or alphaxiv overview)
- For physics domain FATAL (formula/derivation errors): optional SymPy spot-check via gpd-verification computational scripts

This reduces single-LLM-judgment randomness. Reference gpd-errors skill's error pattern recognition strategies for methodology misdescription detection.

## MCP Integration

- research-state: Call get_state before starting; update_audit_state after completing (increment audit_round)
- research-conventions: Call convention_lock_status before auditing physics domain claims

## Integrity

Never fabricate verification sources. Record actual verification_source used. Do not mark a claim as verified without at least one independent source confirming it.
