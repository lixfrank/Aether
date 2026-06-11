# Edge Cases & Error Handling

This reference contains decision tables, error handling procedures, session recovery, and state.json operational details. Autoresearch reads these when encountering non-normal paths during Step 4 execution.

## Execution-level Failure Decision

After local-executor returns task_result, autoresearch judges whether execution produced verifiable files:

| Condition                                               | Decision           | Next action                                                            |
| ------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------- |
| task_result empty/no structured content                 | execution_failed   | current_cycle < 3 → backup + retry; current_cycle ≥ 3 → mark Qn failed |
| Qn_REASONING.md + Qn_EXECUTION.md not exist             | execution_failed   | Same as above                                                          |
| Qn_REASONING.md + Qn_EXECUTION.md exist + digest normal | execution_produced | Proceed to verification dispatch                                       |
| digest.status=failed (partial output)                   | execution_produced | Proceed to verification dispatch                                       |

## Verification Decision 判定规则

Autoresearch judges from verification_digest claims + reasoning sub-fields directly. **No `status` field** in verification_digest.

| Condition                                                                      | Decision            | Next action                                                                                                                                     |
| ------------------------------------------------------------------------------ | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| claims_failed empty + ALL reasoning sub-fields PASS or N/A                     | **resolved**        | Write conclusion_summary to state.json.resolved_conclusions[Qn] → continue next question                                                        |
| reasoning has FAIL + fallback_applicability=FAIL                               | **paused_ask_user** | Design-level failure — immediately output paused digest (pause_reason: fallback_failed_ask_user), NO retry (neither execution nor verification) |
| reasoning has FAIL + fallback_applicability≠FAIL                               | **retry_execution** | Execution cycle < 3 → backup + retry; ≥ 3 → mark Qn failed                                                                                      |
| claims_failed non-empty + ALL reasoning PASS                                   | **retry_execution** | Method may be flawed — execution cycle < 3 → backup + retry                                                                                     |
| claims_failed non-empty + reasoning has FAIL (not fallback_applicability=FAIL) | **retry_execution** | Both reasoning and conclusion issues — execution cycle < 3 → retry                                                                              |
| execution cycle ≥ 3 + still not resolved                                       | **failed**          | Mark question_status=failed → trigger failure propagation                                                                                       |

"ALL reasoning sub-fields PASS or N/A": fallback_applicability=N/A treated as PASS. Other 4 sub-fields (method_fidelity, step_completeness, assumption_audit, dependency_usage) must ALL be PASS.

## Verification Digest 解析失败处理

Autoresearch extracts verification_digest YAML block from task_result text. Three failure scenarios:

| Scenario                             | Detection                                                               | Handling                                                                                                                                                                    |
| ------------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| verification 中断（worker 崩溃）     | task_result 为空或无结构化内容                                          | verification_retries < 3 → re-dispatch verification worker; verification_retries ≥ 3 → mark Qn failed                                                                       |
| verification 完成但格式不符合 schema | task_result 有内容但无法解析为 YAML block                               | verification_retries < 3 → re-dispatch with emphasis "output MUST include `yaml phase_result_digest:` code block as last output"; verification_retries ≥ 3 → mark Qn failed |
| autoresearch 提取内容失败            | YAML 解析成功但关键字段缺失（question、claims、reasoning_verification） | verification_retries < 3 → re-dispatch with "must include all required fields"; verification_retries ≥ 3 → mark Qn failed                                                   |

**verification_retries 独立计数**: Uses state.json.execution.verification_retries[Qn]. Initialized to 0 per question. Incremented on each verification retry. Upper limit 3. Reset to 0 on execution cycle retry or question resolved.

**verification retry does NOT consume execution cycle**: Only execution failure consumes execution cycle count. Verification is an independent step.

**verification retry does NOT backup Qn files**: Verification worker rewrites Qn_VERIFICATION.md each time. Only execution cycle retry backs up all Qn files.

## state.json Operations

### state.json.execution Schema

```json
{
  "execution": {
    "current_wave": 1,
    "current_question": "Q1",
    "current_cycle": 1,
    "current_step": "execution",
    "verification_retries": {
      "Q1": 0
    },
    "question_status": {
      "Q1": "pending",
      "Q2": "pending"
    },
    "resolved_conclusions": {
      "Q1": {
        "conclusion_summary": "...",
        "output_paths": {
          "reasoning": "notepads/[slug]/execution/Q1_REASONING.md",
          "execution": "notepads/[slug]/execution/Q1_EXECUTION.md",
          "verification": "notepads/[slug]/execution/Q1_VERIFICATION.md"
        }
      }
    }
  }
}
```

### Initialization (when state.json.execution does NOT exist)

