# Layer 3.17: Phase Execution Resilience — 环境自建、深度约束、三阶段判定

> 前置依赖: Layer 3.12（per-question execution 推进管理器）+ Layer 3.5/3.9（环境隔离 + local-executor）+ Layer 3.8（debate phase）+ Layer 3.11（framing_reasoning）。
> 解决 phase_execute 过快终止的 4 个核心问题：环境缺失自动终止、subagent 拉起失败、遇到问题轻易放弃、reasoning/verification 内容过于简略。
>
> 修改文件：
>
> - `.aether/skills/autoresearch/SKILL.md` + `references/`（worker-prompts / edge-cases / digest-schemas）
> - `.aether/agent/local-executor.md` + `judgment-worker.md`（新增）；coordinator 路由（改动 21-24）落地于 `research-coordinator/references/phase-routing.md`（coordinator agent `research.md` 委派 `/research-coordinator` skill 加载该 reference，无需直接改动 `research.md`）
> - `.aether/skills/debate-repair/SKILL.md` + `research-question-framing/SKILL.md`
> - `.aether/skills/research-coordinator/references/`（phase-routing / phase-detail-tables）
> - `.aether/mcp/research-state/server.py`
>
> **组织原则**：每个机制只有一个权威定义处（§3 核心状态机 / §4 内容深度 / §5 judgment-worker / §6 framing re_derive_gap），其余位置只写"见 §X"。本文档不含"v2 占位"——所有内容均为要落地的实现细节。

---

## 1. 问题诊断

参考执行 `fbi_dct_nis`（7 个问题全部失败/阻塞，0 个成功）揭示了 4 个核心问题：

### 问题 1：环境缺失 → 自动终止，不尝试自建

autoresearch SKILL.md Step 3 第 5 步：

> "Gap check: If critical gap exists → do NOT dispatch executor for affected tasks"

这直接阻止了 local-executor 被派发。`fbi_dct_nis` 中 ENVIRONMENT.md 探测到 3 个 critical gap，autoresearch 就不派发 executor 了。但实际上：

- `ibp_reducer_dependencies` 是 Wolfram 包安装问题——autoresearch（有 bash 权限）可以尝试安装
- `dct_high_precision_wrapper` 是代码修改问题——local-executor 可以在 .aether/research 内编写新 wrapper
- `nis_weight_clipping` 是算法验证问题——local-executor 可以执行 bias bound 估算

问题本质：Gap Check 假设"环境不存在 = 无法执行"，但 phase_execute 应该在环境中构建所需的一切。

### 问题 2：local-executor 没有被正确拉起

autoresearch 因 gap 不派发 executor → executor 从未被 dispatch → verification 也不执行 → 所有问题在 cycle 1 就宣告失败。整个 per-question 循环被跳过。

### 问题 3：遇到问题轻易放弃

autoresearch 和 local-executor 的"消极失败"模式：

- local-executor Step 3：工具不可用 → "report failure"
- local-executor Step 5：persistent errors → "report failure"
- edge-cases.md：execution_failed → 3 次就宣告问题失败
- autoresearch：verification claims_failed → retry_execution → 3 次就宣告问题失败

没有"自我修复"环节。遇到错误时，agent 的选择是重试同一操作（期望不同结果），而非分析错误原因并调整策略。

### 问题 4：reasoning/verification 内容过于简略

所有 Qn_REASONING.md 都使用公式化"两步模板"（28 行），没有任何推导：

1. "Map PLAN requirement to executable checks"
2. "Decide pass/fail from recorded evidence"

这不是推导而是审计。所有 Qn_VERIFICATION.md 也只有 PASS/FAIL 标签而无证据细节（49 行）。

根因：

- 没有强制 local-executor 进行实质性计算
- 没有"最低内容深度"约束
- autoresearch 对 execution_produced 的判定标准太宽松（文件存在就算 produced）

---

## 2. 设计决策

### D1：环境自建职责分层 — autoresearch 统一负责，local-executor 不参与

环境自建（系统级工具安装、Wolfram paclet 安装、venv 创建、venv 包安装）**统一由 autoresearch 负责**。local-executor 只负责在就绪环境中执行具体任务——**不参与任何环境构建**（不安装系统工具、不安装 Wolfram paclet、不创建 venv、不安装 venv 包）。

理由：autoresearch 是循环控制器，有 bash 权限和更多上下文/决策能力；环境准备是跨问题的全局任务；local-executor 的定位是"在就绪环境中执行"（delegation_depth=0 的 leaf agent），不应承担"从零构建环境"的重任；**职责边界单一最清晰**——所有环境构建动作只由 autoresearch 执行，local-executor 遇到环境缺失一律报告，由 autoresearch 的 environment_retry 机制统一处理（见 §3.2 Stage 2）。

local-executor 遇到环境缺失时的行为：报告完整错误信息给 autoresearch（通过 task_result），**不自行尝试安装任何软件**（系统工具、Wolfram paclet、venv 包均不安装）。autoresearch 收到报告后决定下一步（自建环境/暂停/重新派发）。

### D2：Gap 分类 — 三档分类 + 自建尝试

每个 gap 按可解决性分为 3 类（详细规则见 §3.2 Gap Classification 表）：

- `auto_installable`：autoresearch 可以通过 bash 尝试安装。安装方法通过 web search 搜索，不硬编码具体命令
- `user_decision_needed`：需要用户安装/决策（含 GPU/CUDA 不可用、Python runtime 缺失等用户可解决的缺失）。标记受影响 question 为 blocked，其余继续执行；全部 blocked → 输出 paused digest（pause_reason=environment_blocked_ask_user）
- `hard_blocked`：设备硬件/架构客观约束使目标在本会话内不可行（架构不匹配/OS 不支持/硬件不可扩展）。不派发 executor，其余 question 继续（保守判定见 §3.2）

### D3：PLAN.md 过于模糊 → 终止 phase_execute 回到 phase_debate

当 autoresearch 发现 PLAN.md method 对于 executor 过于模糊时，autoresearch 不自行展开 method。而是终止 phase_execute，输出 paused digest（pause_reason=plan_vague_need_debate），由 coordinator 将项目回退至 phase_debate，以 debate-repair 机制细化执行计划。

理由：autoresearch 是执行层 agent，不应自行修改或补充 PLAN.md 的方法设计；phase_debate 的修复机制（debate-repair）专门处理 PLAN.md 的问题；PLAN.md 模糊是设计层面的问题，应回到设计层面解决。

回退流程与 phase_rollback MCP 的完整实现见 §3.1。

### D4：execution_produced 判定纳入内容深度检查

execution_produced 判定要求**文件存在 + 内容深度 ≥ 最低标准**。内容深度不足的产出定义为 `execution_shallow`，autoresearch 补充深度要求后重新派发 local-executor（1 次 shallow_retry，不消耗 cycle）。深度判据与 shallow_retry 机制见 §3.2 / §4.1。

### D5：三阶段判定 — 根因分析 + 分类修复

autoresearch Step 5e（local-executor 返回后）采用三阶段判定（Stage 1 Output Completeness / Stage 2 Root-Cause Analysis / Stage 3 Cycle Decision）。shallow_retry、environment_retry 不消耗 cycle；PLAN.md 模糊不消耗 cycle（回退到 debate）。完整判定表、Retry Loop-back、worst-case 流程见 §3.2。

### D6：verification 内容深度约束

verification dispatch prompt 中要求每个子字段有详细证据（method_fidelity 逐句对比、step_completeness 逐条 found/not-found、assumption_audit 标注 framing_reasoning 行号、dependency_usage 显式范围对比、conclusion verification 按 claim 类型分层要求）。判据与 verification_shallow_retry enforcement 见 §3.2 / §4.3。

### D7：digest.status 的角色

`digest.status`（local-executor 自我评估）**不参与 Stage 1 produced/shallow 判定**——产出判定纯由文件存在性 + 内容深度驱动（见 §3.2 Stage 1）。`digest.status` 仅作 informational：保留在 execution_cycle_digest schema 中供 §3.2 Stage 2 根因分析参考（如 status=failed 提示存在部分失败步骤，需 root-cause 分析）。

---

## 3. 核心状态机

本节是以下机制的**单一权威定义处**：phase_rollback MCP、三阶段判定、claim_impossible L1/L2/L3 路由、retry 计数器与崩溃恢复。其余各节只写"见 §3.x"。

### 3.1 phase_rollback MCP

新增 MCP tool `phase_rollback`，统一处理所有 phase 回退（checkpoint 回退 + execution 回退 + L3 framing 回退）。与 `advance_plan` 职责分离：advance_plan 只前进（plan_number 递增），phase_rollback 只回退（plan_number 递减）。

**参数**：

```python
def phase_rollback(
    target_phase: str,       # 目标 phase（phase_debate / phase_framing）
    target_plan_number: str, # 目标 plan_number（如 8 或 6）
    project_dir: str,
    preserve_execution: bool = True,  # 是否保留 execution sub-object
    rollback_reason: str = "",  # checkpoint_rejection / execution_vague / gap_reexamination
    rollback_details: dict = {},  # 结构化信息（见下表）
    commit_sha: str = "",
) -> dict[str, Any]:
```

**rollback_reason 值域**（权威定义）：

| rollback_reason        | 触发场景                                       | rollback_details 结构                                        | 注入目标 phase prompt 的内容                       |
| ---------------------- | ---------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------- |
| `checkpoint_rejection` | 用户在 phase_checkpoint 拒绝 plan              | `{user_feedback: "..."}`                                     | 用户反馈作为 debate 新 round 的额外约束            |
| `execution_vague`      | autoresearch 发现 PLAN.md method 模糊          | `{vagueness_details: [...], resolved_questions: [...]}`      | vagueness_details 作为 debate 新 round 的聚焦约束  |
| `gap_reexamination`    | judgment-worker 判定 claim_impossible level=L3 | `{affected_gap_id, gap_reexamination_reason, what_to_avoid}` | 作为 framing re_derive_gap 模式的聚焦约束（见 §6） |

> **注**：环境缺失导致 question blocked **不属于回退场景**——它是 pause（不是 rollback）。所有 question 因 `user_decision_needed` 环境 blocked（无 pending）→ autoresearch 输出 paused digest（`pause_reason=environment_blocked_ask_user`），由 coordinator 请求用户操作。此路径**不调用 phase_rollback、不计入 `cross_phase_rollback_count`**。

**实现逻辑**：

1. 读取 state.json → 获取当前 phase 和 plan_number
2. 验证：target_plan_number 必须小于当前 plan_number（只允许向后回退）；target_phase 必须在 VALID_PHASES 中（phase_debate index 8、phase_framing index 6 为合法回退目标）
3. **记录回退事件 + 递增计数器**（同一事务）：
   - 向 `state.json.progress.rollback_plans` 数组追加 entry（schema 见下方 §rollback_plans entry）
   - 递增 `state.json.cross_phase_rollback_count`（顶层整数，`_default_state()` 初始化为 0）。**计数范围**：仅对系统发起的回退计数（rollback_reason ∈ {`execution_vague`, `gap_reexamination`}）。用户发起的 checkpoint_rejection 不计入（用户多次拒绝是正常交互）
4. **跨阶段回退守卫**（step 3 之后、step 5 之前检查计数器，不再递增）：
   - `cross_phase_rollback_count >= 3`：phase_rollback **不执行 step 5 起的后续回退操作**（不更新 phase/plan_number、不重置 execution/debate 字段），直接返回 `{"action": "terminated", "reason": "cross_phase_rollback_limit_reached", "count": 3}`。此时 step 3 已追加的 rollback_plans entry 需标注 `"guarded": true` 字段；terminated 路径仍写 `rollback_context`（供终止流程报告引用最新回退上下文），随后 step 11 一次性落盘
   - coordinator 收到 `terminated` 后执行**终止流程**（见 §3.1 末尾）
   - **守卫触发条件的设计决策**：守卫仅在**当前调用为系统发起回退**（rollback_reason ∈ {`execution_vague`, `gap_reexamination`}）时检查上限。理由：cross_phase_rollback_count 只对系统发起的回退计数（step 3），守卫与计数器同源——用户发起的 `checkpoint_rejection` 不计数，故即使计数器已达 3，用户仍可拒绝 checkpoint（用户多次拒绝是正常交互，不应被系统预算阻断）。terminated 返回额外携带 `limit` 字段（值 3）便于诊断
5. 更新 phase 和 plan_number
6. 如果 preserve_execution=true → 保留 state.json.execution sub-object，但重置运行时字段：
   - `current_cycle` → 1（新 method = 新起点）
   - `execution_shallow_retries` / `environment_retries` / `verification_shallow_retries` / `verification_retries` → 全部重置为 0；`current_retry_type` → `normal`（新 method = 新起点，所有运行时 retry 计数器与 dispatch 类型归零）
   - `current_wave` / `current_question` / `current_step` → 重置为 null
   - `question_status` 中：resolved/pending/failed → 保留；blocked → 读取 `blocking_reason[Qn]` 判定（见 §3.4 blocking_reason 字段定义）：`blocking_reason="vagueness"` → 改为 pending（vagueness 是 plan 问题，debate/repair 后重试）；`blocking_reason="environment"` → 保留（环境 blocked 需用户操作，rollback 不解决）；`skipped_vague` → 改为 pending
7. 如果 preserve_execution=false → 清除整个 execution sub-object
8. 如果 target_phase=phase_debate → 重置 debate sub-object 运行时字段：`current_sub_phase` → null，`escalate_topics` → []，`rounds_completed` → 保留（作为上下文）
9. 如果 commit_sha → 记录到 phase_commits
10. 将 rollback_details 写入 state.json 新字段 `rollback_context`（coordinator 读取此字段构造 re-dispatch prompt）：`{"reason": rollback_reason, "details": rollback_details, "timestamp": "[ISO 8601]"}`。rollback_context 在下次 phase 前进或回退时被覆盖（只保留最近一次）
11. 写入 state.json

**原子性与崩溃恢复**：steps 3-10 全部操作**内存中的 state dict**（读取后修改，不逐步写盘），只有 step 11 `_write_state` 是唯一的磁盘写入点——采用 `FileLock + json.dump + tmp 文件 + os.replace` 原子写。`_write_state` 为 phase_rollback 与 advance_plan 共享的底层写函数，二者均经此路径获得崩溃安全（崩溃 mid-write 时 tmp 文件孤立但 state.json 不变）。

- 崩溃发生在 step 11 之前 → state.json 未被修改 → 重跑 phase_rollback 即可
- 崩溃发生在 step 11 写入中 → tmp + os.replace 模式保证要么完整写入要么不变 → 重跑 phase_rollback 即可
- 守卫拒绝场景（step 4 达上限）：step 3 已在内存中追加 rollback_plans entry（含 `guarded: true`），step 11 将其写入

**禁止逐 step 写盘**：不得在 step 3/6/8/10 各自调用 jq 写 state.json（会产生中间不一致状态）。所有字段修改在内存 dict 上完成后，step 11 一次性写入。

**rollback_plans entry schema**（回退教训档案——完整结构化字段）：

```json
{
  "from_phase": "[current_phase]",
  "from_plan": "[current_plan_number]",
  "to_phase": "[target_phase]",
  "to_plan": "[target_plan_number]",
  "reason": "[rollback_reason]",
  "timestamp": "[ISO 8601]",
  "guarded": false,
  "source_commit": "[git HEAD SHA — 完整状态可从 git 历史检索]",
  "evidence": "[直接 copy：judgment-worker.evidence_analysis 或 autoresearch.vagueness_description 或 digest.pause_details]",
  "lessons": {
    "what_went_wrong": "[直接 copy：judgment-worker.evidence_analysis]",
    "what_to_avoid": "[直接 copy：judgment-worker.what_to_avoid]",
    "alternative_direction": "[直接 copy：judgment-worker.claim_revision_direction / question_redesign_direction / gap_reexamination_reason]"
  },
  "preserved_results": "[resolved_conclusions 摘要，preserve_execution=true 时]"
}
```

**写入职责**：phase_rollback 在 step 3 追加 entry 时，从传入的 `rollback_details`（coordinator 传入，含 judgment-worker 返回 + digest evidence）直接 copy 结构化字段。coordinator 不再写 markdown，phase_rollback 内部完成教训并入。

**字段自动填充与别名兼容**（实现细节，落地于 `server.py` phase_rollback）：

- `source_commit`：phase_rollback 内部执行 `git rev-parse HEAD` 获取完整 SHA（git 失败时填 `""`）
- `preserved_results`：preserve_execution=true 时，phase_rollback 自动从 `state.json.execution.resolved_conclusions` 摘要填充（列出已 resolved 的 question ID + conclusion_summary 摘要），供 `WORKFLOW_TERMINATION_REPORT.md` 消费，无需 coordinator 传入
- `lessons.alternative_direction`：兼容三种回退场景的别名——按 rollback_reason 自动从 `rollback_details` 中提取 `claim_revision_direction`（L1）/ `question_redesign_direction`（L2）/ `gap_reexamination_reason`（L3）中首个非空字段，写入 `alternative_direction`。coordinator 传入的 `rollback_details` 无需统一字段名
- `lessons.what_went_wrong` / `lessons.what_to_avoid`：直接 copy `rollback_details` 的对应字段（缺失时填 `""`）

