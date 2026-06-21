# Edge Cases & Error Handling

This reference contains decision tables, error handling procedures, session recovery, and state.json operational details. Autoresearch reads these when encountering non-normal paths during Step 5 execution.

## Execution-level Three-Stage Decision

autoresearch 在 local-executor 返回后应用三阶段判定. SKILL.md Step 5e / worker-prompts.md 的深度要求均引用此处.

### Stage 1 — Output Completeness Check

| Condition                                                                                                                 | Decision           | Next action                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| task_result empty/no structured content                                                                                   | execution_failed   | Proceed to Stage 2                                                                                                                                                                                                             |
| Qn_REASONING.md + Qn_EXECUTION.md not exist                                                                               | execution_failed   | Proceed to Stage 2                                                                                                                                                                                                             |
| 文件存在，内容深度足够（substantive 行数 ≥ 100 且三准则满足，见 worker-prompts.md §MANDATORY CONTENT DEPTH REQUIREMENTS） | execution_produced | Proceed to verification dispatch (Step 5f-g)                                                                                                                                                                                   |
| 文件存在，内容深度不足（行数 < 100 或三准则失败，见 worker-prompts.md §MANDATORY CONTENT DEPTH REQUIREMENTS）             | execution_shallow  | dispatch judgment-worker(shallow-judgment, 见 worker-prompts.md §Judgment Worker Prompt Templates) → 据 improvement_guidance 构造 shallow_retry prompt → re-dispatch local-executor（1 shallow_retry，does NOT consume cycle） |

> **produced/shallow 判定纯文件驱动**: Stage 1 的 produced/shallow/failed 三态**完全由文件存在性 + 内容深度决定**，与 `digest.status`（local-executor 自我评估）无关. executor 自评 "failed" 不代表文件无验证价值——若文件实质则进 verification（由 verification 判定 claim 真实 pass/fail）；若文件浅薄则 shallow_retry. `digest.status` 字段保留在 execution_cycle_digest schema 中作 informational（供 Stage 2 根因分析参考），但**不参与 Stage 1 判定**.

**行数预筛两阶段设计**:

- **预筛（cheap）**: autoresearch 用 bash `grep -cvE '^\s*$\|^\s*#'` 获取 substantive 行数（不加载内容到 context）. < 100 行 → 直接判 shallow（fast path，跳过 judgment-worker dispatch，构造 generic retry prompt）；≥ 100 行 → 进入第二阶段
- **权威评估（accurate）**: dispatch judgment-worker(shallow-judgment) 读文件 + 应用三准则 rubric. 若 shallow 返回 deficient_steps + improvement_guidance（targeted retry prompt）

### Stage 2 — Root-Cause Analysis (for execution_failed only)

Autoresearch reads task_result + any partial local-executor output to classify root cause:

| Root Cause Category                                                                                                                            | Action                                                                                                                                                                                                                                                                              | Cycle consumption                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Environment gap（tool/package missing，not caught in Step 3）                                                                                  | attempt bash self-build per Step 4 procedure. If succeeds → update ENVIRONMENT.md, re-dispatch local-executor（1 environment_retry，does NOT consume cycle）. If fails → reclassify gap as user_decision_needed, mark affected questions as blocked (blocking_reason="environment") | environment_retry: does NOT consume cycle (max 1)                                            |
| PLAN.md method too vague（vagueness_type=method_vague）OR claim/falsification test fundamentally impossible（vagueness_type=claim_impossible） | output paused digest（pause_reason=plan_vague_need_debate）. Suggest coordinator re-enter phase_debate. Does NOT retry execution                                                                                                                                                    | Does NOT consume cycle (returns to debate)                                                   |
| Local-executor crash/timeout（含运行时 OOM/超时/资源耗尽）                                                                                     | retry with simplified task scope（reduce complexity, narrow scope）. 运行时资源不足（OOM/超时）走此路径，**不**在 Step 3 判 hard_blocked——执行前无法可靠预判算力/内存需求                                                                                                           | Consumes cycle（simplified-task 是诊断前置，**不独占 cycle**——见下方 cycle accounting note） |
| Environment physically impossible（Step 3 未探测到的架构/OS 不匹配，执行中暴露）                                                               | mark affected questions as `blocked`，写 `blocking_reason[Qn]="environment"` + `blocking_dependency[Qn]="[missing environment description]"`. Other questions continue normally. 此为 Step 3 漏判的兜底——正常运行应已在 Step 3 判 hard_blocked                                      | N/A (blocked, not terminal for whole execution)                                              |

