---
name: gpd-conventions
description: Physics convention lock management. Check, set, validate, and compare conventions across research phases. Use before any calculation to ensure consistency.
---

# Convention Management

## When to Use
Before any physics/math calculation, and during verification to check convention consistency.

## Convention Procedure

### Step 1: Check Current Lock
Call `convention_lock_status` MCP tool to read current convention state from state.json.

### Step 2: Set Conventions (New Project)
If no lock exists, call `subfield_defaults(domain)` MCP tool to get recommended defaults for your domain, then call `convention_set(key, value)` MCP tool for each convention to create the lock.

### Step 3: Validate Conventions
Before each derivation/computation:
- Add `<!-- ASSERT_CONVENTION: natural_units=natural, metric_signature=mostly-minus -->` header to your file
- Call `assert_convention_validate(file_path)` MCP tool to verify headers match lock

### Step 4: Cross-Phase Consistency
When referencing prior phase results, verify convention lock matches. If conventions differ, convert results to current lock conventions before use.

## Subfield Defaults (Quick Reference)
- QFT: natural units, mostly-minus metric, physics Fourier, on-shell renormalization
- Condensed matter: natural units, mostly-plus metric, physics Fourier, Coulomb gauge
- Stat mech: Boltzmann units, mostly-minus metric, standard Matsubara
- Numerical: SI units, Cartesian coordinates, convergence threshold 1e-6
- GR: geometric units, mostly-plus metric, general coordinates

## Do Not
- Do not start a derivation without checking convention_lock_status first
- Do not mix conventions across phases without explicit conversion
- Do not change conventions mid-project without convention_set and re-verification