**读取路径**（framing/analysis/debate worker dispatch prompt 注入）：worker 读 `rollback_context`（最近一次摘要）+ `rollback_plans`（累积教训链）。两者分工：rollback_context 是薄摘要+指针（单条，覆盖），rollback_plans 是完整累积教训链（数组，追加）。

**与 phase_checkpoint 回退的统一**：

| 维度                            | checkpoint 回退                                         | execution 回退                                      | L3 framing 回退                                            |
| ------------------------------- | ------------------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------- |
| 触发时机                        | 用户在 phase_checkpoint 拒绝 plan                       | autoresearch 发现 plan 模糊                         | judgment-worker 判定 claim_impossible L3                   |
| rollback_reason                 | `checkpoint_rejection`                                  | `execution_vague`                                   | `gap_reexamination`                                        |
| preserve_execution              | false（execution 不存在，清除是安全兜底）               | true（保留 resolved_conclusions + question_status） | true（保留与错误 Gap 无关的 resolved questions）           |
| 计入 cross_phase_rollback_count | 否                                                      | 是                                                  | 是                                                         |
| 回退携带信息                    | user_feedback                                           | vagueness_details + resolved_questions              | affected_gap_id + gap_reexamination_reason + what_to_avoid |
| DEBATE.md / PLAN.md 处理        | 保留，追加新 round                                      | 保留，追加新 round                                  | framing splice 写回（见 §6）                               |
| git checkout                    | 排除 state.json（保留 rollback_plans/rollback_context） | 不走 git checkout（系统回退，worker 覆盖文件）      | 不走 git checkout                                          |

**checkpoint 回退的 git checkout 排除协议**（仅 checkpoint 场景——系统发起的回退不走 git checkout）：

```bash
git checkout <target_sha> -- .aether/research/ \
  ':(exclude).aether/research/persistence/state.json'
git add .aether/research/
git commit -m "research: rollback to phase_[target] (plan [N]) — rollback_plans preserved"
```

state.json 排除：保留 phase_rollback 的语义化写入（plan_number/rollback_plans/rollback_context）。其余文件正常还原。

**终止流程**（phase_rollback 返回 terminated 时，coordinator 执行）：

1. 调用 `advance_plan(phase=completed, plan_number=最终 plan_number)` 将项目标记为已完成
2. 写入 `persistence/WORKFLOW_TERMINATION_REPORT.md`：
   - `## Termination Reason`：cross_phase_rollback_limit_reached（agent 工作流陷入反复回退）
   - `## Rollback History`：从 `rollback_plans` 提取全部回退记录（from→to/reason/timestamp/evidence/lessons，含被守卫拒绝的那次）
   - `## Current State Snapshot`：当前 PLAN.md / DEBATE.md / execution results 状态摘要
   - `## Failure Pattern Diagnosis`：分析为何 agent 陷入反复回退（识别失败模式：method_vague 与 claim_impossible 交替、同一 Gap 被反复判定错误、framing 推导链结构性缺陷等）
   - `## Human Intervention Needed`：对人类用户的建议
3. 使用 question tool 向用户呈现报告核心结论 + 报告文件路径，等待人工介入。**不** re-dispatch 任何 worker

### 3.2 三阶段判定

autoresearch 在 local-executor 返回后应用三阶段判定。本节是**权威定义**——SKILL.md Step 5e / edge-cases.md §Execution-level Three-Stage Decision / worker-prompts.md 的深度要求均引用此处。

**Stage 1 — Output Completeness Check**：

| Condition                                                                   | Decision           | Next action                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| task_result empty/no structured content                                     | execution_failed   | Proceed to Stage 2                                                                                                                                                            |
| Qn_REASONING.md + Qn_EXECUTION.md not exist                                 | execution_failed   | Proceed to Stage 2                                                                                                                                                            |
| 文件存在，内容深度足够（substantive 行数 ≥ 阈值且三准则满足，见 §4.1/§4.2） | execution_produced | Proceed to verification dispatch (Step 5f-g)                                                                                                                                  |
| 文件存在，内容深度不足（行数 < 阈值 或 三准则失败，见 §4.1/§4.2）           | execution_shallow  | dispatch judgment-worker(shallow-judgment, 见 §5) → 据 improvement_guidance 构造 shallow_retry prompt → re-dispatch local-executor（1 shallow_retry，does NOT consume cycle） |

> **produced/shallow 判定纯文件驱动**：Stage 1 的 produced/shallow/failed 三态**完全由文件存在性 + 内容深度决定**，与 `digest.status`（local-executor 自我评估）无关。executor 自评 "failed" 不代表文件无验证价值——若文件实质则进 verification（由 verification 判定 claim 真实 pass/fail）；若文件浅薄则 shallow_retry。`digest.status` 字段保留在 execution_cycle_digest schema 中作 informational（供 Stage 2 根因分析参考），但**不参与 Stage 1 判定**。

**Stage 2 — Root-Cause Analysis**（for execution_failed only）：

Autoresearch reads task_result + any partial local-executor output to classify root cause：

| Root Cause Category                                                                                                                            | Action                                                                                                                                                                                                                                                    | Cycle consumption                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Environment gap（tool/package missing，not caught in Step 3）                                                                                  | attempt bash self-build per Step 4 procedure. If succeeds → update ENVIRONMENT.md, re-dispatch local-executor（1 environment_retry，does NOT consume cycle）. If fails → reclassify gap as user_decision_needed, mark affected questions as blocked       | environment_retry: does NOT consume cycle (max 1)                                            |
| PLAN.md method too vague（vagueness_type=method_vague）OR claim/falsification test fundamentally impossible（vagueness_type=claim_impossible） | output paused digest（pause_reason=plan_vague_need_debate）. Suggest coordinator re-enter phase_debate. Does NOT retry execution                                                                                                                          | Does NOT consume cycle (returns to debate)                                                   |
| Local-executor crash/timeout（含运行时 OOM/超时/资源耗尽）                                                                                     | retry with simplified task scope（reduce complexity, narrow scope）. 运行时资源不足（OOM/超时）走此路径，**不**在 Step 3 判 hard_blocked——执行前无法可靠预判算力/内存需求                                                                                 | Consumes cycle（simplified-task 是诊断前置，**不独占 cycle**——见下方 cycle accounting note） |
| Environment physically impossible（Step 3 未探测到的架构/OS 不匹配，执行中暴露）                                                               | mark affected questions as `blocked`，写 `blocking_reason[Qn]="environment"` + `blocking_dependency[Qn]="[missing environment description]"`（见 §3.4）. Other questions continue normally. 此为 Step 3 漏判的兜底——正常运行应已在 Step 3 判 hard_blocked | N/A (blocked, not terminal for whole execution)                                              |

vagueness_type 区分：

- `method_vague`：executor 无法从 PLAN.md method 描述确定具体执行步骤（method 缺乏可操作性——无具体工具/命令/参数，无逐步说明）
- `claim_impossible`：claim 或 falsification test 与数学/物理定律矛盾（claim 根本不可行，无论 method 如何细化）。处理见 §3.3

> **claim_impossible 的判定增强**：autoresearch 在 Stage 2 识别 claim_impossible 后，**先 dispatch judgment-worker(task d, claim_impossible_classification)** 获得 level（L1/L2/L3）+ 修正方向，再将分类结果写入 paused digest（digest schema 见改动 17）。coordinator 读取 digest 中的 level 做唯一一次 phase_rollback 到正确目标（L1/L2→debate / L3→framing）。分类先于回退——见 §3.3 "分类先于回退"。

> **crash/timeout cycle accounting**（权威澄清）：crash/timeout 路径中，simplified-task 与 full-task **共享同一个 cycle**——simplified-task 是 full-task 的诊断前置，不单独消耗 cycle。即：一次 crash 烧掉 1 个 cycle（在该 cycle 内先 simplified 获取诊断，再 full-task 重试），而非 2 个。理由：judgment-worker 的诊断类操作不消耗 cycle 的哲学一致（diagnosis ≠ execution attempt）；若 simplified 独占 cycle，crash 若发生在 cycle 1 → simplified 占 cycle 2 → full 占 cycle 3 → full 只剩单发机会，crash 容忍度过低。
>
> **retry-type dispatch 的 crash 处理**：shallow_retry / environment_retry / verification_shallow_retry 的 dispatch 若发生 crash/timeout，**走 Stage 2 的 crash/timeout 路径（consumes cycle）**，而非降级为该 retry 的失败。即：retry-type dispatch 的 crash 与 normal dispatch 的 crash 同等对待——crash 是运行时资源问题，与 retry 类型无关。重试耗尽后（cycle ≥ 3）mark Qn failed。

**Stage 3 — Cycle Decision**（权威定义）：

- 只有消耗 cycle 的操作才计入 3-cycle limit per question
- shallow_retry：max 1 per question per cycle，does NOT consume cycle（修复 dispatch 质量）。Reset to 0 on cycle-consuming retry
- environment_retry：max 1 per question per cycle，does NOT consume cycle（修复环境）。Reset to 0 on cycle-consuming retry
- verification_shallow_retry：max 1 per question per cycle，does NOT consume cycle（见 §4.3）。Reset to 0 on cycle-consuming retry
- plan_vague：does NOT consume cycle（returns to debate）
- Each retry type is independently counted — using shallow_retry does not reduce available environment_retry
- Execution cycle limit remains 3
- **Progressive simplification across cycles**：cycle ≥2 的 dispatch prompt MUST 包含 simplified scope hint（源自上一 cycle judgment-worker(failure-synthesis) 返回的 `revision_direction`）。cycle 2/3 不得以相同 scope 重试上一 cycle 的失败——failure-synthesis 的修正方向 MUST 注入 dispatch prompt（见 §3.2 Retry Loop-back Procedure step 6 + §5 任务 c）。若 failure-synthesis 未提供明确修正方向（key_failures 为空），autoresearch 自主决定简化范围（reduce method steps / narrow verification range / 降低精度）。**自主简化时 MUST 在 dispatch prompt 内显式记录决策依据三要素**（不入独立日志，避免新增持久化）：
  1. **简化了什么**（具体到哪个 method step / verification range / 精度档位）
  2. **为什么**（基于 failure-synthesis 的哪个 key_failure，或自主判断的依据）
  3. **预期影响**（简化后能验证什么、不能验证什么——供 verification 和 audit 判断结论覆盖范围）
- **Total execution attempt limit**：each question max 7 local-executor dispatches：
  - Cycle 1: 1 dispatch + 1 shallow_retry + 1 environment_retry = 3 dispatches
  - Cycle 2: 1 dispatch + 1 shallow_retry + 1 environment_retry = 3 dispatches（retry 计数 reset 后重新可用）
  - Cycle 3: 1 dispatch = 1 dispatch
  - 合计 3 + 3 + 1 = 7（cycle 2/3 的 shallow/env retry 仅在该 cycle 的 dispatch 失败时才触发）
- verification dispatch 另计（每 cycle 最多 1 normal + 1 verification_shallow_retry = 2 次，3 cycle 最多 6 次 verification dispatch）

**Reset rules**（权威定义，SKILL.md 与其他处均引用此处）：

- execution_shallow_retries[Qn]：reset to 0 on cycle-consuming retry or question resolved
- environment_retries[Qn]：reset to 0 on cycle-consuming retry or question resolved
- verification_shallow_retries[Qn]：reset to 0 on cycle-consuming retry or question resolved
- current_retry_type：dispatch 返回后（无论成功失败）重置为 normal；cycle-consuming retry 或 question resolved 时亦重置为 normal
- **retry-type dispatch crash → cycle-consuming retry**：shallow_retry / environment_retry / verification_shallow_retry 的 dispatch 若 crash/timeout，走 Stage 2 crash/timeout 路径（consumes cycle），等同于 cycle-consuming retry——重置该 cycle 的全部 retry 计数器（shallow/env/verification_shallow → 0），current_retry_type → normal

**Retry Loop-back Procedure**（after shallow_retry / environment_retry / simplified-task retry）：

1. Loop back to Step 5b（prepare execution context）— re-read dependency context 和 ENVIRONMENT.md（每次 dispatch 前都 re-read，含正常推进与 retry——前一个 question 的 environment_retry 可能已更新 ENVIRONMENT.md）
2. Backup previous output before re-dispatch：
   - shallow_retry：Qn_REASONING.md → Qn_REASONING_shallow1.md，Qn_EXECUTION.md → Qn_EXECUTION_shallow1.md
   - environment_retry：Qn_REASONING.md → Qn_REASONING_env1.md，Qn_EXECUTION.md → Qn_EXECUTION_env1.md
   - cycle retry：Qn_REASONING.md → Qn_REASONING_cycle[N].md 等（per existing backup procedure）
3. Update state.json（原子写）：
   - shallow_retry：`execution_shallow_retries[Qn] += 1`，`current_step = "execution"`，`current_retry_type = "shallow"`
   - environment_retry：`environment_retries[Qn] += 1`，`current_step = "execution"`，`current_retry_type = "environment"`
   - cycle retry：`current_cycle += 1`，`verification_retries[Qn] = 0`，`execution_shallow_retries[Qn] = 0`，`environment_retries[Qn] = 0`，`current_step = "execution"`，`current_retry_type = "normal"`
4. Supplement dispatch prompt with retry context：
   - shallow_retry：autoresearch 读 judgment-worker 返回的 deficient_steps + improvement_guidance（见 §5），构造 targeted retry prompt，包含 (a) "PREVIOUS OUTPUT WAS SHALLOW"，(b) 具体浅薄步骤列表，(c) shallow 备份文件引用
   - environment_retry："ENVIRONMENT GAP RESOLVED — missing [tool/package] has been installed. Re-attempt full execution"
5. Simplified-task cycle-consuming retry（crash/timeout → Stage 2 → simplified scope）：
   - Autoresearch decides simplified scope autonomously — reduce method steps, narrow verification range, simplify computation（自主简化时按 §3.2 Stage 3 progressive simplification 三要素记录决策依据）
   - simplified-task 与 full-task **共享同一 cycle**（见 §3.2 crash/timeout cycle accounting note）——先 dispatch simplified-task 获取诊断，再 dispatch full-task；两者共属一个 cycle，不递增两次 current_cycle
   - After simplified task completes with diagnostic insights → dispatch full-task execution（**同一 cycle 内**，不再 consume a new cycle）
   - Simplified task insight MUST be injected into full-task dispatch prompt
6. Failure synthesis（cycle-consuming retry only，Step 5m，在 backup 完成、cycle 递增之后、dispatch 新 cycle 之前执行）：dispatch judgment-worker(failure-synthesis, 见 §5) → 读 cycle_revision_context → 注入下一 cycle dispatch prompt（supplements 而非 replaces local-executor 自己的 revision_needed）

**Per-Question Execution Retry Sequence Flow**（worst-case 7 dispatches，verification dispatch 标注但不计入"7"）：

```
[Qn] per-question execution lifecycle (max 7 local-executor dispatches):

Step 5b: Prepare execution context (re-read ENVIRONMENT.md)
  │
  ▼ Step 5c: current_step = "execution"
  ▼ Step 5d: Dispatch local-executor (cycle 1)
  │
  ▼ Step 5e: Read execution results → THREE-STAGE DECISION

  ┌─ Stage 1: Output Completeness Check ──────────────────────────┐
  │ execution_produced → proceed to Step 5f (verification)        │
  │                                                                │
  │ execution_shallow → shallow_retry (max 1 per cycle):          │
  │   行数预筛 → judgment-worker(shallow-judgment) → retry prompt │
  │   loop → Step 5b → 5c → 5d → 5e (re-evaluate)                 │
  │   if still shallow after 1 retry → consume cycle,             │
  │   execution_shallow_retries[Qn] resets to 0, proceed to Stage 2│
  │                                                                │
  │ execution_failed → proceed to Stage 2                         │
  └────────────────────────────────────────────────────────────────┘

  ┌─ Stage 2: Root-Cause Analysis (execution_failed only) ────────┐
  │                                                                │
  │ Environment gap → environment_retry (max 1 per cycle):        │
  │   autoresearch attempts bash self-build (Step 4 procedure)    │
  │   if self-build succeeds:                                     │
  │     loop → Step 5b → 5c → 5d (dispatch with "gap resolved")  │
  │     → 5e (re-evaluate)                                        │
  │   if self-build fails: reclassify as user_decision_needed     │
  │     → mark question blocked, continue others                  │
  │                                                                │
  │ PLAN.md method vague (vagueness_type=method_vague) →          │
  │   output paused digest (pause_reason=plan_vague_need_debate)  │
  │   → coordinator routes to phase_rollback → debate             │
  │                                                                │
  │ Claim impossible (vagueness_type=claim_impossible) →          │
  │   autoresearch dispatch judgment-worker                       │
  │     (claim_impossible_classification) → level L1/L2/L3        │
  │   → output paused digest (含 level, pause_reason=             │
  │     plan_vague_need_debate) → coordinator 据 level 做唯一     │
  │     一次 rollback (L1/L2→debate / L3→framing, 见§3.3)        │
  │                                                                │
  │ Local-executor crash/timeout → cycle retry:                   │
  │   if cycle < 3: simplified scope dispatch + full scope       │
  │     dispatch (same cycle, consumes 1 cycle total,            │
  │     shallow/env retries reset to 0)                          │
  │   if cycle ≥ 3: mark Qn failed → failure propagation         │
  │                                                                │
  │ Environment physically impossible →                            │
  │   mark question blocked, continue others (no paused digest)   │
  └────────────────────────────────────────────────────────────────┘

  ┌─ After verification (Step 5f-5h) ────────────────────────────┐
  │                                                                │
  │ resolved → write resolved_conclusions → next question         │
  │                                                                │
  │ retry_execution → cycle retry:                                 │
  │   backup files → increment cycle → reset retries →           │
  │   judgment-worker(failure-synthesis) → loop → 5b→5c→5d→5e→5f │
  │                                                                │
  │ paused_ask_user → output paused digest →                      │
  │   coordinator asks user → re-dispatch with user decision      │
  │                                                                │
  │ failed → mark question_status=failed →                        │
  │   failure propagation (Step 5k)                                │
  └────────────────────────────────────────────────────────────────┘

Maximum sequence for worst-case question (7 local-executor dispatches;
verification dispatches shown inline but counted separately):

  1. Cycle 1 dispatch [1] → execution_shallow →
  2. shallow_retry1 [2] → execution_failed → environment gap → self-build →
  3. environment_retry1 [3] → execution_produced → verification (FAIL) → retry_execution (cycle 2)
  4. Cycle 2 dispatch [4] (shallow/env retries reset to 0) → execution_shallow →
  5. shallow_retry1 [5] (post-reset) → execution_failed → environment gap → self-build →
  6. environment_retry1 [6] (post-reset) → execution_produced → verification (FAIL) → retry_execution (cycle 3)
  7. Cycle 3 dispatch [7] → execution_produced → verification (FAIL) →
     mark Qn failed (cycle limit exhausted)

  注：verification_shallow_retry 发生在 verification dispatch 内部（Step 5h0），
  不计入上述 7 次 local-executor dispatch。
```