```bash
slug=$(ls .aether/research/notepads/ | head -1)
jq '.execution = {
  "current_wave": 1,
  "current_question": "[first question in Wave 1]",
  "current_cycle": 1,
  "current_step": "execution",
  "verification_retries": {},
  "question_status": {
    "Q1": "pending",
    "Q2": "pending",
    ...
  },
  "resolved_conclusions": {}
}' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json
```

### Step Updates (agent directly writes, only modifies execution sub-object)

```bash
# Set current_step = execution (before dispatching local-executor)
jq '.execution.current_step = "execution"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Set current_step = verification (before dispatching verification)
jq '.execution.current_step = "verification"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# For resolved question:
jq '.execution.question_status.[Qn] = "resolved" | .execution.resolved_conclusions.[Qn] = {"conclusion_summary": "[conclusion_summary]", "output_paths": {"reasoning": "notepads/[slug]/execution/[Qn]_REASONING.md", "execution": "notepads/[slug]/execution/[Qn]_EXECUTION.md", "verification": "notepads/[slug]/execution/[Qn]_VERIFICATION.md"}} | .execution.current_wave = [wave_number] | .execution.current_question = "[Qn]" | .execution.current_cycle = [C]' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# For failed question:
jq '.execution.question_status.[Qn] = "failed" | .execution.current_wave = [wave_number] | .execution.current_question = "[Qn]" | .execution.current_cycle = [C]' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Reset verification_retries on cycle retry:
jq '.execution.verification_retries.[Qn] = 0' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json
```

**current_step 值域**: `{execution, verification}` — only for session recovery interruption point identification. Other steps (prepare context, decision, failure propagation, backup) don't need interruption recovery (autoresearch executes them directly, no subagent dispatch).

### state.json 写入失败恢复

If jq write fails (file lock, permissions) → autoresearch outputs paused digest (status=paused, pause_reason=state_update_failed, pause_details contains error info). Coordinator re-dispatches autoresearch.

If jq unavailable → use Python json module fallback:

```python
python3 -c "import json; d=json.load(open('state.json')); d['execution']['current_wave']=2; json.dump(d, open('state.json','w'))"
```

Or use edit tool to directly modify state.json execution sub-object fields.

### Safety Constraints

- **Only modify execution sub-object**: agent using jq or edit tool must only modify `execution` sub-object fields, NOT touch phase, plan_number, audit, conventions, progress, phase_commits
- **Phase transitions via MCP**: advance_plan still called by coordinator via MCP — agent does NOT directly modify phase and plan_number fields
- **question_status preserves terminal states**: failed/blocked entries are NOT cleared. failed/blocked question lists derived dynamically from question_status filter, NO independent failed_questions/blocked_questions arrays
- **Rollback to earlier phase**: execution sub-object is entirely cleared (question IDs may change), no interaction with audit sub-object

## Session Recovery (autoresearch layer)

When autoresearch is re-dispatched for session recovery:

1. Read state.json.execution → current_wave, current_question, current_cycle, current_step, verification_retries, question_status
2. Resume based on state:
   - current_step = "execution" → check if Qn_REASONING.md + Qn_EXECUTION.md exist
     - Files exist and complete → construct fallback digest, directly enter verification dispatch (verification_retries continues from state.json, NOT reset)
     - Files don't exist → re-dispatch local-executor (cycle = current_cycle), reset verification_retries to 0
   - current_step = "verification" → check if Qn_VERIFICATION.md exists
     - File exists → construct fallback verification digest, directly do decision
     - File doesn't exist → re-dispatch verification worker (verification_retries continues from state.json, NOT reset)
   - question_status has blocked → continue next non-blocked question
   - question_status has pending → continue from that question

## Subagent Dispatch Constraints

- local-executor: For all local tasks. delegation_depth=0 enforced via task() runtime parameter
- research-verifier: For general mode verification. Same delegation_depth=0 enforcement
- gpd-verifier: For physics mode domain-specific verification. Dispatched by autoresearch directly, NOT through research-worker. Same delegation_depth=0 enforcement
- FORBIDDEN: Dispatching explore or general subagents for execution or verification work
- FORBIDDEN: Dispatching verification subagent through research-worker (dispatch directly via task tool)

## Backup Before Retry

When retrying execution for Qn (decision = retry_execution):

```bash
slug=$(ls .aether/research/notepads/ | head -1)
cp .aether/research/notepads/${slug}/execution/Qn_REASONING.md .aether/research/notepads/${slug}/execution/Qn_REASONING_cycle${C}.md
cp .aether/research/notepads/${slug}/execution/Qn_EXECUTION.md .aether/research/notepads/${slug}/execution/Qn_EXECUTION_cycle${C}.md
cp .aether/research/notepads/${slug}/execution/Qn_VERIFICATION.md .aether/research/notepads/${slug}/execution/Qn_VERIFICATION_cycle${C}.md
```

(C = current cycle number being backed up, not new cycle number)

After backup:

1. Increment current_cycle for Qn
2. Reset verification_retries[Qn] to 0
3. Dispatch new execution + verification cycle