vagueness_type 区分:

- `method_vague`: executor 无法从 PLAN.md method 描述确定具体执行步骤（method 缺乏可操作性——无具体工具/命令/参数，无逐步说明）
- `claim_impossible`: claim 或 falsification test 与数学/物理定律矛盾（claim 根本不可行，无论 method 如何细化）. autoresearch dispatch judgment-worker(claim_impossible_classification) 得到 level（L1/L2/L3）写入 paused digest，coordinator 据 level 路由（L1/L2→phase_debate / L3→phase_framing，详见 `references` 下 coordinator phase-routing.md §plan_vague_need_debate 处理流程）

> **claim_impossible 的判定增强**: autoresearch 在 Stage 2 识别 claim_impossible 后，**先 dispatch judgment-worker(task d, claim_impossible_classification)** 获得 level（L1/L2/L3）+ 修正方向，再将分类结果写入 paused digest. coordinator 读取 digest 中的 level 做唯一一次 phase_rollback 到正确目标（L1/L2→debate / L3→framing）. 分类先于回退——确保 coordinator 做唯一一次回退到正确目标，避免"先回退到 debate 再发现是 L3 应回退 framing"的双回退.

> **crash/timeout cycle accounting**（权威澄清）: crash/timeout 路径中，simplified-task 与 full-task **共享同一个 cycle**——simplified-task 是 full-task 的诊断前置，不单独消耗 cycle. 即：一次 crash 烧掉 1 个 cycle（在该 cycle 内先 simplified 获取诊断，再 full-task 重试），而非 2 个.
>
> **retry-type dispatch 的 crash 处理**: shallow_retry / environment_retry / verification_shallow_retry 的 dispatch 若发生 crash/timeout，**走 Stage 2 的 crash/timeout 路径（consumes cycle）**，而非降级为该 retry 的失败. 即：retry-type dispatch 的 crash 与 normal dispatch 的 crash 同等对待——crash 是运行时资源问题，与 retry 类型无关. 重试耗尽后（cycle ≥ 3）mark Qn failed.

### Stage 3 — Cycle Decision

- 只有消耗 cycle 的操作才计入 3-cycle limit per question
- shallow_retry: max 1 per question per cycle, does NOT consume cycle (修复 dispatch 质量). Reset to 0 on cycle-consuming retry
- environment_retry: max 1 per question per cycle, does NOT consume cycle (修复环境). Reset to 0 on cycle-consuming retry
- verification_shallow_retry: max 1 per question per cycle, does NOT consume cycle (见 worker-prompts.md §Verification Worker Prompt Template). Reset to 0 on cycle-consuming retry
- plan_vague: does NOT consume cycle (returns to debate)
- Each retry type is independently counted — using shallow_retry does not reduce available environment_retry
- Execution cycle limit remains 3
- **Progressive simplification across cycles**: cycle ≥2 的 dispatch prompt MUST 包含 simplified scope hint（源自上一 cycle judgment-worker(failure-synthesis) 返回的 `revision_direction`）. cycle 2/3 不得以相同 scope 重试上一 cycle 的失败. 若 failure-synthesis 未提供明确修正方向（key_failures 为空），autoresearch 自主决定简化范围（reduce method steps / narrow verification range / 降低精度）. **自主简化时 MUST 在 dispatch prompt 内显式记录决策依据三要素**（简化了什么 / 为什么 / 预期影响）.
- **Total execution attempt limit**: each question max 7 local-executor dispatches:
  - Cycle 1: 1 dispatch + 1 shallow_retry + 1 environment_retry = 3 dispatches
  - Cycle 2: 1 dispatch + 1 shallow_retry + 1 environment_retry = 3 dispatches（retry 计数 reset 后重新可用）
  - Cycle 3: 1 dispatch = 1 dispatch
  - 合计 3 + 3 + 1 = 7（cycle 2/3 的 shallow/env retry 仅在该 cycle 的 dispatch 失败时才触发）