**Gap Classification 表**（§Isolation Strategy Classification 表的 gap 行不再带 critical/medium 严重度标签，所有 gap 一律流入此表，单一权威）：

**谁负责分类**：autoresearch 在 Step 3（Environment Probe）自行做 gap classification——不 dispatch judgment-worker。理由：gap classification 的本质是**规则匹配 + bash probe 结果**（非语义判断）；judgment-worker 的四项任务（a/b/c/d）都是**读产出文件做语义判断**，性质不同；且 judgment-worker 无 bash 权限（§5.1 显式只读），无法做环境探测。auto_installable / user_decision_needed 的分类依据是确定性规则表；hard_blocked 的判定依据是设备硬件/架构的客观事实（见下方保守判定原则）。

| Category               | Definition                                                                                                                                                                                                                                                                                                                                | autoresearch Action                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `auto_installable`     | Software that autoresearch can install via bash without requiring user consent for system-level operations                                                                                                                                                                                                                                | Attempt installation via bash (Step 4). Use web search to find correct installation method — do NOT rely on hardcoded commands. If install succeeds → remove gap, continue. If install fails → reclassify as `user_decision_needed`                                                                                      |
| `user_decision_needed` | Software/environment that requires user action: sudo/brew/apt system installs, manual source code modifications, license-bound software, GPU/CUDA unavailable (user can connect/switch), Python runtime missing (user can install), or any installation that autoresearch failed to complete                                              | Mark affected questions as `blocked` in state.json.execution.question_status, write `blocking_reason[Qn]="environment"` + `blocking_dependency[Qn]="[gap 描述]"`（见 §3.4 字段定义）. Questions NOT affected continue execution normally. At execution end, include in final_execution_digest → coordinator informs user |
| `hard_blocked`         | 设备的物理/架构约束使目标任务**在本会话内无任何软件安装或用户操作可使其可行**。判定依据是设备硬件/架构的客观事实（非软件缺失）：架构不匹配（如任务需 NVIDIA CUDA 但设备是 Apple Silicon Mac）、OS 不支持所需运行时（如需 Linux-only 工具链但设备是 Windows 无 WSL）、硬件资源永久不足（如任务需特定硬件加速器但设备无对应硬件且无法扩展） | Do NOT dispatch executor for affected questions. Other questions continue normally                                                                                                                                                                                                                                       |

**hard_blocked 保守判定原则**（权威）：hard_blocked 是终态决策（不可逆，question 不派发 executor、不问用户），误判代价是跳过可执行的 question。因此：

- **仅在能客观确认**（bash probe 可验证的架构/OS 事实）时判 hard_blocked——如 `uname -m` 显示 ARM 架构且 PLAN.md 标注需 CUDA
- **无法客观确认**（如"RAM 可能不够"、"算力可能不足"、"任务复杂度可能超时"）→ **降级为 `user_decision_needed`**（保守——不轻易判终态，让用户决定）
- **运行时资源问题不归 Step 3 的 hard_blocked**：OOM/超时等运行时问题发生在执行后，走 Stage 2 的 Local-executor crash/timeout 路径（consumes cycle），重试耗尽后 mark blocked（非终态 hard_blocked）。Step 3 的 hard_blocked 严格限定为执行前可客观探测的硬件/架构事实

Classification rules：

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

> **hard_blocked 判定的可判定性约束**：上述 hard_blocked 规则均要求 bash probe 能客观验证（`uname -m` / `uname -s` / 硬件枚举）。若 PLAN.md 的 environment_requirements 未标注精确的架构/硬件要求，或 bash probe 无法确认"不可解决"→ 降级为 `user_decision_needed`。运行时的算力/内存不足（执行前无法可靠预判）不在 Step 3 判定，走 Stage 2 crash/timeout 路径。

**终止路径判定（无 pending question 时）**：若 Step 3 Gap classification 后所有 question 均为 blocked（无 pending question），按 blocked 组成分支：

- **全 hard_blocked**（架构/OS/硬件客观不匹配，无可问用户的内容）→ 不进入 per-question loop，直接进入 Step 6 Final Output → final_execution_digest: status=partial, resolved_questions=[], 所有 question 列入 blocked_questions → coordinator advance_plan(completed) 呈现 partial results。这是 early abort 的特例（Step 5j 在第一个 question 前即触发：无 pending → early abort）
- **存在 user_decision_needed blocked**（含纯 user_decision_needed 集合 或 hard_blocked + user_decision_needed 混合集）→ 只要存在 user_decision_needed blocked，就有问用户的价值 → 输出 paused digest（pause_reason=environment_blocked_ask_user）。user_options 仅纳入 user_decision_needed 的 question（hard_blocked 的标注为不可解决，不纳入 user_options）。见 §3.3 后续 coordinator 处理 + 改动 24 的 3 选项路由

**两类终止路径的设计目的**：

| 路径                    | 触发条件                  | 目的                                               |
| ----------------------- | ------------------------- | -------------------------------------------------- |
| early abort（不问用户） | 全 hard_blocked           | 架构/OS/硬件客观不可行，问也无用——直接呈现 partial |
| paused digest（问用户） | 存在 user_decision_needed | 用户能解决——问才有价值（用户可安装后 re-dispatch） |

### 3.3 claim_impossible L1/L2/L3 路由

claim_impossible 意味着 debate 没审出的 plan 根本问题被 execution 暴露，需按问题层级（Claim/Question/Gap）分层修正。**核心原则：禁止删除 claim——必须保留 Question 与 Gap 映射。**

**分类先于回退（避免双回退）**：autoresearch 在 Stage 2 检测 claim_impossible 后，**立即 dispatch judgment-worker(claim_impossible_classification, 见 §5 任务 d)** 做分类 → 得到 level（L1/L2/L3）+ 修正方向 → 将分类结果写入 paused digest（pause_reason=plan_vague_need_debate, vagueness_type=claim_impossible）→ coordinator 读取 digest 中的 level，做**唯一一次** phase_rollback 到正确目标。回退目标由 level 决定——分类必须在回退之前完成，避免"先回退到 debate 再发现是 L3 应回退 framing"的双回退缺陷。

| 层级                      | 判据                                                       | 问题归属    | 修正动作                                                                                                                                                                                                                                                 | 作用域                              | 路由                                                                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **L1（Claim 过强）**      | Question 合理，但具体 claim 表述过强/不可达                | Claim 层    | 修订 claim 为可达版本 + 重写 falsification test                                                                                                                                                                                                          | PLAN.md §Claims + §Acceptance Tests | coordinator 据 digest.level=L1 → phase_rollback(phase_debate, preserve_execution=true, rollback_reason=execution_vague) → dispatch debate-repair（Local repair），注入 digest 中的 `claim_revision_direction`                             |
| **L2（Question 误框架）** | Question 本身框架错误——Gap→Question 推导引入了不可能的需求 | Question 层 | 重设计 Question（新 falsification 三元素 + 新 method），**保留 Gap 映射**，framing_reasoning.md 加 staleness marker                                                                                                                                      | research_questions.md + PLAN.md     | coordinator 据 digest.level=L2 → phase_rollback(phase_debate, preserve_execution=true, rollback_reason=execution_vague) → dispatch debate-repair（Structural repair），注入 digest 中的 `question_redesign_direction` + `affected_gap_id` |
| **L3（Gap 错误）**        | Gap 不成立/被误识别——知识缺口不存在或被误判                | Gap 层      | judgment-worker 判定 level=L3 → coordinator 据 digest.level=L3 → phase_rollback(phase_framing, target_plan_number=6, preserve_execution=true, rollback_reason=gap_reexamination) → dispatch framing（mode=re_derive_gap，见 §6）。**不经 debate-repair** | framing_reasoning.md + 级联         | coordinator 直接 rollback →framing（单次回退，目标正确）                                                                                                                                                                                  |

**设计理由（诊断与治疗分离 + 分类前置）**：

- **judgment-worker 由 autoresearch dispatch**（而非 coordinator）：autoresearch 刚完成执行，executor 证据（Qn_REASONING.md + Qn_EXECUTION.md）在其 context 中最新鲜；分类是"读判断产数据"，属 autoresearch 已承担的判定职责（与任务 a/b/c 一致）。分类结果（level）写入 digest 供 coordinator 做路由——**coordinator 只消费数据，不产数据**
- L1/L2/L3 分类需读 framing_reasoning.md 完整推导链 + executor 证据 + PLAN.md claims。若 debate-repair 内联分类，这些重读膨胀修复上下文，修复质量衰减
- debate-repair 现有职责是"根据 adjudicator 裁决修复"（治疗），从不自行诊断。L1/L2/L3 分类是诊断——让 debate-repair 同时承担诊断+治疗破坏"裁决者与执行者分离"原则
- L3 最优路径：judgment-worker 读全部重文件 → 返回结构化分类 → framing 的 re_derive_gap 直接用这些字段。不经 debate-repair 避免"debate-repair 读重文件分析 → 结论 L3 我修不了 → framing 重新读这些文件"的冗余
- **分类前置消除双回退**：L3 的正确目标是 framing。若分类发生在回退之后，则 L3 会发生 debate→framing 两次回退——第一次回退到错误目标。分类必须在回退前完成，回退目标由 level 唯一确定

**L2 的 framing_reasoning.md 边界处理**（Structural repair 扩展）：重设计 Question 时，debate-repair 在 framing_reasoning.md 对应 Gap section header 加 staleness marker：`[execution_revealed: question derivation flawed — see PLAN.md for re-derived question, original derivation preserved above for audit]`。保留原推导链（供审计），仅标记其与新 Question 的对应关系过期。新 Question 仍映射到**同一 Gap**（Gap 是知识缺口，Question 是攻击方式；Question 错了换攻击方式，不换缺口）。依赖该 Question 的下游 question：现有 Dependency Consistency Verification（debate-repair Step 4）处理级联。

**method_vague 路径**（与 claim_impossible 对比）：method_vague 不涉及 Gap 层，无需 judgment-worker 分类——coordinator rollback →debate 后直接 dispatch debate-repair 展开具体执行步骤（见 §7.8 debate-repair execution-refine）。

### 3.4 retry 计数器与崩溃恢复

**新增 state.json.execution 字段**：

```json
{
  "execution": {
    "... (existing fields) ...,
    "execution_shallow_retries": { "Q1": 0 },
    "environment_retries": { "Q1": 0 },
    "verification_shallow_retries": { "Q1": 0 },
    "current_retry_type": "normal"
  }
}
```

- `execution_shallow_retries[Qn]`：init 0，max 1 per cycle，reset on cycle-consuming retry or resolved
- `environment_retries[Qn]`：init 0，max 1 per cycle，reset on cycle-consuming retry or resolved
- `verification_shallow_retries[Qn]`：init 0，max 1 per cycle, reset on cycle-consuming retry or resolved
- `current_retry_type`：值域 `normal | shallow | environment | verification_shallow`。dispatch 前（local-executor 或 verification worker）写入对应类型；dispatch 返回后（无论成功失败）重置为 normal

**`blocking_reason[Qn]` 字段定义**（权威——区分 question_status=blocked 的阻塞原因，供 phase_rollback step 6 消费）：

```json
{
  "execution": {
    "blocking_reason": { "Q1": "environment" },
    "blocking_dependency": { "Q1": "[自由文本 gap 描述，仅作展示]" }
  }
}
```

- 值域：`environment | vagueness | dependency`
- **创建者**（谁写入）：
  - `environment`：autoresearch Step 3 Gap Classification 判 user_decision_needed / hard_blocked 时，或 Stage 2 environment gap 自建失败时 → 写 `question_status[Qn]=blocked` + `blocking_reason[Qn]="environment"` + `blocking_dependency[Qn]="[gap 描述]"`
  - `vagueness`：autoresearch Stage 2 判 method_vague / claim_impossible 但用户选择 Option 2（skip vague questions）时 → 写 `question_status[Qn]=skipped_vague`（注：skipped_vague 是独立 status 值，不走 blocking_reason；但若用户选择 Option 1 回退 debate，rollback step 6 需将相关 question 恢复——此时这些 question 的 question_status 在回退前可能为 pending，blocking_reason 不适用。vagueness 值预留给"执行中 detected vague 但未输出 digest 前崩溃"等边缘场景的 future-proofing）
  - `dependency`：autoresearch Step 5k failure propagation 判 critical dependency failed 时 → 写 `question_status[Qn]=blocked` + `blocking_reason[Qn]="dependency"` + `blocking_dependency[Qn]="[上游 Qd failed]"`
- **消费者**（谁读取）：
  - phase_rollback step 6：读 `blocking_reason[Qn]` 决定 blocked question 是否恢复为 pending（vagueness→pending，environment→保留，dependency→保留）
  - coordinator environment_blocked_ask_user digest（改动 17）：将 `blocking_dependency[Qn]` 自由文本展示给用户
  - failure propagation / early abort 判定：读 question_status=blocked 即跳过，不区分 blocking_reason（blocking_reason 只影响 rollback 行为，不影响 per-question loop 推进）

**Session Recovery**（edge-cases.md §Session Recovery 重构——current_retry_type 检查优先于 current_step 通用逻辑）：

判断顺序：

1. **读 `current_retry_type`**：
   - = "shallow" | "verification_shallow" → shallow retry 统一恢复分支（见下）
   - = "environment" → environment retry 恢复分支（见下）
   - = "normal"（或字段缺失，向后兼容）→ 走 step 2 current_step 通用逻辑
2. **current_step 通用逻辑**（current_retry_type=normal 时）：
   - = "execution" → Qn_REASONING.md + Qn_EXECUTION.md 存在且完整 → 构造 fallback digest，直接进入 verification dispatch（verification_retries 从 state.json 继续，不重置）；文件不存在 → re-dispatch local-executor (cycle=current_cycle)，重置 verification_retries 为 0
   - = "verification" → Qn_VERIFICATION.md 存在 → 构造 fallback verification digest，直接做 decision；不存在 → re-dispatch verification worker（verification_retries 继续，不重置）
   - question_status 有 blocked → continue next non-blocked question
   - question_status 有 pending → continue from that question

**shallow retry 统一恢复分支**（current_retry_type=shallow 或 verification_shallow——execution_shallow 与 verification_shallow 共享语义：retry 目的是修复浅薄产出，崩溃时磁盘上的文件是 retry 前的原始浅薄产出，不能直接进入下一步）：

shallow retry 共享恢复模式（差异用 [execution_shallow] / [verification_shallow] 标注）：

- 将现有产出文件视为浅薄产出——[execution_shallow: Qn_REASONING.md + Qn_EXECUTION.md, current_step="execution"；verification_shallow: Qn_VERIFICATION.md, current_step="verification"]——**不能**直接送入下一步
- 检查对应 retry 计数——[execution_shallow: execution_shallow_retries[Qn]；verification_shallow: verification_shallow_retries[Qn]]：
  - 若已达上限（=1）→ **降级**：
    - [execution_shallow] → consume cycle（increment current_cycle, reset execution_shallow_retries/environment_retries to 0, current_retry_type=normal）→ re-dispatch local-executor (cycle=new current_cycle)
    - [verification_shallow] → 视为 verification 失败：若 reasoning 子字段 FAIL → retry_execution（consume cycle）；若 reasoning 全 PASS 但 conclusion 证据不足 → retry_execution（method 可能 flawed）
  - 若未达上限 → 保持对应 retry 计数当前值（dispatch 已计入但未返回），重新构造对应 shallow_retry dispatch prompt，re-dispatch（不再次递增计数）
  - 若产出文件不存在 → shallow_retry dispatch 未产出，直接 re-dispatch 对应 shallow_retry（不递增计数）

