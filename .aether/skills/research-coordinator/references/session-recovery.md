# Session Recovery Reference

This file contains crash/interrupt recovery procedures and health check processing. Coordinator reads this file only when encountering specific recovery scenarios — not needed during normal workflow.

---

## §Phase-Specific Crash Recovery

### phase_analysis_checkpoint recovery

If session interrupted during analysis_checkpoint:

- Read analysis digest from DIGESTS.md → re-present summary to user
- Use question tool (same as first entry)
- User confirms → advance_plan(phase=phase_audit_1)
- User requests revision → rollback to phase_analysis commit (see §Checkpoint Rollback in references/phase-routing.md)

### phase_audit_1/2/3 recovery

If session interrupted during an audit phase:

1. Read state.json.audit.current_audit_phase + state.json.audit.repair_count + state.json.audit.audit_round
2. If current_audit_phase is null → dispatch audit worker directly
3. If current_audit_phase is non-null:
   - Check DIGESTS.md last entry's sub_phase:
     - sub_phase = audit → audit worker has returned digest → route per Coordinator Routing rules (references/phase-routing.md)
     - sub_phase = repair → repair worker may have modified files but crashed → enter Repair Crash Recovery (below)
     - No digest → worker may have crashed → check audit report file:
       - File exists and non-empty → construct fallback digest (status: completed_fallback), route per rules
       - File does not exist → re-dispatch audit worker

### phase_audit_3 special recovery

If session interrupted during audit_3 with has_structural_incompleteness or LOW confidence:

- Check framing_reasoning.md exists and non-empty → if exists, continue audit_3
- If framing_reasoning.md missing → re-dispatch framing worker (structural incompleteness recovery)
- If landscape supplement in progress: check landscape_map.md for audit_3_gap_fill entries → if present, construct fallback digest and continue audit_2 → framing → audit_3; if not present, re-dispatch landscape supplement worker

### phase_debate recovery

If session interrupted during phase_debate:

1. Check state.json.debate.current_sub_phase + DEBATE.md for round status
2. If state.json.debate.current_sub_phase is non-null → resume from that sub_phase (interrupted mid-round)
3. If current_sub_phase was "repair" → check for PLAN.md.pre_repair_round{N} backup:
   - Backup exists → restore PLAN.md from backup, then re-dispatch repair
   - Backup does not exist → check DEBATE.md for repair report section; if found with full content, infer completion and construct fallback digest; if not found, re-dispatch repair
4. If state.json.debate.current_sub_phase is null → check DEBATE.md last round's Round Verdict:
   - ALL RESOLVED → proceed to phase_checkpoint
   - FURTHER ROUNDS NEEDED → continue from round state.json.debate.rounds_completed + 1, read ESCALATE topics from DEBATE.md adjudicator ruling + last repair digest's `re_verification_topics` for focus list
5. Fallback (state.json.debate missing): read DEBATE.md last section type to determine interruption point

### phase_execution recovery

If session interrupted during phase_execution:

1. Check state.json.execution + persistence 汇缩 files
2. Check persistence/EXECUTION.md + persistence/VERIFICATION.md whether they already exist
   - Already exist → autoresearch completed 汇缩写入 → call advance_plan(phase=completed) → present results
   - Not exist → check state.json.execution.question_status:
     - All resolved/failed/blocked (no pending) → autoresearch crashed during 汇缩写入 → coordinator writes persistence 汇缩 from state.json (crash兜底) → advance_plan(phase=completed)
     - Has pending → re-dispatch research-worker → autoresearch resumes from state.json.execution interruption point

### Git consistency check (all phases)

After any crash recovery:

- git log --oneline -5 → verify last commit matches state.json.phase_commits[current_phase]
- If git commit SHA mismatch: `git checkout state.json.phase_commits[current_phase] -- .aether/research/` → `git add + commit`
- Dispatch research-worker for current phase

---

## §Repair Crash Recovery

If repair worker (audit or debate) times out or crashes after potentially modifying files:

1. Check whether `.pre_audit_repair_round[N]` (audit) or `.pre_repair_round{N}` (debate) backups exist — these are created by `scripts/backup_repair.sh` before dispatch
2. If backups exist → restore ALL backup files (rename back to original: `cp <file>.pre_*_round{N} <file>`)
3. Check audit/repair report for partial content → if found, note in retry prompt
4. Retry repair dispatch (max 2 retries)
5. If all retries fail → Digest Parsing Fallback with `status: repair_incomplete_risk`