- verification dispatch 另计（每 cycle 最多 1 normal + 1 verification_shallow_retry = 2 次，3 cycle 最多 6 次 verification dispatch）

**Reset rules**（SKILL.md 与其他处均引用此处）:

- execution_shallow_retries[Qn]: reset to 0 on cycle-consuming retry or question resolved
- environment_retries[Qn]: reset to 0 on cycle-consuming retry or question resolved
- verification_shallow_retries[Qn]: reset to 0 on cycle-consuming retry or question resolved
- current_retry_type: dispatch 返回后（无论成功失败）重置为 normal；cycle-consuming retry 或 question resolved 时亦重置为 normal
- **retry-type dispatch crash → cycle-consuming retry**: shallow_retry / environment_retry / verification_shallow_retry 的 dispatch 若 crash/timeout，走 Stage 2 crash/timeout 路径（consumes cycle），等同于 cycle-consuming retry——重置该 cycle 的全部 retry 计数器（shallow/env/verification_shallow → 0），current_retry_type → normal

### Retry Loop-back Procedure (after shallow_retry / environment_retry / simplified-task retry)

1. Loop back to Step 5b（prepare execution context）— re-read dependency context 和 ENVIRONMENT.md（每次 dispatch 前都 re-read，含正常推进与 retry——前一个 question 的 environment_retry 可能已更新 ENVIRONMENT.md）
2. Backup previous output before re-dispatch:
   - shallow_retry: Qn_REASONING.md → Qn_REASONING_shallow1.md，Qn_EXECUTION.md → Qn_EXECUTION_shallow1.md
   - environment_retry: Qn_REASONING.md → Qn_REASONING_env1.md，Qn_EXECUTION.md → Qn_EXECUTION_env1.md
   - cycle retry: Qn_REASONING.md → Qn_REASONING_cycle[N].md 等（per existing backup procedure）
3. Update state.json（原子写）:
   - shallow_retry: `execution_shallow_retries[Qn] += 1`，`current_step = "execution"`，`current_retry_type = "shallow"`
   - environment_retry: `environment_retries[Qn] += 1`，`current_step = "execution"`，`current_retry_type = "environment"`
   - cycle retry: `current_cycle += 1`，`verification_retries[Qn] = 0`，`execution_shallow_retries[Qn] = 0`，`environment_retries[Qn] = 0`，`current_step = "execution"`，`current_retry_type = "normal"`
4. Supplement dispatch prompt with retry context:
   - shallow_retry: autoresearch 读 judgment-worker 返回的 deficient_steps + improvement_guidance，构造 targeted retry prompt，包含 (a) "PREVIOUS OUTPUT WAS SHALLOW"，(b) 具体浅薄步骤列表，(c) shallow 备份文件引用
   - environment_retry: "ENVIRONMENT GAP RESOLVED — missing [tool/package] has been installed. Re-attempt full execution"
5. Simplified-task cycle-consuming retry (crash/timeout → Stage 2 → simplified scope):
   - Autoresearch decides simplified scope autonomously — reduce method steps, narrow verification range, simplify computation（自主简化时按 Stage 3 progressive simplification 三要素记录决策依据）
   - simplified-task 与 full-task **共享同一 cycle**——先 dispatch simplified-task 获取诊断，再 dispatch full-task；两者共属一个 cycle，不递增两次 current_cycle
   - After simplified task completes with diagnostic insights → dispatch full-task execution（**同一 cycle 内**，不再 consume a new cycle）
   - Simplified task insight MUST be injected into full-task dispatch prompt