**environment retry 恢复分支**（current_retry_type=environment，current_step="execution" 时）：

- environment_retry 前已执行 Step 4 环境自建，崩溃时自建可能完成也可能未完成（bash install 可能已执行但 ENVIRONMENT.md 尚未更新）
- **不依赖 ENVIRONMENT.md gaps 判断**——崩溃可能发生在 install 之后、ENVIRONMENT.md 更新之前。改为**重新执行 Step 3 环境 probe**（bash 探测原 gap 对应的工具/包是否可用），以 probe 实际结果为准：
  - probe 显示工具已可用（自建成功，即使 ENVIRONMENT.md 未更新）→ 更新 ENVIRONMENT.md（移除 gap），按 normal execution 恢复（产出文件存在→verification；不存在→re-dispatch normal, current_retry_type=normal, 不递增 environment_retries）
  - probe 显示工具仍不可用（自建未完成或失败）→ reclassify 为 user_decision_needed，mark question blocked，continue next question
- 若 environment_retries[Qn] 已达上限（=1）→ reclassify 为 user_decision_needed, mark blocked

current_retry_type 在恢复决策完成后、re-dispatch 前重置为对应类型（继续 shallow/env retry 则设为对应值，回退 normal 则设为 normal）。

> **shallow retry 与 environment retry 崩溃恢复的不对称（权威——有意为之）**：
>
> - **shallow retry 崩溃 → re-dispatch**：shallow_retry 修复的是"产出内容深度"——这个修复只能在 worker dispatch 内完成，没有独立于 dispatch 的可检查副作用。崩溃时磁盘上仍是原始浅薄产出，修复未发生，必须 re-dispatch。
> - **environment retry 崩溃 → re-probe（不 re-dispatch）**：environment_retry 的修复是 Step 4 的 bash install——这是独立于后续 executor dispatch 的**可验证副作用**。崩溃可能发生在 install 完成之后、ENVIRONMENT.md 更新之前（记录不可信，但 bash 现实是 ground truth）。所以先 re-probe 确认环境是否已修复：已修复 → 按 normal execution 恢复（环境已就绪 = 普通执行，不再是 environment_retry 语义）；未修复 → 不 re-dispatch（重跑 executor 只会再次遇到同一 gap），直接 reclassify 为 user_decision_needed。
>
> 一句话：**shallow_retry 修复"产出内容"（只能重做），environment_retry 修复"环境状态"（有可探测的 bash 副作用，先 probe 再决定）**。

> **注**：judgment-worker dispatch 的崩溃恢复不使用专门字段。judgment-worker 是无状态只读、re-dispatch 幂等的——崩溃恢复时若需重新判定深度，autoresearch 用行数预筛（bash `grep -cv`，始终可用，不依赖 judgment-worker）重建判定：行数 < 阈值 → 直接判 shallow 构造 retry prompt；行数 ≥ 阈值 → re-dispatch judgment-worker 重新判定。任务 d（claim_impossible_classification）**由 autoresearch dispatch**（见 §5.6 任务 d 崩溃恢复）。

---

## 4. 内容深度约束

本节是 Qn_REASONING.md / Qn_EXECUTION.md / Qn_VERIFICATION.md 深度要求的**设计权威定义处**。落地时 worker-prompts.md §MANDATORY CONTENT DEPTH REQUIREMENTS / §MANDATORY VERIFICATION DEPTH 承载**可操作的权威副本**（自包含，不再反向引用本设计文档），edge-cases.md §Execution-level Three-Stage Decision 用相对引用指向 worker-prompts.md。

### 4.1 Qn_REASONING.md 深度要求

- MUST contain a substantive derivation step for EACH method step in PLAN.md Execution Plan for Qn
- Each step MUST include：(1) Intention（what this step achieves per PLAN.md），(2) Method（the concrete computation/derivation/operation performed — NOT just "inspected" or "checked"），(3) Divergence（if method diverges from PLAN.md），(4) Assumption introduced（if any new assumption）
- The Method field in each step MUST describe a concrete operation that produces a new finding or result — "inspection" and "check" steps without producing new information are NOT sufficient
- **Substantive derivation may overturn PLAN.md method step's preset**：if execution reveals that a PLAN.md method step's approach is incorrect or suboptimal, the reasoning step MUST document this overturning explicitly — in Divergence field, declare what the original PLAN.md method intended, why it was overturned, and what the replacement approach is. This is NOT a shallow pattern — overturning with documented reasoning is substantive derivation
- If a step cannot be fully executed due to environment/dependency gaps → write partial execution results. Document：what was attempted, what partially succeeded, and the specific gap's impact on THIS step（NOT a blanket "environment gap" for all steps）
- NEVER collapse multiple incomplete steps into a single "environment gap" statement
- **Substantive derivation criteria**（for autoresearch shallow evaluation，三准则）：
  a. **Operational Specificity**：each step's Method field MUST describe a concrete, independently reproducible operation with identifiable input→output transformation（NOT just an action label like "performed dimensional analysis"）
  b. **Output Traceability**：each step MUST produce a traceable result in Qn_EXECUTION.md — numerical results, code outputs, computed data, or analytical conclusions with corresponding evidence
  c. **PLAN Correspondence**：each PLAN.md method step MUST have at least one reasoning step with substantive Method（NOT just a declaration "this step corresponds to PLAN method step N"）
- **MINIMUM length：100 lines**（excluding section headers — ## / ###）。Files under 100 lines will be classified as execution_shallow
- Line count counts substantive content lines only — blank lines and lines containing only section headers do NOT count toward the 100-line minimum. Padding with empty lines or repetitive headers is detectable

### 4.2 Qn_EXECUTION.md 深度要求 + Partial Execution

- MUST contain at least one concrete artifact per PLAN.md method step（numerical results, code output, computed values, analysis artifacts）
- If full execution is blocked → partial artifacts from executable sub-steps are still mandatory
- NEVER write only a "Status: FAILED" line without detailing：what was attempted, what partially succeeded, specific gap that blocked completion
- Include execution logs, command outputs, and computed data

**Qn_REASONING.md §Partial Execution 子节**（`## Dependency Usage` 之后新增）：

```markdown
## Partial Execution (if any step could not be fully executed)

If any step could not be fully executed due to environment/dependency gaps, this section MUST be present:

For each incomplete step:

- Step [N]: [what was attempted]
- Partial result: [what succeeded before the gap blocked further progress]
- Blocking gap: [specific gap description — NOT just "environment missing"]
- Gap impact on this step: [what this step would have produced if the gap were absent]
- Gap impact on downstream steps: [which subsequent steps are affected and how]
- Workaround attempted: [any alternative approach tried — even if it also failed]

NEVER write "No retry was attempted because the failures are structural/environmental" as a blanket dismissal — document each gap's impact on each affected step individually.
```

**local-executor Step 8.5 Partial Execution Documentation**（在 Step 8 和 Step 9 之间插入）：

```markdown
### Step 8.5: Partial Execution Documentation (if applicable)

If any acceptance test or execution step could not be completed:

1. For each incomplete test/step:
   - Document what was attempted (commands run, operations performed)
   - Document any partial output or intermediate results obtained
   - Document the specific gap that blocked completion (e.g., "wolframscript paclet FiniteFlow not available after autoresearch install attempt" — NOT just "tool missing")
   - Document what the test/step would have produced if the gap were absent
2. NEVER write only "Status: FAILED" without detailing partial achievements
3. NEVER write a single-sentence dismissal like "structural/environmental failures cannot be repaired"
4. Include ALL partial artifacts in EXECUTION.md, even if incomplete
5. Classify each gap's impact per-step (not globally)

This step ensures autoresearch (the parent agent) receives complete failure context for root-cause analysis. local-executor does NOT attempt to install missing system tools, Wolfram paclets, or venv packages — **all environment construction is autoresearch's responsibility** (D1).
```

### 4.3 Qn_VERIFICATION.md 深度要求 + verification_shallow_retry

**MANDATORY VERIFICATION DEPTH**：Qn_VERIFICATION.md MUST contain detailed evidence for each sub-field verdict, not just PASS/FAIL labels：

- **method_fidelity**：each reasoning step MUST be compared to PLAN.md method with explicit quote-and-compare. For each step："PLAN.md says [quote] → Qn_REASONING.md does [description] → match/divergence [reasoning]"
- **step_completeness**：every PLAN.md method step MUST be listed individually with found/not-found status and content summary. Format："Step [N] [PLAN method description]: FOUND (content: [1-line summary]) / NOT FOUND"
- **assumption_audit**：each assumption MUST be cross-referenced with framing_reasoning.md section number. Format："Assumption '[description]' → framing_reasoning.md §[section] line [N]: FOUND / NOT FOUND (undeclared)"
- **dependency_usage**：each dependency MUST be checked against resolved_conclusions scope with explicit scope comparison. Format："Dependency [Qd]: used as [how Qd was used] → Qd conclusion scope: [scope description] → within scope / overgeneralization [reason]"
- **conclusion verification**：verification evidence MUST match the claim type per the following hierarchy：

  | Claim Type              | Verification Requirement                                                                                                                                                          | "independently confirmed" Standard                                    |
  | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
  | Computational/numerical | MUST have computational evidence artifact (executed code, script output, numerical comparison) — LLM-only is NOT sufficient                                                       | Computational oracle required                                         |
  | Structural/algebraic    | SHOULD have computational evidence (SymPy/algebraic verification). If unavailable, MUST provide literature citation + derivation chain                                            | Computational oracle preferred; citation-backed derivation acceptable |
  | Conceptual/qualitative  | MUST provide literature citation for each key premise + logical reasoning chain connecting sub-components. Computational evidence for sub-components recommended but not required | Citation-backed reasoning required; computational evidence optional   |

  LLM-only reasoning WITHOUT any of the above (no computation, no citation, no reasoning chain) is NEVER sufficient for "independently confirmed" — regardless of claim type.

- **MINIMUM length：80 lines**（excluding digest YAML block）。Files under 80 lines are considered shallow verification
- Line count counts substantive evidence lines only — blank lines, section headers, and PASS/FAIL labels without supporting evidence do NOT count toward the 80-line minimum
- autoresearch 会检查上述深度要求是否满足，不满足的 verification 将被 re-dispatch（verification_shallow_retry）

**verification_shallow_retry 机制**（Step 5h0，在"Extract verification_digest YAML block → Apply decision table"之前插入，与 execution_shallow_retry 对称）：

1. **行数预筛**（cheap pre-filter，autoresearch 用 bash 获取 substantive 行数，不加载内容到 context）：

   ```bash
   grep -cvE '^\s*$|^\s*#' notepads/[slug]/execution/Qn_VERIFICATION.md
   ```

   - 若 substantive 行数 < 80 → verification_shallow（**fast path，跳过 judgment-worker**）：构造 generic verification_shallow_retry dispatch prompt "Your Qn_VERIFICATION.md has [N] substantive lines (minimum 80). Each verification sub-field requires concrete evidence quoting PLAN.md — not just PASS/FAIL labels." Re-dispatch verification worker（1 verification_shallow_retry，does NOT consume cycle/retries）
   - 若 substantive 行数 ≥ 80 → dispatch judgment-worker(verification-depth-judgment, 见 §5) 做深度 rubric 评估。judgment-worker 返回 deficient_fields + improvement_guidance → autoresearch 据此构造 targeted verification_shallow_retry dispatch prompt

2. verification_shallow_retry dispatch 前设置 current_step="verification", current_retry_type="verification_shallow"
3. 备份 Qn_VERIFICATION.md → Qn_VERIFICATION_shallow1.md
4. dispatch prompt 注入 "PREVIOUS VERIFICATION WAS SHALLOW" + 具体子字段缺陷列表
5. 仍 shallow after 1 retry → 视为 verification 失败：若 reasoning 子字段 FAIL → retry_execution（consume cycle）；若 reasoning 全 PASS 但 conclusion 证据不足 → retry_execution（method 可能 flawed）

**与 execution_shallow_retry 的对称性**：

| 维度                                      | execution_shallow_retry    | verification_shallow_retry                            |
| ----------------------------------------- | -------------------------- | ----------------------------------------------------- |
| 触发                                      | Qn_REASONING.md 浅薄       | Qn_VERIFICATION.md 浅薄                               |
| max per cycle                             | 1                          | 1                                                     |
| consume cycle                             | 否                         | 否                                                    |
| consume (execution/verification)\_retries | 否                         | 否（独立计数 verification_shallow_retries）           |
| 降级                                      | 仍 shallow → consume cycle | 仍 shallow → 视为 verification 失败 → retry_execution |
| reset                                     | cycle retry 或 resolved    | cycle retry 或 resolved                               |

---

## 5. judgment-worker

本节是 judgment-worker subagent 的**权威定义处**——先定义后引用。autoresearch Step 5e Stage 1 / 5h0 / 5m 以及 coordinator claim_impossible 路由均引用此处。

### 5.1 agent 定义

新增 `.aether/agent/judgment-worker.md`：

```yaml
---
description: Apply structured rubrics to research output files and return structured judgments
color: "#10B981"
mode: subagent
owner: research
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  research_state_get_state: allow
  research_state_get_progress: allow
  # 注：显式列举只读工具，不使用 research_state_* 通配符——
  # 通配符会授予 advance_plan / update_debate_state / update_audit_state 等写操作，
  # 违反"只读"约束。只读必须由权限系统精确强制，不依赖 LLM 自我约束
mcp:
  research-state: true
fallback_models:
  - alibaba-cn/glm-5.1
  - alibaba-cn/kimi-k2.6
output_dir: ".aether/research"
file_scope:
  - ".aether/research/**" # 读任何文件，不写（只返回结构化判定）
---
```

**核心约束**：

- judgment-worker **只读不写**——它返回结构化 YAML 判定作为最终消息，不写任何文件。权限系统显式授权 read/grep/glob/list + research-state 的只读工具（`get_state`/`get_progress`），**无 bash、无 write/edit、无 advance_plan/update_debate_state/update_audit_state 等写操作**
- delegation_depth=0（叶子节点，不 dispatch further subagents）
- 行数统计通过 Read 工具完成（Read 返回行号前缀），不使用 bash

### 5.2 四个判断任务模板

**a. shallow-judgment**（execution_shallow 判定，Step 5e Stage 1，autoresearch dispatch）：

```
task(
  description: "shallow judgment [Qn]",
  subagent_type: "judgment-worker",
  delegation_depth: 0,
  prompt: "Apply execution_shallow rubric to Qn_REASONING.md + Qn_EXECUTION.md.
  Read notepads/[slug]/execution/Qn_REASONING.md and Qn_EXECUTION.md.
  Read PLAN.md §Execution Plan for Qn's method.

  RUBRIC (apply each to every step in §Step-by-Step Derivation):
  - Operational Specificity: each step's Method must specify concrete input→output transformation, not just 'inspected'/'checked'/'applied criterion'
  - Output Traceability: each step must have traceable result in Qn_EXECUTION.md
  - PLAN Correspondence: every PLAN.md method step has a corresponding reasoning step

  RETURN (YAML as final message, no file writes):
    judgment_type: execution_shallow
    verdict: shallow | produced
    line_count: [substantive line count]
    deficient_steps:
      - step: [N]
        deficiency: [Operational Specificity | Output Traceability | PLAN Correspondence]
        detail: [具体缺什么]
    improvement_guidance: '[针对性改进指引 — 列出每步应包含什么，供 autoresearch 构造 shallow_retry dispatch prompt]'
  "
)
```

**b. verification-depth-judgment**（Step 5h0，autoresearch dispatch）：

```
task(
  description: "verification depth judgment [Qn]",
  subagent_type: "judgment-worker",
  delegation_depth: 0,
  prompt: "Apply verification depth rubric to Qn_VERIFICATION.md.
  Read notepads/[slug]/execution/Qn_VERIFICATION.md.
  Read PLAN.md §Claims for Qn's claims ONLY.

  RUBRIC (复用 execution_shallow 三准则哲学——每个子字段须有可追溯证据):
  - method_fidelity / step_completeness / assumption_audit / dependency_usage / fallback_applicability: 每子字段须有具体证据（引用 PLAN.md 原文 + 逐步对比），非仅 PASS/FAIL 标签
  - conclusion verification: 按 claim 类型分层要求（computational claim→computational oracle；conceptual/qualitative claim→citation-backed reasoning chain）

  RETURN (YAML, no file writes):
    judgment_type: verification_depth
    verdict: shallow | produced
    line_count: [substantive line count]
    deficient_fields:
      - field: [method_fidelity | step_completeness | assumption_audit | dependency_usage | fallback_applicability | conclusion]
        deficiency: [仅标签无证据 | 证据不足 | LLM-only 无计算/引用]
        detail: [具体缺什么]
    improvement_guidance: '[针对性改进指引，供 autoresearch 构造 verification_shallow_retry dispatch prompt]'
  "
)
```