---

## §Digest Parsing Fallback

If digest YAML parsing fails or worker didn't output a digest:

1. Check STATE.md Current Phase — confirm worker wrote files
2. Check worker's expected output files:
   - All expected files exist and non-empty → INCOMPLETE (files exist but no digest, phase may not be complete)
   - All expected files exist and non-empty + STATE.md shows phase advanced → COMPLETED_FALLBACK (infer completion)
   - Some/none files exist → MISSING (phase not completed)
3. INCOMPLETE or MISSING:
   - Report to user: "Phase [name] did not produce a valid digest."
   - Present: files found, STATE.md phase, last DIGESTS.md entry
   - Ask: retry / rollback / skip (only for landscape)?
4. COMPLETED_FALLBACK:
   - Construct fallback digest from file evidence
   - Append to DIGESTS.md with flag: `status: completed_fallback`
   - Proceed to next phase with caution
5. Repair incomplete risk (repair worker crashed after modifying PLAN.md, no valid digest, backup restored):
   - Construct fallback digest with flag: `status: repair_incomplete_risk`
   - Append to DIGESTS.md
   - Present to user: "Repair worker may have partially modified PLAN.md. Backup has been restored. Manual review recommended."
   - Ask: retry repair / proceed with current PLAN.md / abort?

---

## §Task Dispatch Failure

If coordinator dispatch worker fails:

1. Retry max 2 times (total 3 attempts)
2. After 3 failures: report error to user, terminate session, provide phase name, failure reason, completed work summary
3. For execution loop failures: check DIGESTS.md for completed cycles, report partial results

---

## §Health Check Digest Processing

When coordinator receives a health_check PhaseResultDigest:

1. Read digest.status:
   - **pass** → no STATE.md Next Action update, continue original workflow
   - **degraded** → enter degradation handling:
     a. Check for `git_working_dir` failure in digest.failed_items → if present:
     - bash: `git init && git add -A && git commit -m "research: initial state after health check git init"`
     - Re-dispatch worker(mode=health_check, layers=["infrastructure"]) to verify git_working_dir now passes
     - If still degraded (other items) → continue to step b
       b. Backup current Next Action to STATE.md `## Blockers`: `health_degradation: [degradation_summary概要]`
       c. Update STATE.md Next Action: `health check: [degradation概要] → 详情见 ~/.aether/health/global_health.json`
       d. Update STATE.md Health Status section
       e. Inform user of degradation summary
       f. For each remaining item in digest.failed_items (excluding git_working_dir) where auto_installable=true or "partial", sorted by priority, use question tool for per-item authorization (env-setup skill workflow)
       g. After user installs → re-dispatch worker(mode=health_check, layers=None) for full re-check
       h. New digest.status=pass → restore original Next Action from Blockers, remove health_degradation entry
   - **failed** → enter critical failure handling:
     a. Backup Next Action to Blockers
     b. Update Next Action to critical failure summary + pointer to global_health.json
     c. Inform user critical failure cannot be degraded around, requires manual fix
     d. Wait for user to confirm fix → re-dispatch worker for full re-check

---

## §File Location Relocate

When `validate_file_locations` MCP returns compliant=false after digest processing:

### nested_output_dir

Files located at `.aether/research/.aether/research/...` (double-nested with redundant `.aether/research` prefix). Fix: move file to the correct path by removing the redundant nested prefix.

```
bash: mv .aether/research/.aether/research/<nested_path> .aether/research/<correct_path>
```

Update any internal references in the moved file and other files that reference it.

### outside_output_dir

Files located outside `.aether/research/` entirely. Fix: move into appropriate subdirectory within `.aether/research`.

```
bash: mv <outside_path> .aether/research/notepads/<slug>/<filename>
```

Update any internal references.

### persistence_non_whitelisted

Files in `.aether/research/persistence/` that are not in the whitelisted set (STATE.md, state.json, DIGESTS.md, ROADMAP.md, PLAN.md, DEBATE.md, EXECUTION.md, VERIFICATION.md). Fix: move to notepads or delete if temporary.

```
bash: mv .aether/research/persistence/<non_whitelisted_file> .aether/research/notepads/<slug>/<filename>
# or for temporary files:
bash: rm .aether/research/persistence/<temp_file>
```