6. Failure synthesis (cycle-consuming retry only，Step 5m，在 backup 完成、cycle 递增之后、dispatch 新 cycle 之前执行): dispatch judgment-worker(failure-synthesis) → 读 cycle_revision_context → 注入下一 cycle dispatch prompt（supplements 而非 replaces local-executor 自己的 revision_needed）

### Per-Question Worst-Case Dispatch Sequence (7 local-executor dispatches)

Concrete trace through Stage 1/2/3 tables above (verification dispatches shown inline but counted separately). See SKILL.md Step 5 for step-by-step loop control.

1. Cycle 1 dispatch [1] → execution_shallow →
2. shallow_retry1 [2] → execution_failed → environment gap → self-build →
3. environment_retry1 [3] → execution_produced → verification (FAIL) → retry_execution (cycle 2)
4. Cycle 2 dispatch [4] (shallow/env retries reset to 0) → execution_shallow →
5. shallow_retry1 [5] (post-reset) → execution_failed → environment gap → self-build →
6. environment_retry1 [6] (post-reset) → execution_produced → verification (FAIL) → retry_execution (cycle 3)
7. Cycle 3 dispatch [7] → execution_produced → verification (FAIL) →
   mark Qn failed (cycle limit exhausted)

注: verification_shallow_retry 发生在 verification dispatch 内部（Step 5h0），不计入上述 7 次 local-executor dispatch.

### Gap Classification 表

**谁负责分类**: autoresearch 在 Step 3（Environment Probe）自行做 gap classification——不 dispatch judgment-worker. 理由：gap classification 的本质是**规则匹配 + bash probe 结果**（非语义判断）；judgment-worker 的四项任务（a/b/c/d）都是**读产出文件做语义判断**，性质不同；且 judgment-worker 无 bash 权限（`.aether/agent/judgment-worker.md` 显式只读），无法做环境探测. auto_installable / user_decision_needed 的分类依据是确定性规则表；hard_blocked 的判定依据是设备硬件/架构的客观事实.

