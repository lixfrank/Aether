---
name: health-check
owner: research
description: |
  Research agent health check — 4-layer progressive detection
  (infrastructure → persistence → skill_chain → runtime).
  Self-contained: runs scripts/run_health_check.py directly via bash.
  No MCP dependency. Invoked by research-worker or primary agent.
---

# Health Check — 4-Layer Progressive Detection

This skill runs a standalone health check script. No MCP dependency.

## Procedure

### Step 1: Run Health Check Script

```bash
uv run .aether/skills/health-check/scripts/run_health_check.py [project_dir] [layers...]
```

- `project_dir` (optional): defaults to current working directory
- `layers` (optional): subset of `infrastructure persistence skill_chain runtime`

Default runs all 4 layers. Detection order is enforced: infrastructure → persistence → skill_chain → runtime. If a previous layer fails, subsequent layers are blocked.

### Step 2: Read Result

The script outputs JSON with structure:

```json
{
  "healthy": true,
  "schema_version": 1,
  "layers": {
    "infrastructure": { "healthy": bool, "checks": {...}, "issues": [...] },
    "persistence": { "healthy": bool, "checks": {...}, "issues": [...] },
    "skill_chain": { "healthy": bool, "checks": {...}, "issues": [...] },
    "runtime": { "healthy": bool, "checks": {...}, "issues": [...] }
  },
  "summary": { "total_checks": N, "passed": N, "failed": N, "degradations": [...] }
}
```

### Step 3: Write Temp Files

Write two temp files under `.aether/research/`:

**`.aether/research/.health_global.json`** — infrastructure + network status from the JSON result.

**`.aether/research/.health_network.md`** — network reachability summary:

```markdown
# Network Status (updated: [current UTC ISO 8601])

## Reachable

- [endpoint]: OK

## Unreachable

- [endpoint]: FAIL

## Degraded

- [endpoint]: DEGRADED "rate limited"

## Recommendations

- [reachability-based recommendations]
```

### Step 4: Build Degradation Summary

From the health result, determine per-layer pass/degraded/failed:

- `healthy: true` + no issues → pass
- `healthy: false` with non-critical issues → degraded
- `healthy: false` with critical issues → failed

Collect `failed_items` with `{layer, key, failure_class, auto_installable, priority}`.

auto_installable mapping:

- uv_available, git_available, git_working_dir → `true`
- paper_search_scripts → `true`
- All other items → `false`

priority mapping:

- uv_available → `critical`
- git_available, git_working_dir, paper_search_scripts → `high`
- All other items → `medium`

### Step 5: Return

Return a one-line summary to the caller. The caller reads the temp files for details.

## Key Constraints

- Self-contained: runs `scripts/run_health_check.py` via bash, no MCP
- Only write temp files under `.aether/research/`
- Temp files migrated to `~/.aether/health/` by primary agent
- `persistence` layer checks `research_state.md` (not state.json/STATE.md — those are deleted)

## Layer Details

### infrastructure

- uv available + version
- uv python management
- git available + version
- git working directory
- network reachability (arXiv, Semantic Scholar, INSPIRE-HEP, PubMed, alphaxiv, Crossref)

### persistence

- persistence directory writable
- `research_state.md` existence + format (has `## Research Goal` + `## Phase History` sections)
- `ENVIRONMENT.md` existence
- `convention_defaults.json` readable (gpd-conventions)

### skill_chain

- Phase skills: analysis, literature-landscape-scan, research-question-framing, autoresearch, debate, research-audit
- Support skills: paper-search, health-check, literature-review, gpd-\* (4 skills)
- Agent definitions: research, research-worker, research-verifier, local-executor, research-explorer, research-audit, debate-critic, debate-rebuttal
- Checker scripts: research-audit/scripts/ (check_sources, check_verification, check_artifacts)
- gpd-verification scripts (9 SymPy checkers)
- paper-search scripts (6 scripts)

### runtime

- SymPy dry-run (9 gpd-verification scripts with trivial inputs)
- paper-search arxiv_search test query
