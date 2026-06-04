---
name: health-check
description: |
  Research agent health check execution — 4-layer progressive detection
  (infrastructure → persistence → skill_chain → runtime) + cross-MCP arbitration.
  Invoked by research-worker via skill tool when coordinator dispatches
  health_check mode. Writes temp files to .aether/research/ for coordinator
  migration to ~/.aether/health/.
---

# Health Check — 4-Layer Progressive Detection

This skill implements the health_check execution mode for the research agent. It is invoked by the research-worker via the skill tool, receiving `layers` parameter from the dispatch prompt.

## Lifecycle Contract

**Input**: dispatch prompt with `layers` parameter (default: `["infrastructure","persistence","skill_chain"]`), `project_dir` from MCP calls

**Output** (MUST write all of these):

1. `.aether/research/.health_global.json` — Global health data (infrastructure + network)
2. `.aether/research/.health_network.md` — Network status markdown (Reachable/Unreachable/Recommendations)

**State transition**: None. health_check does NOT call advance_plan or modify STATE.md.

**MUST NOT**:

- Call advance_plan (does not advance state machine)
- Modify STATE.md (coordinator writes STATE.md based on digest)
- Write files outside `.aether/research/` (file_scope constraint, D17)
- Write to `~/.aether/health/` directly (coordinator migrates temp files)

## Procedure

### Step 1: Read Dispatch Parameters

1. Read dispatch prompt to identify `layers` parameter
   - Default: `["infrastructure","persistence","skill_chain"]`
   - Full check (user-requested): `["infrastructure","persistence","skill_chain","runtime"]` or `None`
2. Determine project directory: use current working directory as `project_dir`

### Step 2: Call run_health_check MCP

Call research-state MCP `run_health_check(project_dir, layers=specified layers)` → get result dict.

The MCP tool returns a 4-layer progressive detection result with the structure:

```json
{
  "healthy": true,
  "schema_version": 1,
  "layers": {
    "infrastructure": { "healthy": bool, "checks": {...}, "issues": [...] },
    "persistence": { "healthy": bool, "checks": {...}, "issues": [...] },
    "skill_chain": { "healthy": bool, "checks": {...}, "issues": [...] },
    "runtime": { "healthy": bool, "checks": {...}, "issues": [...], "cross_mcp_pending": [...] }
  },
  "summary": { "total_checks": N, "passed": N, "failed": N, "degradations": [...], "cross_mcp_pending_count": N }
}
```

Detection order is enforced by the MCP tool: infrastructure → persistence → skill_chain → runtime. If a previous layer fails, subsequent layers are blocked.

### Step 3: Cross-MCP Arbitration

If runtime layer was executed and result contains `cross_mcp_pending` list:

1. Call research-conventions MCP `convention_lock_status(project_dir)` → get result
2. Call research-conventions MCP `skill_resolve_path(skill_name="gpd-conventions", project_dir)` → get result
3. Merge cross_mcp results into health status dict:
   - `convention_lock_status` return with `conventions` and `completeness_percent` → cross_mcp: pass
   - `skill_resolve_path` return with `found: true` + `skill_dir` → cross_mcp: pass
   - Any failure → cross_mcp: fail

### Step 4: Write Temp Files

Write two temp files under `.aether/research/` (within file_scope, D17):

**`.aether/research/.health_global.json`**:

```json
{
  "schema_version": 1,
  "updated_at": "[current UTC ISO 8601]",
  "infrastructure": {
    "uv_available": { "status": "...", "version": "..." },
    "uv_python_management": { "status": "...", "versions": [...] },
    "git_available": { "status": "...", "version": "..." },
    "git_working_dir": { "status": "...", "git_dir": "..." },
    "docker_cli": { "status": "...", "client_version": "..." },
    "docker_daemon": { "status": "...", "server_version": "..." },
    "alpha_cli": { "status": "...", "authenticated": bool },
    "network_arxiv": { "status": "...", "method": "...", "http_code": N },
    "network_semantic_scholar": { "status": "...", "method": "...", "http_code": N },
    "network_inspire_hep": { "status": "...", "method": "...", "http_code": N }
  },
  "network": {
    "arxiv": { ... },
    "semantic_scholar": { ... },
    "inspire_hep": { ... }
  }
}
```

**`.aether/research/.health_network.md`**:

```markdown
# Network Status (updated: [current UTC ISO 8601])

## Reachable

- [endpoint]: OK "[method], [http_code]"

## Unreachable

- [endpoint]: FAIL → [impact description]

## Degraded

- [endpoint]: DEGRADED "rate limited, [http_code]"

## Recommendations

- [reachability-based recommendations]
```

### Step 5: Build Degradation Summary

From the health status result, build a degradation_summary:

1. For each layer, determine pass/degraded/failed:
   - `healthy: true` + no issues → pass
   - `healthy: false` with non-critical issues → degraded
   - `healthy: false` with critical issues (persistence fail) → failed

2. Collect failed_items from all layers:
   - Each item: `{layer, key, failure_class, auto_installable, priority}`
   - `failure_class` comes from the check result's `failure_class` field

3. auto_installable mapping (from install_registry.json):
   - uv_available, git_available, git_working_dir, docker_cli, docker_daemon → `true`
   - alpha_cli → `"partial"`
   - All other items → `false`

4. priority mapping:
   - uv_available → `critical`
   - git_available, git_working_dir → `high`
   - docker_cli, docker_daemon → `medium`
   - alpha_cli → `low`
   - All other items → `medium`

### Step 6: Output PhaseResultDigest

Output health_check digest as FINAL message:

```yaml
phase_result_digest:
  phase: health_check
  sub_phase: null
  cycle: null
  status: pass | degraded | failed
  degradation_summary:
    infrastructure: pass | degraded | failed
    persistence: pass | degraded | failed
    skill_chain: pass | degraded | failed
    runtime: pass | degraded | failed
    cross_mcp: pass | degraded | failed
    failed_items:
      - layer: [infrastructure | persistence | skill_chain | runtime]
        key: [health_check_key, e.g. "uv_available"]
        failure_class:
          [not_installed | not_configured | daemon_not_running | not_authenticated | unreachable | missing | corrupt]
        auto_installable: true | "partial" | false
        priority: critical | high | medium | low
  output_paths:
    temp_global_health_json: ".aether/research/.health_global.json"
    temp_network_status_md: ".aether/research/.health_network.md"
    final_global_health_json: "~/.aether/health/global_health.json"
    final_network_status_md: "~/.aether/health/network_status.md"
  next_phase: null
```

MUST NOT output any other text after this YAML block.

## Key Constraints

- **MUST NOT call advance_plan** — health_check does not advance the state machine
- **MUST NOT modify STATE.md** — coordinator writes STATE.md based on digest
- **ONLY write temp files under `.aether/research/`** — `.health_global.json` + `.health_network.md`, never outside file_scope (D17)
- Temp files are migrated by coordinator to `~/.aether/health/` and deleted; worker never writes to global directory
- `next_phase` field is always `null`
- Detection order is enforced by the MCP tool: infrastructure → persistence → skill_chain → runtime
- If a previous layer is unhealthy, subsequent layers are blocked and skipped automatically by the MCP tool