| Category               | Definition                                                                                                                                                                                                                                                                                                                                | autoresearch Action                                                                                                                                                                                                                                                                                  |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto_installable`     | Software that autoresearch can install via bash without requiring user consent for system-level operations                                                                                                                                                                                                                                | Attempt installation via bash (Step 4). Use web search to find correct installation method — do NOT rely on hardcoded commands. If install succeeds → remove gap, continue. If install fails → reclassify as `user_decision_needed`                                                                  |
| `user_decision_needed` | Software/environment that requires user action: sudo/brew/apt system installs, manual source code modifications, license-bound software, GPU/CUDA unavailable (user can connect/switch), Python runtime missing (user can install), or any installation that autoresearch failed to complete                                              | Mark affected questions as `blocked` in state.json.execution.question_status, write `blocking_reason[Qn]="environment"` + `blocking_dependency[Qn]="[gap 描述]"`. Questions NOT affected continue execution normally. At execution end, include in final_execution_digest → coordinator informs user |
| `hard_blocked`         | 设备的物理/架构约束使目标任务**在本会话内无任何软件安装或用户操作可使其可行**. 判定依据是设备硬件/架构的客观事实（非软件缺失）：架构不匹配（如任务需 NVIDIA CUDA 但设备是 Apple Silicon Mac）、OS 不支持所需运行时（如需 Linux-only 工具链但设备是 Windows 无 WSL）、硬件资源永久不足（如任务需特定硬件加速器但设备无对应硬件且无法扩展） | Do NOT dispatch executor for affected questions. Other questions continue normally                                                                                                                                                                                                                   |

**hard_blocked 保守判定原则**（权威）：hard_blocked 是终态决策（不可逆，question 不派发 executor、不问用户），误判代价是跳过可执行的 question. 因此:

- **仅在能客观确认**（bash probe 可验证的架构/OS 事实）时判 hard_blocked——如 `uname -m` 显示 ARM 架构且 PLAN.md 标注需 CUDA
- **无法客观确认**（如"RAM 可能不够"、"算力可能不足"、"任务复杂度可能超时"）→ **降级为 `user_decision_needed`**（保守——不轻易判终态，让用户决定）
- **运行时资源问题不归 Step 3 的 hard_blocked**: OOM/超时等运行时问题发生在执行后，走 Stage 2 的 Local-executor crash/timeout 路径（consumes cycle），重试耗尽后 mark blocked（非终态 hard_blocked）. Step 3 的 hard_blocked 严格限定为执行前可客观探测的硬件/架构事实

Classification rules:

- Python packages missing, uv/venv available → `auto_installable`
- Wolfram paclets missing, wolframscript available → `auto_installable`
- System tools missing（requires sudo/brew/apt）→ `user_decision_needed`（autoresearch MUST NOT run system installers without user consent）
- GPU/CUDA required but unavailable → `user_decision_needed`（用户可连接 eGPU 或换机器——"当前不可用"≠"不可解决"，保守归类给用户决策）
- Python runtime missing, uv unavailable → `user_decision_needed`（用户可安装 Python/uv——"当前缺失"≠"不可解决"）
- Requires code modification outside .aether/research → `user_decision_needed`
- Unknown/ambiguous dependency → `user_decision_needed`
- Failed auto_installable attempt → reclassify as `user_decision_needed`
- **架构不匹配**（bash `uname -m` 显示的架构与 PLAN.md environment_requirements 要求的架构/硬件矛盾，如任务需 NVIDIA CUDA 但设备是 Apple Silicon ARM64 无 CUDA 支持）→ `hard_blocked`
- **OS 不支持所需运行时**（设备操作系统无法安装 PLAN.md 要求的 Linux-only 工具链，且无 WSL/容器等兼容层）→ `hard_blocked`
- **硬件资源永久不足且不可扩展**（如任务需特定硬件加速器/FPGA 但设备无对应硬件且无法外接）→ `hard_blocked`

> **hard_blocked 判定的可判定性约束**: 上述 hard_blocked 规则均要求 bash probe 能客观验证（`uname -m` / `uname -s` / 硬件枚举）. 若 PLAN.md 的 environment_requirements 未标注精确的架构/硬件要求，或 bash probe 无法确认"不可解决"→ 降级为 `user_decision_needed`. 运行时的算力/内存不足（执行前无法可靠预判）不在 Step 3 判定，走 Stage 2 crash/timeout 路径.

**终止路径判定（无 pending question 时）**: 若 Step 3 Gap classification 后所有 question 均为 blocked（无 pending question），按 blocked 组成分支:

- **全 hard_blocked**（架构/OS/硬件客观不匹配，无可问用户的内容）→ 不进入 per-question loop，直接进入 Step 6 Final Output → final_execution_digest: status=partial, resolved_questions=[], 所有 question 列入 blocked_questions → coordinator advance_plan(completed) 呈现 partial results. 这是 early abort 的特例（Step 5j 在第一个 question 前即触发：无 pending → early abort）
- **存在 user_decision_needed blocked**（含纯 user_decision_needed 集合 或 hard_blocked + user_decision_needed 混合集）→ 只要存在 user_decision_needed blocked，就有问用户的价值 → 输出 paused digest（pause_reason=environment_blocked_ask_user）. user_options 仅纳入 user_decision_needed 的 question（hard_blocked 的标注为不可解决，不纳入 user_options）. 见 coordinator 处理 + digest-schemas.md §paused digest

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
    "execution_shallow_retries": {
      "Q1": 0
    },
    "environment_retries": {
      "Q1": 0
    },
    "verification_shallow_retries": {
      "Q1": 0
    },
    "current_retry_type": "normal",
    "blocking_reason": {
      "Q2": "environment"
    },
    "blocking_dependency": {
      "Q2": "[gap description]"
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

**新增字段说明** (本节为以下字段的权威操作定义):

- `execution_shallow_retries[Qn]`: init 0, max 1 per cycle, reset on cycle-consuming retry or resolved
- `environment_retries[Qn]`: init 0, max 1 per cycle, reset on cycle-consuming retry or resolved
- `verification_shallow_retries[Qn]`: init 0, max 1 per cycle, reset on cycle-consuming retry or resolved
- `current_retry_type`: 值域 `normal | shallow | environment | verification_shallow`. dispatch 前（local-executor 或 verification worker）写入对应类型；dispatch 返回后（无论成功失败）重置为 normal
- `blocking_reason[Qn]`: 值域 `environment | vagueness | dependency`. **创建者**: environment (autoresearch Step 3 Gap Classification 判 user_decision_needed / hard_blocked 时, 或 Stage 2 environment gap 自建失败时)；vagueness (autoresearch Stage 2 判 method_vague / claim_impossible 但用户选择 Option 2 skip vague questions 时, 写 question_status=skipped_vague 不走 blocking_reason；预留 future-proofing)；dependency (autoresearch Step 5k failure propagation 判 critical dependency failed 时)
- `blocking_dependency[Qn]`: 自由文本 gap 描述，仅作展示

**`blocking_reason[Qn]` 消费者**:

- phase_rollback step 6: 读 `blocking_reason[Qn]` 决定 blocked question 是否恢复为 pending（vagueness→pending, environment→保留, dependency→保留）
- coordinator environment_blocked_ask_user digest: 将 `blocking_dependency[Qn]` 自由文本展示给用户
- failure propagation / early abort 判定: 读 question_status=blocked 即跳过，不区分 blocking_reason（blocking_reason 只影响 rollback 行为，不影响 per-question loop 推进）

### Initialization (when state.json.execution does NOT exist)

```bash
slug=$(ls .aether/research/notepads/ | head -1)
jq '.execution = {
  "current_wave": 1,
  "current_question": "[first question in Wave 1]",
  "current_cycle": 1,
  "current_step": "execution",
  "verification_retries": {},
  "execution_shallow_retries": {},
  "environment_retries": {},
  "verification_shallow_retries": {},
  "current_retry_type": "normal",
  "blocking_reason": {},
  "blocking_dependency": {},
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

