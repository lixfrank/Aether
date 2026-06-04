---
name: gpd-errors
description: LLM physics error catalog with detection strategies. Use to identify common LLM physics reasoning errors during verification.
---

# LLM Physics Error Detection

## When to Use
During verification, after producing research results. Check for known LLM-specific physics error patterns.

## Error Detection Procedure

### Step 1: Identify Domain
Determine which physics domain the current work belongs to (qft, condensed_matter, stat_mech, numerical, gr, nuclear_particle, quantum_info, optics, astro, fluid, materials, genomics).

### Step 2: Load Error Catalog
Read `references/error_catalog.json` for the 20 highest-risk error classes. Filter by domain.

### Step 3: Check Each Error Class
For each relevant error class, apply the detection strategy:

| Error Class | Detection Strategy |
|-------------|-------------------|
| E01: CG coefficient sign error | Verify triangle inequality, m-values sum. Spot-check one CG against Varshalovich tables. |
| E02: Metric signature flip | Trace metric through every equation. Check sign of contraction g_μν g^μν = d. |
| E03: Ward identity violation | Replace ε^μ → k^μ. Check S-matrix cancellation. (Use ward_identity_check.py script) |
| E04: Wrong eigenvalue count | Count must match Hilbert space dimension. |
| E05: Gauge parameter in observable | ξ must cancel from physical observables. |
| ... | (See references/error_catalog.json for full 20 classes) |

### Step 4: Record Findings
For each checked error class, record: {class_id, detected: bool, evidence: str, severity: high|medium|low}.

### Step 5: Flag for Expert Review
For errors that require domain expertise to evaluate, flag as "expert_needed" with specific domain and reason.

## Do Not
- Do not skip high-severity error checks
- Do not claim "no errors found" without checking at least domain-relevant classes
- Do not fabricate detection results — must be based on actual verification