**c. failure-synthesis**（Step 5m，autoresearch dispatch）：

```
task(
  description: "failure synthesis [Qn] cycle [N]",
  subagent_type: "judgment-worker",
  delegation_depth: 0,
  prompt: "Synthesize failure context from previous cycle backups.
  Read notepads/[slug]/execution/Qn_REASONING_cycle[N].md and Qn_VERIFICATION_cycle[N].md.
  Read PLAN.md §Execution Plan for Qn's method.

  TASK: 提炼失败上下文为 cycle revision context（结构化摘要），供 autoresearch 注入下一 cycle dispatch prompt。

  RETURN (YAML, no file writes):
    judgment_type: failure_synthesis
    cycle_revision_context: '[结构化失败摘要 — 什么失败、为什么、下轮应修正什么]'
    key_failures:
      - failure: [具体失败点]
        root_cause: [根因]
        revision_direction: [修正方向]
  "
)
```

**d. claim_impossible_classification**（**autoresearch dispatch** — claim_impossible 在 Stage 2 检测时，autoresearch 立即 dispatch judgment-worker 做分类，分类结果写入 paused digest。分类先于回退——确保 coordinator 做唯一一次回退到正确目标，见 §3.3）：

```
task(
  description: "claim_impossible classification [Qn]",
  subagent_type: "judgment-worker",
  delegation_depth: 0,
  prompt: "Classify claim_impossible level for question [Qn].

  Read executor evidence from Qn_REASONING.md + Qn_EXECUTION.md (current execution output).
  Read framing_reasoning.md for [Qn]'s Gap→Question→Claim derivation chain.
  Read PLAN.md §Claims + §Acceptance Tests for [Qn].
  Read research_questions.md for [Qn] definition.

  RUBRIC (determine which derivation layer the error belongs to):

  - L1 (Claim too strong): Question's framework is sound — the Gap→Question
    derivation is correct — but the specific Claim statement is overstrong or
    points to an unachievable target. A weakened/revised Claim would satisfy the
    Question while being achievable. Falsification test needs rewriting for the
    revised Claim.

  - L2 (Question misframed): The Gap→Question derivation introduced an
    impossible requirement. The Question's falsification framework itself is
    flawed — no reasonable Claim can satisfy it. Question must be redesigned
    while preserving mapping to the same Gap.

  - L3 (Gap error): The Gap itself does not exist or was misidentified in
    landscape analysis. The knowledge gap motivating this Question is not real.
    Requires re-derivation of the Gap in framing phase.

  RETURN (YAML, no file writes):
    judgment_type: claim_impossible_classification
    level: L1 | L2 | L3
    affected_gap_id: '[Gap identifier from framing_reasoning.md]'
    evidence_analysis: '[which derivation step is wrong and why — cite specific
      evidence from executor output + framing_reasoning.md]'
    claim_revision_direction: '[L1 only: how to weaken/revise the Claim to be
      achievable while preserving the Question]'
    question_redesign_direction: '[L2 only: how to redesign the Question while
      preserving Gap mapping]'
    gap_reexamination_reason: '[L3 only: why the Gap is wrong — what evidence
      shows it does not exist or was misidentified]'
    what_to_avoid: '[L3 only: specific error pattern to avoid in Gap
      re-derivation]'
  "
)
```

### 5.3 行数预筛的两阶段设计

行数阈值（Qn_REASONING.md 100 行 / Qn_VERIFICATION.md 80 行）在**两个阶段**发挥作用，兼顾成本与准确性：

| 阶段                     | 执行者          | 手段                                                                          | 行数未达标时                                                                           | 行数达标时                                                                                           |
| ------------------------ | --------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **预筛（cheap）**        | autoresearch    | bash `grep -cvE '^\s*$\|^\s*#'` 获取 substantive 行数（不加载内容到 context） | 直接判 shallow，构造 generic retry prompt（**跳过 judgment-worker dispatch**，省成本） | 进入第二阶段                                                                                         |
| **权威评估（accurate）** | judgment-worker | 读文件 + 应用三准则 rubric                                                    | 不适用（预筛已拦截）                                                                   | 判 produced/shallow，若 shallow 返回 deficient_steps + improvement_guidance（targeted retry prompt） |

**设计理由**：

- **预筛省成本**：对文档化的失败模式（如 28 行"两步模板"），行数预筛直接判定，省去 judgment-worker dispatch。autoresearch 用 bash `grep -cv` 获取行数，不加载文件内容到 context——零上下文膨胀
- **权威评估保准确性**：行数达标的文件可能含 padding（冗长但无实质的描述），judgment-worker 的三准则语义评估仍需执行。预筛的失效（padding 过线）不降低准确性，只降低效率
- **generic vs targeted retry prompt 的权衡**：预筛路径用 generic retry prompt（"每步需实质性推导"），judgment-worker 路径用 targeted retry prompt（列出具体 deficient steps）。generic prompt 对极端过短产出足够有效；对接近阈值的产出，judgment-worker 的 targeted 指引更精准

### 5.4 autoresearch dispatch 逻辑

| Step                                      | autoresearch 行为                                                                                                                                                                                                                                                                                             |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 5e Stage 1（execution_shallow 判定） | **行数预筛**（bash `grep -cv`，< 100 行直接判 shallow 跳过 judgment-worker）→ ≥ 100 行 dispatch judgment-worker(shallow-judgment) → 读结构化判定 → 若 shallow 用 improvement_guidance 构造 shallow_retry prompt                                                                                               |
| Step 5h0（verification 深度检查）         | **行数预筛**（bash `grep -cv`，< 80 行直接判 shallow 跳过 judgment-worker）→ ≥ 80 行 dispatch judgment-worker(verification-depth-judgment) → 读结构化判定 → 若 shallow 用 improvement_guidance 构造 verification_shallow_retry prompt                                                                         |
| Step 5m（failure synthesis）              | dispatch judgment-worker(failure-synthesis) → 读 cycle_revision_context → 注入下轮 dispatch prompt                                                                                                                                                                                                            |
| claim_impossible 分类（Stage 2 检测后）   | autoresearch 立即 dispatch judgment-worker(claim_impossible_classification) → 读 level + 修正方向 → **写入 paused digest**（不输出裸 digest）。coordinator 读 digest 中的 level 做唯一一次 rollback：L1/L2→debate（dispatch debate-repair，注入修正方向），L3→framing（dispatch re_derive_gap，见 §3.3/§6.7） |

**autoresearch 保留内联的判断**（不卸载）：

| 保留内联的判断                                                             | 理由                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **行数预筛**（bash `grep -cv`，dispatch judgment-worker 前执行）           | 廉价（不加载内容到 context），对极端过短产出省去 dispatch                 |
| 根因分类（Stage 2：environment_missing/plan_vague/crash/claim_impossible） | 从 digest 字段判断，轻量，不需读大文件                                    |
| 路由决策（resolved/retry/failed/paused）                                   | 从结构化判定结果做编排决策，是 autoresearch 核心职责                      |
| 状态管理（cycle/retries/state.json/current_retry_type）                    | autoresearch 独占                                                         |
| shallow_retry/verification_shallow_retry dispatch prompt 构造              | 用 judgment-worker 返回的 improvement_guidance（或预筛 generic 模板）填充 |

### 5.5 降级模式

- judgment-worker dispatch 失败（task 超时/空返回）→ 重试 max 2 次
- 3 次失败 → autoresearch 退回**内联判断**（降级模式，在 digest 标注 `judgment_worker_unavailable: true`）。此时 autoresearch 直接读文件 + 应用三准则 rubric
- 降级模式确保 judgment-worker 不可用时系统仍能运行（但 autoresearch 上下文可能膨胀，质量可能下降）
- 行数预筛（bash `grep -cv`）始终可用（不依赖 judgment-worker），但仅能拦截极端过短产出；行数达标的文件在降级模式下仍需 autoresearch 内联读内容评估

### 5.6 崩溃恢复

**任务 a/b/c 崩溃恢复**（autoresearch per-question loop 内）：judgment-worker 是无状态只读、re-dispatch 幂等的。崩溃恢复时 autoresearch 用行数预筛（bash `grep -cv`，始终可用）重建判定：行数 < 阈值 → 直接判 shallow 构造 retry prompt；行数 ≥ 阈值 → re-dispatch judgment-worker 重新判定。无需专门字段追踪 dispatch 上下文。

**任务 d 崩溃恢复**（autoresearch dispatch，claim_impossible_classification）：autoresearch 在 Stage 2 dispatch judgment-worker(task d) 后若崩溃，恢复时 autoresearch 用 stage 2 保留的 vagueness 判定（claim_impossible）重新 dispatch judgment-worker——judgment-worker 无状态只读、re-dispatch 幂等（PLAN.md 此时尚未被修改，重读产生相同分类）。恢复后 autoresearch 将 level 写入 paused digest 输出。无需 rollback_context / debate.current_sub_phase 推断（分类发生在 autoresearch 内部，回退尚未发生，无 debate 状态需推断）。

**与 current_retry_type 的关系**：current_retry_type 只管 local-executor/verification worker 的 dispatch 上下文，不管 judgment-worker dispatch（judgment-worker 在 worker 返回后 dispatch，此时 current_retry_type 已 reset）。autoresearch 据 judgment 判定决定 retry 后，才在重新 dispatch worker 前设 current_retry_type。

### 5.7 health check skill_chain 更新

server.py `_check_skill_chain`：

- 新增 judgment-worker agent 检查：验证 `.aether/agent/judgment-worker.md` 存在（检查 key `autoresearch_judgment_worker`，status pass/fail）。judgment-worker 是 subagent（经 `task(subagent_type: "judgment-worker")` 派发），非 skill ref，故不走 skill_refs_map——直接做 agent 文件存在性检查即可

---

## 6. framing re_derive_gap 模式（L3 依赖）

本节是 L3 回退时 framing skill 第二运行模式的**权威定义处**。L3 路由见 §3.3。

L3 回退重新 dispatch framing 时，coordinator 在 dispatch prompt 中注入 `mode=re_derive_gap` + `affected_gap_id` + rollback_context。framing worker 读到 mode 参数后走 `re_derive_gap` 分支——**不整文件覆盖**，而是基于现有三文件（framing_reasoning.md / research_questions.md / PLAN.md）做局部重推导 + 全局段重生成 + splice 写回。`re_derive_gap` 是 framing skill 的第二运行模式，与默认模式（从零整文件写）并存。

### 6.1 Lifecycle Contract 修改

- 新增 **Mode 参数**：`mode = full_derive（默认） | re_derive_gap`。re_derive_gap 模式额外要求 Input 含 `affected_gap_id` + `rollback_context`（coordinator 注入）
- Output 变化：默认模式写完整 4 文件；re_derive_gap 模式**splice 更新** 3 文件（framing_reasoning.md / research_questions.md / PLAN.md），STATE.md 更新由 coordinator 负责（framing 不写）
- State transition 变化：默认模式 `phase_framing → phase_audit_3`（framing 调 advance_plan）；re_derive_gap 模式 framing **不调 advance_plan**（coordinator 在 framing 返回后控制 phase 推进到 audit_3）

### 6.2 Step 1 — Read Current State 增加 base 读取分支

默认模式：读 ROADMAP.md / landscape_map.md / research_analysis.md / audits（全局输入）。

re_derive_gap 模式：除读 STATE.md 确认 phase + 读 rollback_context（affected_gap_id / evidence / what_to_avoid）外，**额外读三个 base 文件**：

1. `notepads/<slug>/framing_reasoning.md` — 识别 `## Gap → Question Mapping` 下 per-gap 段边界（`### Gap N` 开头到下一个 `### Gap` 或下一个 `## ` 结束）
2. `notepads/<slug>/research_questions.md` — 识别各 `## Question N` 段边界
3. `persistence/PLAN.md` — 识别 `### Claims` / `### Acceptance Tests` / `### Deliverables` / `### Execution Plan` / `### Environment Requirements` 各段及段内 bullet 边界

不全局重读 landscape_map——仅必要时局部重读受影响 Gap 相关的 landscape excerpt。

### 6.3 Step 2-5 — 局部重推导（仅受影响 Gap）

默认模式：对所有选中 Gap 执行 Step 2-5。

re_derive_gap 模式：**仅对 [affected_gap_id] 执行 Step 2-5**，重生成该 Gap 的 6 个子段（Significance Argument / Solution Paths Survey / Tractability Argument / Assumptions Introduced / Inter-Question Dependencies / Derived Question + Falsification）。输入：受影响 Gap 在 base 中的现有 framing 段 + rollback_context（evidence + what_to_avoid）+ 局部 landscape excerpt。其他 Gap 段**原样保留——不重读、不修改**。新 Question **沿用原 question ID**（受影响 Gap 原为 Q2 则重设计后仍是 Q2，不重新编号）。

### 6.4 Step 6-7 — 级联 staleness 标记 + 全局段重生成 + splice 写回 framing 输出

re_derive_gap 模式：

- **级联 staleness 标记**：若重设计后的 Question 改变了依赖边，对**直接下游** Gap 段（其 `#### Inter-Question Dependencies` 引用了受影响 Gap 的 question）加 staleness marker，插入到该下游 Gap 段标题之后：

  ```markdown
  ### Gap [downstream_id]: ...

  [downstream_recheck_needed: dependency on Gap [affected_gap_id] changed — Inter-Question Dependencies section may need re-validation. Original preserved for audit.]
  ```

  staleness marker 不删除原内容，仅提示 audit_3 优先审查。下游 Gap 的重新推导**不在本次 dispatch 内完成**——由 audit_3 决定是否需补 dispatch。

- **全局段重生成**：基于（重推导的受影响 Gap + 保留的其他 Gap）汇总，重生成 framing_reasoning.md 的三个全局段：
  - `## Priority Justification`（跨 Gap 比较矩阵——受影响 Gap 的 significance/tractability 可能变）
  - `## Dependency Graph`（含受影响 Gap 重设计 question 后的新边）
  - `## Execution Order`（Dependency Graph 的拓扑排序，可能改变 Wave 分配）
  - `## Source Knowledge Base` 与 `## Unresolved Knowledge Gaps` 不受影响，原样保留

- **splice 写回**（用 edit 工具，**非整文件 write**）：
  - framing_reasoning.md：替换受影响 Gap 段（`### Gap [affected_gap_id]` 整段）+ 三个全局段；其余 Gap 段 + Source Knowledge Base + Unresolved Knowledge Gaps 原样保留
  - research_questions.md：替换受影响 Gap 对应的 `## Question [Qn]` 段（沿用原 ID）

### 6.5 Step 8 — PLAN.md splice 写回

re_derive_gap 模式：用 edit 工具对 PLAN.md 做**精确替换**，**非整文件重写**（整文件重写会导致未受影响 Gap 的 claim 措辞漂移、question 编号重排，破坏 resolved_conclusions 的 question ID 映射）。替换内容：

- `### Claims` 段：受影响 Gap 对应的 claim bullet（用新版本替换，其他 claim 原样保留——通过 `question: [Qn]` 字段定位对应 bullet）
- `### Acceptance Tests` 段：对应的 test bullet（绑定到受影响 Gap 的 claim）
- `### Deliverables` 段：绑定到受影响 Gap claim 的 deliverable（若有）
- `### Execution Plan` 段：**重生成整个 Wave 结构**（基于 §6.4 的新 Dependency Graph 拓扑排序），替换整个 `### Execution Plan` 段。受影响 Gap 的 question 块（`**Qn: ...**`）用新 method/tools/falsification 替换；其他 question 块原样保留（沿用原 ID）
- `### Environment Requirements` 段：若受影响 Gap 的重设计引入新工具/依赖，增补对应 requirement bullet；否则原样保留
- 新 Question 沿用原 question ID，确保 PLAN.md 中 question→claim 映射与 resolved_conclusions 一致

### 6.6 Step 10-11 — State 更新跳过 + digest 扩展

re_derive_gap 模式：

- **Step 10 跳过 advance_plan**——framing 只更新 STATE.md 的 key decisions（记录"re_derive_gap for Gap [affected_gap_id]"），phase 推进由 coordinator 控制（framing 返回后 coordinator dispatch audit_3）
- **Step 9（Check Conventions）无需分支**——两种模式都执行
- **Step 11 输出 re_derive_gap digest**：

```yaml
phase_result_digest:
  phase: phase_framing
  sub_phase: re_derive_gap # 新增值，标识 re_derive_gap 模式（默认模式为 null）
  status: completed
  re_derive_details: # 仅 sub_phase=re_derive_gap 时非 null
    affected_gap_id: "[Gap id]"
    re_derived_questions: ["[Qn list — 沿用原 ID 的 question]"]
    downstream_staleness_marked: ["[Qn list — 加了 staleness marker 的下游 question]"]
    question_id_mapping_broken: false # true 仅当 question 数量变化导致 ID 映射破坏
    orphaned_questions: [] # question_id_mapping_broken=true 时，列出 orphaned 的原 question ID
  # ... 其余字段（research_questions/claims/...）同默认模式
```