# Set current_retry_type before dispatch (normal | shallow | environment | verification_shallow):
jq '.execution.current_retry_type = "shallow"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Increment execution_shallow_retries[Qn] before shallow_retry re-dispatch:
jq '.execution.execution_shallow_retries.[Qn] = ((.execution.execution_shallow_retries[Qn] // 0) + 1) | .execution.current_step = "execution" | .execution.current_retry_type = "shallow"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Increment environment_retries[Qn] before environment_retry re-dispatch:
jq '.execution.environment_retries.[Qn] = ((.execution.environment_retries[Qn] // 0) + 1) | .execution.current_step = "execution" | .execution.current_retry_type = "environment"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Increment verification_shallow_retries[Qn] before verification_shallow_retry re-dispatch:
jq '.execution.verification_shallow_retries.[Qn] = ((.execution.verification_shallow_retries[Qn] // 0) + 1) | .execution.current_step = "verification" | .execution.current_retry_type = "verification_shallow"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Reset current_retry_type to normal after dispatch returns (success or failure):
jq '.execution.current_retry_type = "normal"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Reset all retry counters on cycle-consuming retry (shallow/env/verification_shall all → 0 for Qn):
jq '.execution.execution_shallow_retries.[Qn] = 0 | .execution.environment_retries.[Qn] = 0 | .execution.verification_shallow_retries.[Qn] = 0 | .execution.verification_retries.[Qn] = 0 | .execution.current_cycle = [C] | .execution.current_step = "execution" | .execution.current_retry_type = "normal"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Mark question blocked + write blocking_reason + blocking_dependency (environment gap):
jq '.execution.question_status.[Qn] = "blocked" | .execution.blocking_reason.[Qn] = "environment" | .execution.blocking_dependency.[Qn] = "[gap description]"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Mark question blocked + blocking_reason = dependency (failure propagation):
jq '.execution.question_status.[Qn] = "blocked" | .execution.blocking_reason.[Qn] = "dependency" | .execution.blocking_dependency.[Qn] = "[upstream Qd failed]"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Mark question skipped_vague (user chose Option 2 skip vague questions):
jq '.execution.question_status.[Qn] = "skipped_vague"' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json
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
- **Phase transitions via MCP**: advance_plan still called by coordinator via MCP — agent does NOT directly modify phase and plan_number fields. phase_rollback called by coordinator via MCP (统一回退处理, 详见下方 Rollback 规则 + research-state MCP `phase_rollback`)
- **question_status preserves terminal states**: failed/blocked entries are NOT cleared. failed/blocked question lists derived dynamically from question_status filter, NO independent failed_questions/blocked_questions arrays
- **Rollback (unified rule)**: `phase_rollback(preserve_execution=true)` 保留 execution sub-object（保留 resolved_conclusions + question_status），重置运行时字段（cycle/retries/wave）；`phase_rollback(preserve_execution=false)` 清除整个 execution sub-object. advance_plan **不做回退**（只前进，plan_number 递增）；phase_rollback **只回退**（plan_number 递减）. checkpoint_rejection (preserve_execution=false, 用户发起, 不计入 cross_phase_rollback_count)；execution_vague (preserve_execution=true, 系统发起, 计入)；gap_reexamination (preserve_execution=true, 系统发起, 计入).