### After each correction

1. Update all internal references in existing files that point to the old path
2. Re-call `validate_file_locations` via research-state MCP to confirm compliance
3. If still non-compliant → repeat correction for remaining violations
4. Once fully compliant → proceed with digest processing (append to DIGESTS.md → advance_plan → git commit → Notice → route → Terminal Action)

---

## §STATE.md Format Templates

### Health Status Format

```markdown
## Health Status (project-level, updated: [ISO 8601])

persistence: pass
skill_chain: pass
runtime: degraded
cross_mcp: pass

→ infrastructure + network 详情：`~/.aether/health/global_health.json`
→ 网络可达性详情：`~/.aether/health/network_status.md`
→ 各层检测项详情：`run_health_check` 返回值
```

### Next Action Update Rules

| Scenario                                               | Next Action Rule                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| health check all pass                                  | **DO NOT update** Next Action, keep original value                                   |
| health check finds degradation (session start)         | Write `health check: [degradation概要] → 详情见 ~/.aether/health/global_health.json` |
| uv unavailable (Tier 0 LLM bootstrap)                  | Write `health check: uv不可用 → 详情见 ~/.aether/health/global_health.json`          |
| User requests "检查环境" (during active phase)         | **DO NOT update** Next Action, keep original value                                   |
| User supplements environment → re-check passes         | Restore **pre-check** Next Action from Blockers                                      |
| User supplements environment → re-check still degraded | Update to remaining degradation summary                                              |

---

## §User-Triggered Health Check

On user requests "检查环境" or "health check" (during active workflow):

1. Dispatch research-worker(mode=health_check, layers=None) → wait for digest
2. Migrate temp files (same as session start step 5)
3. Update STATE.md Health Status section
4. **DO NOT update Next Action** — informational only, does not change workflow progress
5. If degradation found → inform user, but do NOT proactively enter env-setup flow

On user says "我已补充环境" / "我安装了缺失的 xxx":

1. Dispatch research-worker(mode=health_check, layers=None) → wait for digest (full re-check)
2. Migrate temp files
3. If digest.status=pass → restore Next Action from Blockers, remove health_degradation entry
4. If digest.status=degraded → update Next Action to remaining degradation summary + pointer to global_health.json

---

## §LLM-only Mode Behavior

When uv is unavailable and user declines installation:

- Do NOT call any MCP tool
- Do NOT dispatch research-worker (worker depends on MCP)
- Do NOT execute any Python script
- Do NOT use SymPy verification
- Only use LLM reasoning, basic bash commands (git, curl), local file read/write
- Mark STATE.md `infrastructure: degraded`, details in `~/.aether/health/global_health.json`

### Tier 0 LLM Bootstrap

If `~/.aether/bin/uv --version` fails:

1. Inform user: "uv 不可用，MCP 工具无法启动。uv 是所有 Python 计算的基础依赖。"
2. uv installation is handled by the coordinator's uv bootstrap step (research-coordinator §8 Session Start Procedure, Step 1) — this recovery path only **detects**; it does not install. Re-run that uv bootstrap step if needed.
3. User declines uv installation → continue in LLM-only mode

### Tier 0.5: Cache validity + global directory pre-creation

1. bash: `bash ~/.aether/health/cache_check.sh`
2. exit 0 (cache valid) → read `~/.aether/health/global_health.json` cache, skip health check dispatch
3. exit 1 (cache expired or missing) → pre-create global health directory:
   - bash: `mkdir -p ~/.aether/health`
   - write: `~/.aether/health/global_health.json` (empty placeholder `{}`)
   - write: `~/.aether/health/network_status.md` (empty placeholder)

### Tier 1-3: Dispatch worker

`task(subagent_type: "research-worker", prompt: "mode=health_check, layers=[\"infrastructure\",\"persistence\",\"skill_chain\"]")`

Wait for worker to return health_check PhaseResultDigest.

### Migrate temp files to global location

1. Read digest.output_paths.temp_global_health_json → write `~/.aether/health/global_health.json`
2. Read digest.output_paths.temp_network_status_md → write `~/.aether/health/network_status.md`
3. bash: `rm .aether/research/.health_global.json .aether/research/.health_network.md`

4. Process digest per §Health Check Digest Processing above
5. Write STATE.md Health Status section (per-layer pass/fail/degraded + pointers to global_health.json and network_status.md)