coordinator 读取 framing digest：`question_id_mapping_broken=true` 时，将 `orphaned_questions` 对应的 `state.json.resolved_conclusions` 条目标记为 `orphaned`（保留供审计但不参与新 execution），并提示 audit_3 优先审查。正常情况（L3 是 Gap 误识别修正，question 结构通常变化不大）question ID 映射保持，resolved_conclusions 可继续参与 execution（已 resolved 的 skip）。

### 6.7 L3 回退的 coordinator 路由处理

autoresearch 在 paused digest 中携带 `level: L3` 时（分类由 autoresearch dispatch judgment-worker 完成，见 §3.3"分类先于回退"；digest schema 见改动 17），coordinator 据此做**唯一一次** phase_rollback 到 framing（不经 debate-repair）：

1. coordinator 调用 `phase_rollback(target_phase=phase_framing, target_plan_number=6, preserve_execution=true, rollback_reason=gap_reexamination, rollback_details={affected_gap_id, gap_reexamination_reason, what_to_avoid})`
   - rollback_details 中的 affected_gap_id / gap_reexamination_reason / what_to_avoid 均来自 digest（autoresearch 从 judgment-worker 返回值写入 digest）
   - `preserve_execution=true`：保留与错误 Gap 无关的 resolved questions
   - phase_rollback 重置运行时字段（cycle/retries/wave），保留 resolved_conclusions + question_status
2. **不执行 git checkout**——L3 是系统发起的回退。framing 重新运行以 section-preserving re-derivation 模式局部更新文件，而非整文件覆盖。rollback_context 天然存活于 state.json（不被 git checkout wipe）
3. 重新 dispatch framing worker（mode=re_derive_gap），dispatch prompt 注入 rollback_context：
   ```
   rollback_context indicates Gap [affected_gap_id] is fundamentally flawed.
   Gap reexamination reason: [digest 中的 gap_reexamination_reason]
   What to avoid: [digest 中的 what_to_avoid — 原推导路径的错误模式]
   Re-derive ONLY Gap [affected_gap_id] and its dependent questions (downstream questions whose dependencies reference [affected_gap_id]).
   Preserve framing of other Gaps — do NOT redo them.
   Mode: re_derive_gap — read existing framing_reasoning.md as base, re-derive affected sections, regenerate global sections (Priority Justification / Dependency Graph / Execution Order), splice-write back.
   ```
4. framing 重新运行后，正常进入 audit_3 → debate → execution 流程

---

## 7. 改动清单（按文件，纯 diff）

每个文件只放要替换/新增的文本块，机制说明引用 §3-6 不重述。

### 7.1 `.aether/skills/autoresearch/SKILL.md`

**改动 1：Step 3 第 5 点 Gap Check 重构**

当前文本：

> 5. **Gap check**: If critical gap exists → do NOT dispatch executor for affected tasks → mark in digest → coordinator reports to user

替换为：

> 5. **Gap classification + resolution attempt**: Classify each discovered gap per `references/worker-prompts.md` §Gap Classification（见 §3.2 表）. For each gap:
>    - `auto_installable` → proceed to Step 4 (environment self-build). Do NOT skip executor dispatch for questions affected by this gap — attempt resolution first
>    - `user_decision_needed` → mark questions affected by this gap as `blocked` in state.json.execution.question_status (blocking_dependency = gap description). Questions NOT affected by this gap continue execution normally. At execution end, include user_decision_needed gaps in final_execution_digest → coordinator informs user about environment requirements after execution completes
>    - `hard_blocked` → do NOT dispatch executor for affected questions. Other questions continue normally
>    - After classification → proceed to Step 4

**改动 2：新增 Step 4 环境自建**（原 Step 3 之后插入，原 Step 4→Step 5，原 Step 5→Step 6）

```markdown
### Step 4: Environment Self-Build (auto_installable gaps only)

For each gap classified as `auto_installable` in Step 3:

1. For each auto_installable gap, determine installation method:
   - Use web search (webfetch/websearch) to find the correct installation method for the missing software in the current environment
   - Do NOT rely on hardcoded installation commands — software versions and installation methods change over time. Always discover the correct method for the current environment via web search
   - Web search retry: if first search returns no useful results → retry with alternative search queries (up to 2 additional attempts with different keyword combinations, 3 total attempts). If all search attempts fail → reclassify this gap as `user_decision_needed` (skip installation attempt, mark affected questions as blocked)
   - If websearch/webfetch tool is unavailable or returns errors → reclassify this gap as `user_decision_needed` (skip installation attempt)
2. Execute installation via bash using the web-search-discovered method:
   - Python packages: install into .aether/research/.venv
   - Wolfram/Mathematica paclets: install via wolframscript
   - System tools: report as user_decision_needed (autoresearch MUST NOT run brew/apt/sudo without explicit user consent)
3. After each install attempt → re-probe to verify installation success
4. Update ENVIRONMENT.md:
   - If installed successfully → remove gap from gaps list, update host_system.tools or venv_state.installed_packages
   - If install failed → reclassify this gap as `user_decision_needed`. Mark questions affected by this gap as `blocked` in state.json.execution.question_status
5. Write updated ENVIRONMENT.md with final gap classification
```

**Step 编号顺延**：原 Step 4 (Per-Question Loop) → Step 5, 原 Step 5 (Final Output) → Step 6。

**改动 3：Step 5e 重构为三阶段判定**（原 Step 4e）

当前文本：

> After local-executor returns, apply decision table in `references/edge-cases.md` §Execution-level Failure Decision

替换为：

> #### e. Read execution results → Three-Stage Decision
>
> After local-executor returns, apply THREE-STAGE decision per `references/edge-cases.md` §Execution-level Three-Stage Decision（**权威定义见 §3.2**）. SKILL.md 只声明决策逻辑——Stage 1 Output Completeness Check / Stage 2 Root-Cause Analysis / Stage 3 Cycle Decision 的完整表、Retry Loop-back Procedure、Reset rules、Per-Question Flow 均在 §3.2。
>
> **行数预筛 + judgment-worker dispatch**：Stage 1 execution_shallow 判定走 §5.3 两阶段设计（行数预筛 fast path → judgment-worker(shallow-judgment) 权威评估）。

**改动 4：Step 5a question_status 检查新增分支**

```markdown
#### a. Check question_status

- "blocked" → skip
- "pending" → proceed
- "resolved" → skip (already completed)
- "failed" → skip (max retries exhausted)
- "skipped_vague" → skip (user chose to skip vague questions — distinct from blocked; no execution attempt)
```

**改动 5：Step 5b ENVIRONMENT.md re-read 明确**

```markdown
#### b. Prepare execution context (执行于每个 question 的每次 dispatch — 正常推进与 retry 均经过此步)

1. Read PLAN.md §Execution Plan → Qn's method, tools, falsification test, Dependencies
2. For each dependency Qd ...
3. **Re-read ENVIRONMENT.md**（每次 dispatch 前都 re-read——前一个 question 的 environment_retry 可能已更新 ENVIRONMENT.md，本 question 必须看到最新环境状态）。若 Qn 需额外软件 → autoresearch supplements bash probe 并增量写入 ENVIRONMENT.md
```

**改动 6：Step 5h0 verification 深度检查**（在"Extract verification_digest YAML block → Apply decision table"之前插入）

> #### h0. Verification depth check (before decision)
>
> 按 §4.3 verification_shallow_retry 机制执行。行数预筛（bash `grep -cv`，< 80 行直接判 shallow 跳过 judgment-worker）→ ≥ 80 行 dispatch judgment-worker(verification-depth-judgment, 见 §5) → 读结构化判定 → 若 shallow 用 improvement_guidance 构造 verification_shallow_retry prompt。

**改动 7：Step 5m failure synthesis**（插入位置：Step 5l "Backup before retry" 之后，cycle retry 最后一步，backup 完成、cycle 递增之后、dispatch 新 cycle 之前执行）

> 按 §3.2 Retry Loop-back Procedure step 6 执行：dispatch judgment-worker(failure-synthesis, 见 §5) → 读 cycle_revision_context → 注入下一 cycle dispatch prompt。

### 7.2 `.aether/skills/autoresearch/references/worker-prompts.md`

**改动 8：§Isolation Strategy Classification 表去严重度标签 + 新增 §Gap Classification 引用块**

§Isolation Strategy Classification 表的 gap 行**不再带 (critical)/(medium) 严重度标签**——统一为 `gap`，所有 gap 一律流入 §Gap Classification（**权威定义在 §3.2 表，worker-prompts.md 只放引用块 + action 摘要，不重复定义**）. worker-prompts.md §Gap Classification 只列三个 category 名 + 对应 action（proceed Step 4 / mark blocked / do NOT dispatch），完整定义（classification rules + hard_blocked 保守判定原则 + 终止路径判定）见 edge-cases.md.

worker-prompts.md 当前的内联 `**Gap check**: If critical gap exists → do NOT dispatch executor` 文本（§Environment Probe Commands 末尾）替换为引用——`**Gap classification**: Classify each discovered gap per §Gap Classification above, then proceed per SKILL.md Step 3 point 5`.

**改动 9：§Local-Executor Prompt Template 产出深度约束**（`MANDATORY: You MUST write TWO output files:` 之后新增）

见 §4.1 Qn_REASONING.md 深度要求 + §4.2 Qn_EXECUTION.md 深度要求。完整文本引用 §4.1/§4.2，worker-prompts.md 不重复。

**改动 10：§Qn_REASONING.md Structure 新增 §Partial Execution 子节**（`## Dependency Usage` 之后）

见 §4.2 §Partial Execution 子节。

**改动 11：§Verification Worker Prompt Template 深度约束**（`Decision rules:` 之后新增）

见 §4.3 MANDATORY VERIFICATION DEPTH。补充一句"autoresearch 会检查上述深度要求是否满足，不满足的 verification 将被 re-dispatch（verification_shallow_retry）"。

**改动 12：新增 §Judgment Worker Prompt Templates**

worker-prompts.md 新增 §Judgment Worker Prompt Templates，只放 **dispatch prompt 骨架**（`task(...)` wrapper + 指定 task type + 要读的文件），**不重复 rubric / YAML schema**——rubric 与 YAML 返回 schema 的权威定义在 `.aether/agent/judgment-worker.md` §Four Judgment Tasks（改动 7.7 落地）。judgment-worker 在 dispatch 时加载自身 agent 定义，dispatch prompt 只需指定 task a/b/c/d + 文件目标，无需内联 rubric. 四个 task type 的完整 rubric 见 §5.2.

**Step 编号全局更新**：worker-prompts.md 中所有对原 `Step 4` 的引用（`Step 4d`、`Step 4g`、`Step 4e` 等）→ `Step 5`（如 `Step 4d` → `Step 5d`）。所有对原 `Step 5` 的引用 → `Step 6`。实现后用 grep 交叉校验 `Step [45]` 引用，确保无悬空引用。

### 7.3 `.aether/skills/autoresearch/references/edge-cases.md`

**改动 13：重构 §Execution-level Failure Decision 为 §Execution-level Three-Stage Decision**

替换整个 §Execution-level Failure Decision 章节为 §3.2 的完整内容（Stage 1/2/3 表 + Retry Loop-back Procedure + Reset rules + Per-Question Worst-Case Dispatch Sequence + Gap Classification 表 + all hard_blocked 终止路径）。edge-cases.md 作为 SKILL.md 的引用目标，承载完整实现细节. **实现优化**：§3.2 中的 ASCII flow diagram（Per-Question Execution Retry Sequence Flow）在落地时省略——其内容已被 Stage 1/2/3 表 + Retry Loop-back Procedure 完整定义，ASCII 图仅为可视化冗余. 保留 worst-case 7-dispatch 编号序列作为具体 trace（验证 Stage 3 的 3+3+1=7 推导）.

**改动 14：Session Recovery 重构**

替换 §Session Recovery 为 §3.4 的完整内容（current_retry_type 优先检查 + shallow retry 统一恢复分支 + environment retry 恢复分支 + shallow/env 不对称说明 + current_step 通用逻辑）。

**改动 15：新增 state.json.execution 字段**

见 §3.4 新增字段（execution_shallow_retries / environment_retries / verification_shallow_retries / current_retry_type / **blocking_reason + blocking_dependency**）+ jq 操作。

**改动 16：§Safety Constraints 回退规则统一**

当前：

> "Rollback to earlier phase: execution sub-object is entirely cleared (question IDs may change), no interaction with audit sub-object"

替换为 §3.1 的统一回退规则（preserve_execution=false 清除 / preserve_execution=true 保留+重置运行时字段 / advance_plan 不做回退）。

### 7.4 `.aether/skills/autoresearch/references/digest-schemas.md`

**改动 17：扩展 paused digest 格式**

pause_reason 值域新增 `plan_vague_need_debate` + `environment_blocked_ask_user`（`state_update_failed` 为 pre-existing 值，edge-cases.md §state.json 写入失败恢复 已使用，此处一并显式纳入完整值域）：

```yaml
pause_reason: "[fallback_failed_ask_user / critical_dep_failed / max_retries_exhausted / plan_vague_need_debate / environment_blocked_ask_user / state_update_failed]"
```

**plan_vague_need_debate paused digest 格式**：

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: per_question_execution
  status: paused
  pause_reason: "plan_vague_need_debate"
  pause_details:
    vague_questions:
      - question: "[Qn]"
        vagueness_type: "[method_vague | claim_impossible]"
        vagueness_description: "[per-question 具体描述 — executor 试图执行时遇到什么困难]"
        method_reference: "[PLAN.md Execution Plan 中 Qn 的 method 描述原文]"
        # 以下字段仅 vagueness_type=claim_impossible 时存在（autoresearch dispatch judgment-worker 后写入）：
        claim_impossible_classification:
          level: "[L1 | L2 | L3]"
          affected_gap_id: "[Gap identifier from framing_reasoning.md]"
          evidence_analysis: "[which derivation step is wrong and why]"
          claim_revision_direction: "[L1 only]"
          question_redesign_direction: "[L2 only]"
          gap_reexamination_reason: "[L3 only]"
          what_to_avoid: "[L3 only]"
    suggestion: "Re-enter [target phase] to refine execution plan for [vague questions list]"
    execution_progress:
      resolved_questions: ["[list]"]
      failed_questions: ["[list]"]
      blocked_questions: ["[list]"]
      current_wave: [N]
      current_question: "[Qn where vagueness was detected]"
  user_options:
    # user_options 按 level 动态生成（coordinator 构造 question tool 时填入）：
    # method_vague / L1 / L2 → "Return to phase_debate to refine (Recommended)"
    # L3 → "Return to phase_framing to re-derive Gap [affected_gap_id] (Recommended)"
    - "[level-aware return to target phase]"
    - "Continue execution with current plan (skip vague questions)"
    - "Abort execution"
```

**environment_blocked_ask_user paused digest 格式**（存在 user_decision_needed blocked 的 question，且无 pending question 时输出——含纯 user_decision_needed 集合 或 hard_blocked + user_decision_needed 混合集。user_options 仅纳入 user_decision_needed 的 question；hard_blocked 的标注为不可解决，不纳入 user_options）：

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: per_question_execution
  status: paused
  pause_reason: "environment_blocked_ask_user"
  pause_details:
    missing_environment:
      - gap_description: "[具体缺失描述]"
        required_for_questions: ["[Qn list]"]
        install_hint: "[如果已知安装方法]"
    user_decision_needed_blocked_questions:
      - question: "[Qn]"
        blocking_dependency: "[gap description — user_decision_needed]"
    hard_blocked_questions:
      - question: "[Qn]"
        blocking_dependency: "[gap description — 架构/OS/硬件客观不匹配，不可解决]"
    resolved_questions: ["[list]"]
    execution_progress:
      current_wave: [N]
      current_question: "[Qn where block was detected]"
  user_options:
    - "I have installed the missing software — continue execution"
    - "Accept partial results (cannot install missing software)"
    - "Abort execution"
```

**改动 18：final_execution_digest + persistence 汇总新增 skipped_vague 处理**（与 failed / blocked 平行）：

final_execution_digest 新增 section：

```yaml
skipped_vague_questions:
  - question: "[Qn]"
    vagueness_description: "[from paused digest pause_details]"
    method_reference: "[PLAN.md method 原文]"
```

persistence/EXECUTION.md 新增表（与 Blocked Questions 表平行）：

```markdown
## Skipped Questions (Plan Vague)

| Question | Vagueness Description   | Method Reference   |
| -------- | ----------------------- | ------------------ |
| Q3       | [vagueness_description] | [method_reference] |
```

persistence/VERIFICATION.md 同理新增 "Skipped (Plan Vague)" 表（与 Blocked Questions 表平行）：

```markdown
## Skipped Questions (Plan Vague)

| Question | Note                                                  |
| -------- | ----------------------------------------------------- |
| Q3       | Not verified (PLAN.md method too vague for execution) |
```

**改动 19：debate-repair repair digest 新增 execution_refine_details 字段**：