## Session Recovery (autoresearch layer)

When autoresearch is re-dispatched for session recovery:

判断顺序（**current_retry_type 检查优先于 current_step 通用逻辑**）:

1. **读 `current_retry_type`**:
   - = "shallow" | "verification_shallow" → shallow retry 统一恢复分支（见下）
   - = "environment" → environment retry 恢复分支（见下）
   - = "normal"（或字段缺失，向后兼容）→ 走 step 2 current_step 通用逻辑

2. **current_step 通用逻辑**（current_retry_type=normal 时）:
   - = "execution" → check if Qn_REASONING.md + Qn_EXECUTION.md exist
     - Files exist and complete → construct fallback digest, directly enter verification dispatch (verification_retries continues from state.json, NOT reset)
     - Files don't exist → re-dispatch local-executor (cycle = current_cycle), reset verification_retries to 0
   - = "verification" → check if Qn_VERIFICATION.md exists
     - File exists → construct fallback verification digest, directly do decision
     - File doesn't exist → re-dispatch verification worker (verification_retries continues from state.json, NOT reset)
   - question_status has blocked → continue next non-blocked question
   - question_status has pending → continue from that question

**shallow retry 统一恢复分支**（current_retry_type=shallow 或 verification_shallow——execution_shallow 与 verification_shallow 共享语义：retry 目的是修复浅薄产出，崩溃时磁盘上的文件是 retry 前的原始浅薄产出，不能直接进入下一步）:

shallow retry 共享恢复模式（差异用 [execution_shallow] / [verification_shallow] 标注）:

