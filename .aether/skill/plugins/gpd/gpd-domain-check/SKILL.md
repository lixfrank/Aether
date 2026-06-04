---
name: gpd-domain-check
description: Domain-specific physics verification checklists. Use during verification to apply specialized checks for quantum field theory, condensed matter, statistical mechanics, and 9 other domains.
---

# Domain-Specific Verification

## When to Use
During verification, after identifying the physics domain of the current work.

## Domain Checklist Procedure

### Step 1: Identify Domain
Determine domain from phase goal and research content. Domains: qft, condensed_matter, stat_mech, numerical, gr, nuclear_particle, quantum_info, optics, astro, fluid, materials, genomics.

### Step 2: Load Domain Checklist
Read `references/bundles/<domain>.json` for domain-specific priority checks, red flags, and standard benchmarks.

### Step 3: Execute Domain Checks
For each priority check in the domain checklist:
- If a script exists (dimensional_check.py, limiting_case_check.py, etc.), invoke it via shell
- If no script exists (literature agreement, physical plausibility), apply LLM judgment with explicit caveats

### Step 4: Check Domain Red Flags
Scan artifacts for domain-specific red flags listed in the bundle.

### Step 5: Verify Standard Benchmarks
For each standard benchmark in the bundle, verify the result matches known values.

### Step 6: Record Coverage
Report which checks were script-verified vs LLM-judged vs deferred.

## Do Not
- Do not skip domain red flags
- Do not claim domain coverage without checking at least priority_checks
- Do not use keyword scanning instead of script computation where scripts exist