```yaml
execution_refine_details:
  vagueness_type: method_vague | claim_impossible
  claim_impossible_handling: null  # 仅 vagueness_type=claim_impossible 时非 null
  claim_impossible_handling:
    level: L1 | L2  # L3 不出现——L3 不经 debate-repair
    affected_gap_id: "[Gap id, L2 必填]"
    classification_source: "judgment-worker"
    action_taken: "[L1: claim revised per claim_revision_direction to ... / L2: question re-derived per question_redesign_direction, falsification redesigned]"
```

### 7.5 `.aether/agent/local-executor.md`

**改动 20：环境职责全面剥离 + 失败报告升级 + Partial Execution Documentation**

local-executor 全面剥离环境构建职责（D1 + A1 + A2），并升级失败报告质量（B1）。四处修改：

**改动 20a：Step 3 Setup Environment 重构**（A2 — 剥离 venv 创建 + 包安装）

当前 Step 3 "For uv_venv strategy" 执行 venv 创建（`uv venv`）和包安装（`uv pip install`）。改为：

```markdown
**For uv_venv strategy:**

1. Check if `.aether/research/.venv` exists and ENVIRONMENT.md venv_state.installed_packages covers required dependencies
2. If venv exists and packages match → reuse (skip install)
3. If venv missing OR required packages absent → **do NOT create venv, do NOT install packages**. Report the specific missing item(s) to autoresearch via task_result (digest + Step 8.5 partial documentation). Fail this dispatch with full error context — autoresearch will self-build environment (Step 4) and re-dispatch via environment_retry (见 §3.2 Stage 2)
4. Verify setup: `.aether/research/.venv/bin/python --version` and import check (only when venv is confirmed ready per ENVIRONMENT.md)
```

"For local strategy" / "For local_compile strategy" 不变（仅验证工具可用性，不安装）——但工具/paclet 不可用时同样**报告给 autoresearch 而非自行安装**（与 D1 一致）。

**改动 20b：Step 5 Handle Errors 升级**（B1）

当前 Step 5："Persistent errors: report failure with error message"。改为：

```markdown
### Step 5: Handle Errors

- Transient errors (network timeout, file lock): retry once
- Persistent errors: report failure WITH full error context — affected steps, commands attempted, exact error output, and what was partially completed. NEVER report a bare "Status: FAILED" — autoresearch needs root-cause context (feeds §3.2 Stage 2 Root-Cause Analysis). Partial achievements MUST be documented (feeds Step 8.5)
```

**改动 20c：Step 6 Update ENVIRONMENT.md 重构**（A1 — 不写 persistence/ 共享文件）

当前 Step 6 直接写 `.aether/research/persistence/ENVIRONMENT.md` 的 venv_state。改为：

```markdown
### Step 6: Report Environment State (do NOT write ENVIRONMENT.md)

local-executor does NOT modify persistence/ shared files (ENVIRONMENT.md) — 所有 ENVIRONMENT.md 写入由 autoresearch 统一负责（D1）。若执行引入新的环境状态变化（如脚本动态加载了依赖、产生了中间产物），通过 task_result digest 的 `environment_changes` 字段报告给 autoresearch，由 autoresearch 增量写入 ENVIRONMENT.md。
```

**改动 20d：新增 Step 8.5 Partial Execution Documentation**

见 §4.2 local-executor Step 8.5。

### 7.6 `.aether/skills/research-coordinator/references/phase-routing.md`（coordinator 路由）

> coordinator agent `.aether/agent/research.md` 通过 `/research-coordinator` skill 加载本 reference；改动 21-24 的路由表与处理流程落地于此文件（`research.md` 本身不直接承载路由逻辑，故无需改动）。

**改动 21：Status routing 表扩展**

当前：
| Digest status | Coordinator action |
|---|---|
| completed | advance_plan(completed) |
| partial | advance_plan(completed) |
| paused | 请求用户决策 → re-dispatch autoresearch |

扩展为：

| Digest status | pause_reason                                                       | Coordinator action                                                                                                                                      |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| completed     | N/A                                                                | advance_plan(completed) → present results                                                                                                               |
| partial       | N/A                                                                | advance_plan(completed) → present partial results                                                                                                       |
| paused        | fallback_failed / critical_dep / max_retries / state_update_failed | 请求用户决策 → re-dispatch autoresearch (现有机制不变——state_update_failed 为 jq 写失败，coordinator re-dispatch autoresearch 重试)                     |
| paused        | plan_vague_need_debate                                             | **新增路由** → 请求用户确认回退 debate → phase_rollback(phase_debate, preserve_execution=true)（见 §3.1）                                               |
| paused        | environment_blocked_ask_user                                       | **新增路由** → 请求用户操作 → 按改动 24 的 3 选项路由（installed→re-dispatch / accept partial→advance_plan(completed) / abort→advance_plan(completed)） |

**跨阶段回退守卫**：任何路由在调用 phase_rollback 前无需自行检查计数器——phase_rollback 内部（§3.1 step 4）在递增后若达上限 3，直接返回 `terminated`。coordinator 收到此返回值后执行**终止流程**（见 §3.1 末尾）。

**改动 22：plan_vague_need_debate 处理流程**

1. Append paused digest to DIGESTS.md (1 entry)
2. Use question tool to present vagueness information and options:

   ```
   PLAN.md execution plan for [vague questions] is too vague for the executor to determine concrete steps.

   Details:
   - [Q1]: [vagueness_description from digest]
     PLAN.md method: "[method_reference from digest]"

   Already resolved questions: [list] — their results will be preserved.

   Options:
   1. Return to phase_debate to refine the execution plan (Recommended)
   2. Continue execution with current plan (skip vague questions, accept partial results)
   3. Abort execution
   ```

3. After user decision:
   - **Option 1 (return to [target phase])** — target phase 由 digest 中的 vagueness_type + claim_impossible_classification.level 决定：
     - **vagueness_type=method_vague** → target=phase_debate（无 classification 字段）：
       1. Preserve DEBATE.md (new round content appends after existing)
       2. Do NOT rollback PLAN.md (debate-repair based on current PLAN.md)
       3. Preserve execution results for resolved questions
       4. Preserve ENVIRONMENT.md
       5. Call phase_rollback(target_phase=phase_debate, target_plan_number=8, preserve_execution=true) via research-state MCP
       6. Update STATE.md: phase=phase_debate, Blockers section append vagueness_details
       7. Git commit: `git add .aether/research/ && git commit -m "research: execution rollback to phase_debate (plan vague — [questions])"`
       8. Dispatch debate round directly (inject vagueness_details as additional constraint, prompt template 见改动 23)
     - **vagueness_type=claim_impossible, level=L1 or L2** → target=phase_debate（classification 已由 autoresearch dispatch judgment-worker 完成，level + 修正方向在 digest 中）：
       1-7. 同 method_vague（preserve DEBATE.md / PLAN.md / execution results / ENVIRONMENT.md → phase_rollback(phase_debate) → STATE.md → git commit）8. Dispatch debate-repair（**L1→Local repair, L2→Structural repair**），注入 digest 中的 `claim_revision_direction`（L1）或 `question_redesign_direction` + `affected_gap_id`（L2）。见 §7.8 debate-repair execution-refine
     - **vagueness_type=claim_impossible, level=L3** → target=phase_framing（classification 已由 autoresearch dispatch judgment-worker 完成）：
       1. Preserve execution results for resolved questions
       2. Preserve ENVIRONMENT.md
       3. Call phase_rollback(target_phase=phase_framing, target_plan_number=6, preserve_execution=true, rollback_reason=gap_reexamination, rollback_details={affected_gap_id, gap_reexamination_reason, what_to_avoid from digest}) via research-state MCP
       4. Update STATE.md: phase=phase_framing, Blockers section append gap_reexamination_reason
       5. Git commit: `git add .aether/research/ && git commit -m "research: execution rollback to phase_framing (gap reexamination — Gap [affected_gap_id])"`
       6. Dispatch framing worker（mode=re_derive_gap，见 §6.7 step 3 dispatch prompt）
          > **关键**：coordinator 不再 dispatch judgment-worker——分类已由 autoresearch 完成（digest 携带 level）。coordinator 据 digest.level 做唯一一次 phase_rollback 到正确目标，消除双回退。

   - **Option 2 (skip vague questions)** → re-dispatch autoresearch with user decision to skip:
     Inject user decision "Skip [vague questions], accept partial results" into re-dispatch prompt. autoresearch marks vague questions as `skipped_vague` in state.json.execution.question_status. Skipped_vague questions treated like blocked for execution continuation, but distinguished in final_execution_digest 和 persistence 汇总文件（见改动 18）。

   - **Option 3 (abort)** → advance_plan(phase=completed) with partial results.

**改动 23：method_vague debate dispatch prompt**

```
task(
  description: "phase_debate round [N] (execution rollback — plan vague)",
  subagent_type: "research-worker",
  prompt: "Execute debate sub-phase [sub_phase] of round [N] of phase_debate.

EXECUTION ROLLBACK CONSTRAINT: During phase_execution, autoresearch detected that PLAN.md method descriptions for questions [vague_questions] were too vague for the executor to determine concrete steps. The execution has been rolled back to phase_debate to refine these methods.

Vagueness details:
- [Q1]: [vagueness_description]
  PLAN.md method: "[method_reference]"
  Executor difficulty: [what the executor tried and why it couldn't proceed]

Already resolved questions: [resolved_questions list] — their claims and methods MUST NOT be modified in this debate round.

DEBATE FOCUS: The primary focus of this round is to refine the Execution Plan for [vague_questions] — expand vague method descriptions into concrete, executable steps with specific tools, commands, and expected outputs. Also ensure Environment Requirements cover the refined methods.

Invoke /[debate_skill] skill. Follow all steps in SKILL.md."
)
```

**改动 24：environment_blocked_ask_user 路由处理**

1. Append paused digest to DIGESTS.md (1 entry)
2. Use question tool to present environment block information and options
3. After user decision:
   - **Option 1 (installed, continue)** → re-dispatch autoresearch: prompt 注入 "User has installed missing software — re-probe environment and continue execution from Step 1"。autoresearch 从 Step 1 重新开始（重新探测环境，重新确定 Waves），已 resolved questions 的结果从 state.json.resolved_conclusions 中读取（保留）
   - **Option 2 (accept partial results)** → advance_plan(completed): present partial results
   - **Option 3 (abort)** → advance_plan(completed): 同 Option 2，但额外标注 abort 原因

### 7.7 `.aether/agent/judgment-worker.md`（新增）

见 §5.1 agent 定义 + §5.2 四个判断任务模板。

### 7.8 `.aether/skills/debate-repair/SKILL.md`

**改动 25：Step 2 §Assess Repair Scope & Impact severity 表新增 Execution-refine 类型**

| Severity             | Criteria                                                                                                                                                                                                                                                                                                                                                                                                                                   | Repair Scope                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Execution-refine** | Problem originates from phase_execution rollback. vagueness_type 决定修复策略：method_vague → debate-repair 直接展开 vague method 为具体执行步骤；claim_impossible → digest 已携带 level（**autoresearch dispatch judgment-worker 完成**，见 §5 任务 d），coordinator 据 level 路由 L1→debate-repair Local repair / L2→debate-repair Structural repair / L3→direct rollback to framing（§3.3）。**L3 does NOT pass through debate-repair** | method_vague: Expand vague method into concrete step-by-step execution instructions. claim_impossible L1: revise claim per digest's claim_impossible_classification.claim_revision_direction (keep Question). claim_impossible L2: redesign Question per digest's claim_impossible_classification.question_redesign_direction (keep Gap mapping). Add corresponding concrete Acceptance Tests. Ensure Environment Requirements cover the refined method. Do NOT modify resolved questions' claims |

**改动 26：Step 3 新增 execution-refine repair pattern**（在 Structural repair patterns 之后）

7. **Execution plan refinement** (for plan_vague_need_debate from execution rollback):
   - method_vague: Expand vague method descriptions into concrete, executable step-by-step instructions. For each vague method step:
     - Specify exact tool/command to use
     - Specify concrete input parameters and expected output format
     - Specify intermediate verification checkpoints
     - Ensure each step has a corresponding concrete Acceptance Test
     - Ensure Environment Requirements section lists all software needed
     - Add fallback methods for steps that may encounter environment gaps
     - Do NOT modify claims or falsification criteria of already resolved questions
   - claim_impossible L1: 按 digest 中 `claim_impossible_classification.claim_revision_direction` 修订 claim 为可达版本（保留 Question），重写对应 falsification test
   - claim_impossible L2: 按 digest 中 `claim_impossible_classification.question_redesign_direction` 重设计 Question（新 falsification + method），保留对同一 Gap 的映射，framing_reasoning.md 加 staleness marker（见 §3.3 L2 边界处理）

**改动 27：Integrity Rules 新增 execution-refine 约束**

- **Do NOT modify claims or falsification criteria of resolved questions**
- **Vagueness details from execution are binding constraints** — debate-repair MUST address each reported difficulty point
- **Resolved question execution results are preserved** — debate-repair MUST NOT request deletion of Qn_REASONING.md/Qn_EXECUTION.md/Qn_VERIFICATION.md for resolved questions
- **Refined method MUST be self-contained** — each method step MUST include enough detail for a local-executor to execute without needing to interpret vague instructions
- **claim_impossible 禁止删除 claim**——必须保留 Question 与 Gap 映射。L1/L2/L3 分类由 judgment-worker 负责（§5 任务 d，**autoresearch dispatch**），分类结果经 digest 传递；debate-repair 仅处理 L1/L2
- **L3 不由 debate-repair 处理**——digest 中 level=L3 时 coordinator 直接路由 framing，debate-repair 不参与

**改动 28：Step 4 Consistency Verification 新增 execution-refine 检查项**

1. Refined method steps have corresponding concrete Acceptance Tests
2. Refined method steps are executable with declared Environment Requirements
3. Refined method does not contradict claims or falsification criteria of UPHELD or resolved questions
4. Each refined step has a specific tool/command that exists in ENVIRONMENT.md or is installable
5. Resolved questions' execution results are still consistent with the refined PLAN.md

### 7.9 `.aether/skills/research-question-framing/SKILL.md`

**改动 29：新增 re_derive_gap 第二运行模式**

完整 6 处修改见 §6.1-§6.6. **实现优化**：re_derive_gap 的 per-step delta 从 SKILL.md 主流程中分离到 `references/re_derive_gap.md`——re_derive_gap 仅在 L3 回退时触发（非正常流程），interleaved delta 会使默认 full_derive 流程的读者每个 Step 都要跳过 re_derive_gap 分支. SKILL.md Lifecycle Contract 保留 mode parameter 声明 + 指向 reference 的指针；reference 文件以 "Step Deltas" 结构描述各 Step 的 delta（不重复默认步骤结构）.

### 7.10 `.aether/mcp/research-state/server.py`

**改动 30：新增 phase_rollback MCP tool**

完整实现见 §3.1（参数 / step1-11 / 守卫 / 原子性 / rollback_plans entry schema）。

**改动 31：`_default_state()` 同步新字段**

```python
def _default_state() -> dict:
    return {
        "phase": "gate",
        "plan_number": "0",
        "conventions": {},
        "project_contract": {},
        "progress": {"completed_plans": [], "total_plans": 0, "rollback_plans": []},
        "phase_commits": {},
        "execution_cycle": 0,
        "rollback_context": None,
        "cross_phase_rollback_count": 0,
        "audit": {...},
    }
```

**`_read_state_safe()` 嵌套字段补全**（必须显式处理——现有顶层 key 合并只对顶层 key 做 `if key not in state` 补全，progress 嵌套字段不会被补全）：

```python
# 嵌套字段补全（progress.rollback_plans）
defaults = _default_state()
if isinstance(state.get("progress"), dict):
    prog_defaults = defaults["progress"]
    for key in prog_defaults:
        if key not in state["progress"]:
            state["progress"][key] = prog_defaults[key]
elif "progress" not in state:
    state["progress"] = defaults["progress"]
# 顶层新字段（rollback_context、cross_phase_rollback_count）已被顶层合并覆盖
```

phase_rollback 写 rollback_plans 时用 `state["progress"].setdefault("rollback_plans", []).append(entry)`（兜底）。

**改动 32：PERSISTENCE_WHITELIST 更新**

```python
PERSISTENCE_WHITELIST = {
     "STATE.md", "ROADMAP.md", "PLAN.md", "DIGESTS.md", "state.json",
     "EXECUTION.md", "VERIFICATION.md", "ENVIRONMENT.md", "DEBATE.md",
     "WORKFLOW_TERMINATION_REPORT.md",  # 新增（跨阶段回退终止报告）
}
```

**改动 33：health check phase_rollback 兼容性**

advance_plan 往返保留（测试 state.json 写路径，注释标注 health check exemption）；phase_rollback 仅做注册检查（registration_check_only，不实际调用，避免审计污染）：

```python
# phase_rollback registration check (no round-trip — avoids rollback_plans pollution)
rollback_tool = mcp._tool_manager._tools.get("phase_rollback")
if rollback_tool and rollback_tool.parameters:
    checks["phase_rollback_registration"] = {"status": "pass", "method": "registration_check_only"}
else:
    checks["phase_rollback_registration"] = {"status": "fail", "failure_class": "tool_not_registered"}
    issues.append("phase_rollback tool not registered")
```