- 将现有产出文件视为浅薄产出——[execution_shallow: Qn_REASONING.md + Qn_EXECUTION.md, current_step="execution"；verification_shallow: Qn_VERIFICATION.md, current_step="verification"]——**不能**直接送入下一步
- 检查对应 retry 计数——[execution_shallow: execution_shallow_retries[Qn]；verification_shallow: verification_shallow_retries[Qn]]:
  - 若已达上限（=1）→ **降级**:
    - [execution_shallow] → consume cycle（increment current_cycle, reset execution_shallow_retries/environment_retries to 0, current_retry_type=normal）→ re-dispatch local-executor (cycle=new current_cycle)
    - [verification_shallow] → 视为 verification 失败: 若 reasoning 子字段 FAIL → retry_execution（consume cycle）；若 reasoning 全 PASS 但 conclusion 证据不足 → retry_execution（method 可能 flawed）
  - 若未达上限 → 保持对应 retry 计数当前值（dispatch 已计入但未返回），重新构造对应 shallow_retry dispatch prompt，re-dispatch（不再次递增计数）
  - 若产出文件不存在 → shallow_retry dispatch 未产出，直接 re-dispatch 对应 shallow_retry（不递增计数）

**environment retry 恢复分支**（current_retry_type=environment，current_step="execution" 时）:

- environment_retry 前已执行 Step 4 环境自建，崩溃时自建可能完成也可能未完成（bash install 可能已执行但 ENVIRONMENT.md 尚未更新）
- **不依赖 ENVIRONMENT.md gaps 判断**——崩溃可能发生在 install 之后、ENVIRONMENT.md 更新之前. 改为**重新执行 Step 3 环境 probe**（bash 探测原 gap 对应的工具/包是否可用），以 probe 实际结果为准:
  - probe 显示工具已可用（自建成功，即使 ENVIRONMENT.md 未更新）→ 更新 ENVIRONMENT.md（移除 gap），按 normal execution 恢复（产出文件存在→verification；不存在→re-dispatch normal, current_retry_type=normal, 不递增 environment_retries）
  - probe 显示工具仍不可用（自建未完成或失败）→ reclassify 为 user_decision_needed，mark question blocked，continue next question
- 若 environment_retries[Qn] 已达上限（=1）→ reclassify 为 user_decision_needed, mark blocked

current_retry_type 在恢复决策完成后、re-dispatch 前重置为对应类型（继续 shallow/env retry 则设为对应值，回退 normal 则设为 normal）.

> **shallow retry 与 environment retry 崩溃恢复的不对称（权威——有意为之）**:
>
> - **shallow retry 崩溃 → re-dispatch**: shallow_retry 修复的是"产出内容深度"——这个修复只能在 worker dispatch 内完成，没有独立于 dispatch 的可检查副作用. 崩溃时磁盘上仍是原始浅薄产出，修复未发生，必须 re-dispatch.
> - **environment retry 崩溃 → re-probe（不 re-dispatch）**: environment_retry 的修复是 Step 4 的 bash install——这是独立于后续 executor dispatch 的**可验证副作用**. 崩溃可能发生在 install 完成之后、ENVIRONMENT.md 更新之前（记录不可信，但 bash 现实是 ground truth）. 所以先 re-probe 确认环境是否已修复: 已修复 → 按 normal execution 恢复（环境已就绪 = 普通执行，不再是 environment_retry 语义）；未修复 → 不 re-dispatch（重跑 executor 只会再次遇到同一 gap），直接 reclassify 为 user_decision_needed.
>
> 一句话: **shallow_retry 修复"产出内容"（只能重做），environment_retry 修复"环境状态"（有可探测的 bash 副作用，先 probe 再决定）**.

> **注**: judgment-worker dispatch 的崩溃恢复不使用专门字段. judgment-worker 是无状态只读、re-dispatch 幂等的——崩溃恢复时若需重新判定深度，autoresearch 用行数预筛（bash `grep -cv`，始终可用，不依赖 judgment-worker）重建判定: 行数 < 阈值 → 直接判 shallow 构造 retry prompt；行数 ≥ 阈值 → re-dispatch judgment-worker 重新判定. 任务 d（claim_impossible_classification）**由 autoresearch dispatch**——PLAN.md 此时尚未被修改，重读产生相同分类（幂等安全）.

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