health check skill_chain 新增 judgment-worker agent 检查（§5.7）。

### 7.11 `.aether/skills/research-coordinator/references/phase-routing.md` + `phase-detail-tables.md`

**改动 34：phase_checkpoint rollback git checkout 排除协议**

见 §3.1 checkpoint 回退的 git checkout 排除协议。phase-routing.md §phase_checkpoint rollback + phase-detail-tables.md §Git Rollback Protocol 标准回退步骤加排除 state.json。

### 7.12 `.aether/skills/research-coordinator/scripts/backup_repair.sh`（新增）

**改动 35：repair 前备份脚本（DRY 重构）**

把原先散落于 phase-detail-tables.md 的三处 repair 备份文件列表（§Audit-Repair Phase-Specific Differences / §Repair Pre-backup File Lists / §Debate Repair Pre-backup）抽成单一脚本，作为各 phase repair 目标文件的**single source of truth**，消除三处列表的重复与漂移风险。

**脚本职责**：

- 用法：`bash backup_repair.sh <phase> <round>`，phase ∈ {`audit_1`, `audit_2`, `audit_3`, `debate`}，round 为 repair 轮次（1, 2, 3...）
- 按 phase 的 case 分支（hardcoded 文件列表——单一权威），对每个目标文件执行 `cp` 到 `.pre_audit_repair_round<N>`（audit）或 `.pre_repair_round<N>`（debate）后缀；源文件不存在则跳过
- 各 phase 备份目标（仅备份该 phase repair 可能修改的 repair target 文件——与对应 repair dispatch prompt 的 `Files:` 行一致）：
  - `audit_1`：`ROADMAP.md` + `research_analysis.md`
  - `audit_2`：`audit_1` 列表 + `landscape_map.md`
  - `audit_3`：`framing_reasoning.md` + `PLAN.md` + `research_questions.md` + `ROADMAP.md` + `landscape_map.md`（不含 `research_analysis.md`——audit_3 的 repair 不修改 research_analysis.md，见 phase-detail-tables.md §Dispatch Prompts audit_3 repair prompt 的 `Files:` 行）
  - `debate`：`PLAN.md`
- `set -euo pipefail` 严格模式；slug 目录取 `.aether/research/notepads/` 下首个 `*/`

**被引用处**（落地文件）：

- `research-coordinator/SKILL.md`：dispatch repair worker 前调用（audit 阶段 §4a + debate 阶段 §4b），标注 "file lists are hardcoded in the script — single source of truth"
- `research-coordinator/references/session-recovery.md` §Repair Crash Recovery：crash 恢复时检查 `.pre_*_round[N]` 备份是否存在（由本脚本创建）

**与改动清单的关系**：本脚本取代了原 phase-detail-tables.md 中被删除的三处内联备份列表（实现优化：列表单一化、脚本化，避免文档与实现漂移）。phase-detail-tables.md 中 `§Audit-Repair` 节已移除，per-phase repair 参数现承载于 §Dispatch Prompts（每个 repair dispatch prompt 的 `Files:` 行）+ 本脚本。

---

## 8. 实施顺序

**单一实施单元**：改动 1-35 一并落地。不分子批次迭代——第一批/第二批/第三批的文件高度重叠（edge-cases.md / SKILL.md / worker-prompts.md / debate-repair / framing），分批迭代会导致这些文件被反复重写，产生跨批次不一致。

**同批次强制依赖**（以下改动存在强耦合，不可拆分落地）：

- **phase_rollback 生态**（不可分离）：改动 30（phase_rollback MCP）+ 跨阶段回退守卫（§3.1 step 4：`cross_phase_rollback_count` + 终止流程 + `WORKFLOW_TERMINATION_REPORT.md`）+ 改动 31（`_default_state` 同步 `rollback_plans` / `rollback_context` / `cross_phase_rollback_count`）+ 改动 33（health check 兼容性）。守卫是 phase_rollback 内置逻辑，分离则守卫失效。
- **coordinator 路由依赖 phase_rollback**：改动 21/22（coordinator plan_vague / claim_impossible 路由）调用 `phase_rollback`，必须在改动 30 之后或同批落地。
- **L3 完整链路**（不可分离）：改动 29（framing `re_derive_gap` 模式）依赖改动 30（`phase_rollback` 接受 `phase_framing` target）+ §5 任务 d（judgment-worker `claim_impossible_classification`，由 autoresearch dispatch）+ §6（framing `re_derive_gap` 完整定义）。改动 22（coordinator claim_impossible 分支）依赖 §5 任务 d 返回的 level 做路由——三者须同批。

落地时按 §7 改动清单的文件顺序逐文件修改即可，无需规划子批次。

---

## 9. 验收清单（按机制分组，引用 §3-6）

### 9.1 Gap 分类 + 环境自建（§3.2）

1. autoresearch Step 3 Gap Check 不再直接阻断 executor dispatch——`auto_installable` gap 先尝试自建
2. autoresearch Step 4 环境自建使用 web search 搜索安装方法（最多 3 次搜索尝试），搜索失败时 reclassify 为 user_decision_needed，不依赖硬编码命令
3. autoresearch Step 4 安装失败时将受影响 question 标记为 blocked，coordinator 在 execution 结束后告知用户
4. §Isolation Strategy Classification 表的 gap 行不再带 (critical)/(medium) 严重度标签——统一为 `gap`，所有 gap 一律流入 §Gap Classification（§3.2 表，单一权威）
5. **gap classification 由 autoresearch 在 Step 3 自行做**（规则匹配 + bash probe），不 dispatch judgment-worker（gap classification 非语义判断，judgment-worker 无 bash 权限无法探测）
   5a. **hard_blocked 保守判定**：仅在 bash probe 能客观确认（架构/OS/硬件事实）时判 hard_blocked；无法客观确认 → 降级为 user_decision_needed。运行时 OOM/超时走 Stage 2 crash/timeout 路径（consumes cycle），不判 hard_blocked
   5b. **终止路径分支**：全 hard_blocked（无 pending）→ early abort → final_execution_digest status=partial；存在 user_decision_needed blocked（含混合集）→ paused digest（environment_blocked_ask_user），user_options 仅纳入 user_decision_needed 的 question

### 9.2 三阶段判定 + retry 计数（§3.2 / §3.4）

6. autoresearch Step 5e 三阶段判定：shallow/environment/verification_shallow retry 不消耗 cycle，各 max 1 per cycle（cycle retry 时 reset）
7. shallow_retry dispatch prompt 由 autoresearch 用 judgment-worker 返回的 improvement_guidance 构造（targeted），或预筛 generic 模板
8. state.json.execution 新增 execution_shallow_retries / environment_retries / verification_shallow_retries 计数器
9. current_retry_type 值域 `normal|shallow|environment|verification_shallow`，dispatch 前写入、返回后重置为 normal
10. Session Recovery 读取 current_retry_type：shallow/verification_shallow retry 统一恢复分支，environment retry 独立分支——崩溃时不直接送 verification 或做 decision（§3.4）
11. environment_retry 崩溃恢复时重新执行 Step 3 环境 probe（bash 探测）判断自建是否完成，不依赖 ENVIRONMENT.md gaps
12. worst-case 流程图与"7"推导一致：3(cycle1) + 3(cycle2) + 1(cycle3) = 7 local-executor dispatches；verification dispatch 另计（最多 6）
    12a. crash/timeout 路径的 cycle accounting：simplified-task 与 full-task **共享同一 cycle**（不独占 cycle，一次 crash 烧 1 个 cycle 而非 2 个）；retry-type dispatch 的 crash 走 Stage 2 crash/timeout 路径（consumes cycle），与 normal dispatch crash 同等对待
13. Step 5b 每次 dispatch（正常推进与 retry）前 re-read ENVIRONMENT.md
    13a. cycle ≥2 的 dispatch prompt MUST 包含 simplified scope hint（源自 failure-synthesis 的 revision_direction）；failure-synthesis 无明确方向时 autoresearch 自主简化 scope——不得以相同 scope 重试上一 cycle 失败
    13b. 自主简化时 MUST 在 dispatch prompt 内显式记录决策依据三要素（简化了什么 / 为什么 / 预期影响），供 verification 和 audit 判断结论覆盖范围

### 9.3 内容深度约束（§4）

14. Qn_REASONING.md 最低 100 行，每步有实质性 Method（三准则：Operational Specificity / Output Traceability / PLAN Correspondence）
15. Qn_EXECUTION.md 不允许只有 "Status: FAILED" 一行
16. Qn_VERIFICATION.md 最低 80 行，每子字段有详细证据而非 PASS/FAIL 标签。conclusion verification 按 claim 类型分层要求
17. local-executor **全面不承担环境构建职责**——不安装系统工具、不安装 Wolfram paclet、不创建 venv、不安装 venv 包；遇到环境缺失只报告完整错误给 autoresearch（改动 20a Step 3 + 20c Step 6）
    17a. local-executor Step 5 "report failure" 升级为带完整 error context（affected steps / commands attempted / exact error output / partial achievements），禁止 bare "Status: FAILED"（改动 20b，feeds §3.2 Stage 2 Root-Cause Analysis）
18. local-executor Step 8.5 partial execution documentation 确保失败上下文完整传递

### 9.4 phase_rollback MCP（§3.1）

19. phase_rollback MCP 新增——统一处理所有回退（checkpoint + execution + L3），不再使用 advance_plan 做 plan_number 递减
20. rollback_reason 区分场景（checkpoint_rejection / execution_vague / gap_reexamination）；rollback_plans entry 含 evidence + lessons（回退教训并入此数组）；rollback_context 保留最近一次回退信息
21. 跨阶段回退守卫：cross_phase_rollback_count 仅对系统发起的回退计数（execution_vague / gap_reexamination），上限 3 终止 + WORKFLOW_TERMINATION_REPORT.md
22. phase_rollback 原子性：steps 3-10 操作内存 dict，step 11 唯一 \_write_state（原子写）。禁止逐 step 写盘
23. `_default_state()` 含 progress.rollback_plans=[] / rollback_context=None / cross_phase_rollback_count=0；\_read_state_safe 对嵌套字段 progress.rollback_plans 显式补全
24. checkpoint 回退时 git checkout 排除 state.json（保留 rollback_plans/rollback_context）；系统回退不走 git checkout
25. rollback_context（state.json）是薄摘要+指针，rollback_plans 是完整累积教训链——两者分工明确（rollback_context 单条覆盖，rollback_plans 数组追加）
26. PERSISTENCE_WHITELIST 含 WORKFLOW_TERMINATION_REPORT.md
27. health check 保持 advance_plan 往返测写路径（注释标注 exemption）；phase_rollback 仅做注册检查（registration_check_only）
28. 重新进入 phase_execution 时 autoresearch 从 Step 1 重新开始（不从断点继续）
    28a. phase_rollback step 6 读 `blocking_reason[Qn]` 决定 blocked question 是否恢复：`blocking_reason="vagueness"` → pending，`blocking_reason="environment"` → 保留，`blocking_reason="dependency"` → 保留（§3.4 字段定义）。question_status 值域不变（仍为 blocked），blocking_reason 是独立结构化字段
    28b. **`_write_state` 原子写**：phase_rollback 与 advance_plan 共享的底层写函数采用 `FileLock + json.dump + tmp 文件 + os.replace`（改动 30 §3.1 原子性），崩溃 mid-write 时 state.json 不变
    28c. **repair 前备份脚本**（改动 35）：`backup_repair.sh` 作为各 phase repair 目标文件列表的 single source of truth，被 research-coordinator/SKILL.md（dispatch repair 前）+ session-recovery.md §Repair Crash Recovery 引用；取代原 phase-detail-tables.md 三处内联备份列表

### 9.5 plan_vague 回退 debate（§3.3 / §7.6）

29. PLAN.md method 模糊时输出 paused digest（pause_reason=plan_vague_need_debate, vagueness_type=method_vague），claim 不可能时输出 paused digest（vagueness_type=claim_impossible），不自行展开
30. coordinator 收到 plan_vague_need_debate paused digest → 请求用户确认回退 debate → phase_rollback(phase_debate, preserve_execution=true)
31. 回退 debate 时 phase_rollback 保留 execution sub-object（resolved_conclusions + question_status），重置运行时字段（cycle/retries/wave）
32. debate dispatch prompt 注入 vagueness_details 作为额外约束
33. debate-repair 新增 execution-refine severity 类型，按 vagueness_type 选择修复策略
34. debate-repair 不修改已 resolved questions 的 claims/deliverables
35. debate-repair repair digest 新增 execution_refine_details 字段
36. Option 2 (skip vague questions) → skipped_vague question 在 final_execution_digest 和 persistence 汇总中单独列出（区别于 blocked）
37. environment_blocked_ask_user 的 3 种用户选项路由：安装后继续 → re-dispatch autoresearch；接受部分结果 → advance_plan(completed)；中止 → advance_plan(completed)
38. hard_blocked（架构/OS/硬件客观不匹配，§3.2 保守判定原则）→ 标记 question 为 blocked，不输出 paused digest。注意：GPU 不可用 / Python runtime 缺失**不**归 hard_blocked（改归 user_decision_needed，用户可解决）
    38a. pause_reason 完整值域含 pre-existing 的 `state_update_failed`（jq 写失败，coordinator re-dispatch autoresearch），改动 17 + 改动 21 均显式列出

### 9.6 claim_impossible L1/L2/L3（§3.3 / §6）

39. claim_impossible 禁止删除 claim——必须保留 Question 与 Gap 映射。L1/L2/L3 分类由 judgment-worker 负责（§5 任务 d）
40. L1（修订 claim）：debate-repair Local repair，按 digest 中 `claim_impossible_classification.claim_revision_direction` 执行，保留 Question
41. L2（重设计 Question）：debate-repair Structural repair，按 digest 中 `claim_impossible_classification.question_redesign_direction` 执行，新 Question 必须映射到同一 Gap；framing_reasoning.md 加 staleness marker，保留原推导链供审计
42. L3（Gap 错误）：judgment-worker 返回 level=L3（**autoresearch dispatch**，见 §3.3）→ 分类结果写入 paused digest → coordinator 据 digest.level=L3 做**唯一一次** phase_rollback(phase_framing, preserve_execution=true, rollback_reason=gap_reexamination) → dispatch framing(mode=re_derive_gap) ——不经 debate-repair，无双回退
43. L3 回退 framing 时 framing worker 以 re_derive_gap 模式运行——读现有三文件作 base，仅重推导受影响 Gap 段 + 重生成三个全局段 + 下游 Gap 加 staleness marker + 三个文件均 splice 写回（含 PLAN.md splice：替换受影响 Gap 的 claim/test/deliverables bullet + 重生成 Execution Plan Wave 结构，非整文件重写）
44. re_derive_gap 模式下新 Question 沿用原 question ID；若 question 数量变化导致 ID 映射破坏 → framing digest 标 question_id_mapping_broken + 列出 orphaned_questions → resolved_conclusions 受影响 question 标 orphaned
45. debate-repair repair digest 含 execution_refine_details.claim_impossible_handling（level: L1|L2，classification_source: judgment-worker）——L3 不出现在 debate-repair digest 中
46. phase_rollback 接受 phase_framing 作为合法 target

### 9.7 judgment-worker（§5）

47. judgment-worker subagent 只读不写——权限系统显式列举只读工具（不使用 research*state*\* 通配符），无 bash、无 write/edit，返回结构化 YAML 判定，delegation_depth=0
48. Step 5e Stage 1 / 5h0 / 5m 改为 dispatch judgment-worker，autoresearch 用返回的结构化判定构造 retry dispatch prompt
49. autoresearch 保留内联：行数预筛（bash grep -cv）、根因分类（Stage 2）、路由决策、状态管理——不卸载编排判断
50. judgment-worker dispatch 失败 3 次 → autoresearch 降级内联判断（digest 标 judgment_worker_unavailable: true）；行数预筛始终可用
51. 行数预筛两阶段设计：autoresearch 在 dispatch judgment-worker 前用 bash grep -cv 获取 substantive 行数（不加载内容到 context）。Qn_REASONING.md < 100 行 / Qn_VERIFICATION.md < 80 行 → 直接判 shallow（fast path，跳过 judgment-worker dispatch）
52. 任务 d（claim_impossible_classification）**由 autoresearch dispatch**（非 coordinator）——Stage 2 检测 claim_impossible 后立即 dispatch，分类结果写入 paused digest。崩溃恢复：autoresearch re-dispatch judgment-worker（幂等安全，PLAN.md 此时尚未被修改）。分类先于回退——确保 coordinator 做唯一一次 phase_rollback 到正确目标
53. judgment-worker 崩溃恢复不使用专门字段——用行数预筛重建判定（行数 < 阈值 → 直接判 shallow；行数 ≥ 阈值 → re-dispatch judgment-worker 重新判定）
54. health check skill_chain 含 judgment-worker agent 检查（验证 .aether/agent/judgment-worker.md 存在）
55. judgment-worker 与 current_retry_type 的交互：current_retry_type 只管 local-executor/verification dispatch 上下文，不管 judgment-worker dispatch
