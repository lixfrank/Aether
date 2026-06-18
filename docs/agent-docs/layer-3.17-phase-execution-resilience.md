# Layer 3.17: Phase Execution Resilience — 环境自建、深度约束、三阶段判定

> 前置依赖: Layer 3.12（per-question execution 推进管理器）+ Layer 3.5/3.9（环境隔离 + local-executor）+ Layer 3.8（debate phase）。
> 解决 phase_execute 过快终止的 4 个核心问题：环境缺失自动终止、subagent 拉起失败、遇到问题轻易放弃、reasoning/verification 内容过于简略。
> 修改文件：autoresearch SKILL.md + references/（3文件）+ local-executor.md + research.md（coordinator）+ debate-repair SKILL.md + digest-schemas.md + research-state MCP server.py。

---

## 问题诊断

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

## 设计决策

### D1：环境自建职责分层 — autoresearch 负责，local-executor 不参与

**决策**：环境自建（系统级工具安装、Wolfram paclet 安装、venv 创建）由 autoresearch 负责。local-executor 只负责在就绪环境中执行具体任务 + 局部 venv 包安装。

**理由**：

- autoresearch 是循环控制器，有 bash 权限和更多上下文/决策能力
- 环境准备是跨问题的全局任务，应由管理所有问题的 agent 负责
- local-executor 的定位是"在就绪环境中执行"（delegation_depth=0 的 leaf agent），不应承担"从零构建环境"的重任
- 在 local-executor 中加入环境自建逻辑会破坏其功能专注性（leaf agent 只执行，不决策环境）

**local-executor 遇到环境缺失时的行为**：报告完整错误信息给 autoresearch（通过 task_result），不自行尝试安装系统级工具。autoresearch 收到报告后决定下一步（自建环境/暂停/重新派发）。

### D2：Gap 分类 — 从"阻断"变为"分类 + 自建尝试"

**决策**：每个 gap 分为 3 类：

- `auto_installable`：autoresearch 可以通过 bash 尝试安装。安装方法通过 web search 搜索，不硬编码具体命令（版本变更时硬编码会过时）
- `user_decision_needed`：需要用户安装/决策（如需要 sudo 的系统工具、需要用户修改源码）。标记受影响 question 为 blocked，其余继续执行。若所有 question 都因此 blocked（无 pending）→ 输出 paused digest (pause_reason=environment_blocked_ask_user)。**digest 格式、user_options、coordinator 路由处理见改动 10 §environment_blocked_ask_user（此处为决策摘要，不重复展开）**
- `hard_blocked`：物理不可行（如 GPU 不可用、uv 不可用且无 Python）

**理由**：

- `auto_installable` gap 不应阻断 executor dispatch——autoresearch 先尝试自建，成功后继续
- `user_decision_needed` gap 不应阻断整个 per-question 循环——将受影响 question 标记为 blocked，其余 question 继续执行；全部 blocked 才输出 paused digest 请求用户操作（细节见改动 10）
- `hard_blocked` gap 才真正不派发 executor
- 不硬编码安装命令是因为不同环境/版本变更时具体安装方法会过时，让 agent 自行搜索更灵活

### D3：PLAN.md 过于模糊 → 终止 phase_execute 回到 phase_debate

**决策**：当 autoresearch 发现 PLAN.md method 对于 executor 过于模糊（executor 无法确定具体执行步骤）时，autoresearch 不自行展开 method。而是终止 phase_execute，输出 paused digest（pause_reason=plan_vague_need_debate），由 coordinator 将项目回退至 phase_debate，以 debate-repair 机制细化执行计划。

**理由**：

- autoresearch 是执行层 agent，不应自行修改或补充 PLAN.md 的方法设计——方法设计属于 phase_debate/phase_framing 的职责
- autoresearch 自行展开 method 会绕过 debate 的质量保证机制，可能引入未经辩论的隐性假设
- phase_debate 的修复机制（debate-repair）专门处理 PLAN.md 的问题，比 autoresearch 临时展开更可靠
- 实际场景中 PLAN.md 模糊是设计层面的问题，应回到设计层面解决

**回退流程**：

```
phase_execution (autoresearch 发现 PLAN.md method 模糊)
  │ → 输出 paused digest (pause_reason=plan_vague_need_debate)
  │ → paused digest 包含：
  │    - vague_questions: [哪些 question 的 method 模糊]
  │    - vagueness_details: [per-question 的具体模糊描述 — executor 试图执行时遇到什么困难]
  │    - suggestion: "re-enter phase_debate to refine execution plan for [questions]"
  │
  ▼ coordinator 收到 paused digest
  │ → 解析 pause_reason=plan_vague_need_debate
  │ → 与现有 paused routing 不同 — 不是请求用户决策，而是请求回退到 debate
  │ → 使用 question tool 向用户呈现：
  │    "PLAN.md execution plan for [questions] is too vague for executor to determine concrete steps.
  │     Details: [per-question vagueness description from digest].
  │     Suggestion: Return to phase_debate to refine the execution plan before re-executing."
  │ → 用户确认回退 → coordinator 执行回退操作：
  │    1. 保留 DEBATE.md（新 round 内容追加在现有内容之后）
  │    2. 保留 PLAN.md（基于当前 PLAN.md 继续修复，不 rollback）
  │    3. 保留已 resolved questions 的 execution 结果
  │    4. 保留 ENVIRONMENT.md（环境探测结果在 debate 阶段仍然有用）
  │    5. 调用 phase_rollback(target_phase=phase_debate, target_plan_number=8, preserve_execution=true) 回退到 debate
  │    6. Inject vagueness_details 作为额外约束到 debate dispatch prompt
  │
  ▼ phase_debate (新 round)
  │ → debate 各角色（advocate/critic/adjudicator）聚焦于 vagueness 议题
  │ → debate-repair 细化 PLAN.md Execution Plan：
  │    - 将模糊的 method 描述展开为具体执行步骤
  │    - 为每个步骤声明具体的工具、命令、预期输出
  │    - 确保展开后的 method 有可操作的 falsification test
  │    - 检查 environment_requirements 是否覆盖展开后的方法
  │    - 不修改已 resolved questions 的 claims（只修复模糊 questions 的 method）
  │ → debate 完成后 → advance_plan(phase_checkpoint)
  │ → 用户再次确认 → 重新进入 phase_execution
```

**phase_rollback MCP 操作**：

新增 MCP tool `phase_rollback`，统一处理所有 phase 回退（包括 checkpoint 回退和 execution 回退）。与 `advance_plan` 的区别：

| 维度                 | advance_plan                                        | phase_rollback                                                                                 |
| -------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 语义                 | 前进到下一阶段（plan_number 递增）                  | 回退到之前阶段（plan_number 递减）                                                             |
| 适用场景             | 正常 phase 前进                                     | 所有回退场景（checkpoint 拒绝 + execution 不可执行）                                           |
| progress 记录        | 记录到 completed_plans                              | 记录到 rollback_plans（回退不是"完成"，不应混入 completed）                                    |
| execution sub-object | 前进到 phase_execution 时创建                       | preserve_execution=true 保留；preserve_execution=false 清除                                    |
| debate sub-object    | 进入 debate 时初始化（setdefault — 仅不存在时创建） | 回退到 debate 时显式重置运行时字段（current_sub_phase=null），保留 rounds_completed 作为上下文 |
| 回退携带信息         | 无（前进不携带回退信息）                            | rollback_reason + rollback_details（统一注入后续 phase 的 dispatch prompt）                    |

**职责分离原则**：advance_plan 只负责前进，phase_rollback 只负责回退。coordinator 不应使用 advance_plan 做"反向前进"（plan_number 递减）——所有 plan_number 递减的操作统一使用 phase_rollback。

`phase_rollback` 参数：

```python
def phase_rollback(
    target_phase: str,       # 目标 phase（如 phase_debate）
    target_plan_number: str, # 目标 plan_number（如 8）
    project_dir: str,
    preserve_execution: bool = True,  # 是否保留 execution sub-object
    rollback_reason: str = "",  # 回退原因（checkpoint_rejection / execution_vague / 其他）
    rollback_details: dict = {},  # 回退携带的结构化信息（用户反馈 / vagueness_details / 其他）
    commit_sha: str = "",
) -> dict[str, Any]:
```

**rollback_reason 值域**（权威定义）：

| rollback_reason        | 触发场景                              | rollback_details 结构                                   | 注入目标 phase prompt 的内容                      |
| ---------------------- | ------------------------------------- | ------------------------------------------------------- | ------------------------------------------------- |
| `checkpoint_rejection` | 用户在 phase_checkpoint 拒绝 plan     | `{user_feedback: "..."}`                                | 用户反馈作为 debate 新 round 的额外约束           |
| `execution_vague`      | autoresearch 发现 PLAN.md method 模糊 | `{vagueness_details: [...], resolved_questions: [...]}` | vagueness_details 作为 debate 新 round 的聚焦约束 |

> **注**：环境缺失导致 question blocked **不属于回退场景**——它是 pause（不是 rollback）。当所有 question 因 `user_decision_needed` 环境缺失 blocked（无 pending）时，autoresearch 输出 paused digest（`pause_reason=environment_blocked_ask_user`），由 coordinator 请求用户操作（安装/接受部分结果/中止），见改动 10 §environment_blocked_ask_user + 改动 11 路由表。此路径**不调用 phase_rollback**、不计入 `cross_phase_rollback_count`。

实现逻辑：

1. 读取 state.json → 获取当前 phase 和 plan_number
2. 验证：target_plan_number 必须小于当前 plan_number（只允许向后回退）
3. 将当前状态记录到 `progress.rollback_plans`（新字段，数组格式，每次 rollback 事件追加一个 entry），并递增 `state.json.cross_phase_rollback_count`（两者在同一 step 完成，视为一个事务）：
   - rollback_plans 追加：`{"from_phase": current_phase, "from_plan": current_plan_number, "to_phase": target_phase, "to_plan": target_plan_number, "reason": rollback_reason, "timestamp": "[ISO 8601]"}`
     与 `completed_plans`（记录前进事件）平行但独立——rollback_plans 只记录回退事件
   - `cross_phase_rollback_count` 递增（顶层整数，`_default_state()` 初始化为 0；仅对**系统发起的回退**计数，见 step 3.5）
     3.5. **跨阶段回退计数与守卫**（防无界循环——此 step 仅读取 step 3 已递增的计数器并判定，不再递增）：
   - **计数范围**：仅对**系统发起的回退**计数（rollback_reason ∈ {`execution_vague`, `claim_impossible_L3`}）。**用户发起的 checkpoint 回退（rollback_reason=`checkpoint_rejection`）不计入**——用户多次拒绝 plan 调整是正常交互，非 agent 困境。step 3 递增时需按此范围条件递增（checkpoint_rejection 不递增）
   - **上限 3**（`cross_phase_rollback_count >= 3`）：phase_rollback **不执行 step 4 起的后续回退操作**（不更新 phase/plan_number、不重置 execution/debate 字段），直接返回 `{"action": "terminated", "reason": "cross_phase_rollback_limit_reached", "count": 3}`。**此时 step 3 已追加的 rollback_plans entry 需标注 `"guarded": true` 字段**（表示"请求回退但被守卫拒绝"，与成功回退的 entry 区分；coordinator 读审计时据此识别被拒回退）。coordinator 收到此返回值后执行**终止流程**（见改动 11 §跨阶段回退终止流程）：
     - 调用 `advance_plan(phase=completed, plan_number=最终 plan_number)` 将项目标记为已完成
     - 写入**工作情况分析报告**（`persistence/WORKFLOW_TERMINATION_REPORT.md`）：
       - 累积的 `rollback_plans` 完整记录（3 次回退的 from→to/reason/timestamp，含被守卫拒绝的那次）
       - `EXPERIENCE_LOG.md` 的累积教训链摘要
       - 当前 PLAN.md / DEBATE.md / execution results 状态摘要
       - 失败模式诊断：分析为何 agent 陷入反复回退（如：method_vague 与 claim_impossible 交替出现、同一 Gap 被反复判定错误等）
       - 对人类用户的建议：哪些环节需要人工介入（如 PLAN.md 设计需专家判断、Gap 识别需补充领域知识等）
     - 使用 question tool 向用户呈现报告核心结论 + 报告文件路径，等待人工介入。**不 re-dispatch 任何 worker**
   - **守卫触发时机**：在 step 3（记录 + 递增）之后、step 4 更新 phase 之前检查计数器。step 3 先执行确保达上限的那次回退也留下审计记录（含 `guarded: true` 标注）
4. 更新 phase 和 plan_number
5. 如果 preserve_execution=true → 保留 state.json.execution sub-object（不清除），但重置以下字段：
   - `current_cycle` → 重置为 1（新 method = 新起点）
   - `execution_shallow_retries` → 重置所有为 0
   - `environment_retries` → 重置所有为 0
   - `verification_retries` → 重置所有为 0
   - `current_wave` → 重置为 null（autoresearch 从 Step 1 重新读 PLAN.md）
   - `current_question` → 重置为 null
   - `current_step` → 重置为 null
   - `question_status` 中已 resolved → 保留（skip）
   - `question_status` 中因 vagueness blocked → 改为 pending（debate-repair 细化后重新执行）
   - `question_status` 中 pending → 保留
   - `question_status` 中 failed → 保留
   - `question_status` 中 user_decision_needed blocked → 保留
   - `question_status` 中 skipped_vague → 改为 pending（用户选择回退 debate 意味着要重新执行这些 question）
6. 如果 preserve_execution=false → 清除整个 execution sub-object（与 advance_plan 前进行为一致）
7. 如果 target_phase=phase_debate → 重置 debate sub-object 运行时字段：
   - `current_sub_phase` → null（重置为未开始）
   - `escalate_topics` → []（清空）
   - `rounds_completed` → 保留（作为上下文——新 round 编号基于已有轮次递增，不从头开始）
     这与 advance_plan 的 setdefault 语义不同：phase_rollback **显式重置**运行时字段而非隐式保留
8. 如果 commit_sha → 记录到 phase_commits
9. 将 rollback_details 写入 state.json 新字段 `rollback_context`（coordinator 读取此字段构造 re-dispatch prompt）：
   `state.json.rollback_context = {"reason": rollback_reason, "details": rollback_details, "timestamp": "[ISO 8601]"}`
   rollback_context 在下次 phase 前进或回退时被覆盖（只保留最近一次回退的上下文）
10. 写入 state.json
11. 返回 previous/current/progress/rollback_context 信息

**原子性与崩溃恢复**（phase_rollback 必须遵循 advance_plan 的原子写模式）：

steps 3-9 全部操作**内存中的 state dict**（读取后修改，不逐步写盘），只有 step 10 `_write_state` 是唯一的磁盘写入点——采用与 advance_plan 相同的 `FileLock + json.dump + mv tmp` 原子写。这保证：

- **崩溃发生在 step 10 之前**（steps 3-9 执行中）→ state.json 未被修改（内存修改未落盘）→ 重跑 phase_rollback 即可，无状态损坏
- **崩溃发生在 step 10 写入中**（json.dump/mv 中途）→ `_write_state` 的 tmp+mv 模式保证要么完整写入要么不变（旧 state.json 完好）→ 重跑 phase_rollback 即可
- **守卫拒绝场景**（step 3.5 达上限）：step 3 已在内存中追加 rollback_plans entry（含 `guarded: true`），step 10 将其写入。coordinator 收到 `terminated` 返回值后执行终止流程——此时 state.json 已含被守卫拒绝的审计记录，与成功回退的记录共存于 rollback_plans

**禁止逐 step 写盘**：phase_rollback 实现中不得在 step 3/4/5/7/9 各自调用 jq 写 state.json（会产生中间不一致状态）。所有字段修改在内存 dict 上完成后，step 10 一次性写入。

**VALID_PHASES 限制**：当前 advance_plan 有 VALID_PHASES 列表校验。phase_rollback 的 target_phase 也必须在 VALID_PHASES 中。phase_debate (index 8) 是合法回退目标。

**health check 兼容性**：health check 用 advance_plan 做测试（前进 → 回退）。phase_rollback 也可以做类似测试，但需要注意 health check 不应使用 preserve_execution=true（测试场景不应保留真实 execution 数据）。

**与 phase_checkpoint 回退的统一**：

两种回退场景现在统一使用 `phase_rollback`，差异通过参数区分：

| 维度               | checkpoint 回退                                        | execution 回退                                              |
| ------------------ | ------------------------------------------------------ | ----------------------------------------------------------- |
| 触发时机           | 用户在 phase_checkpoint 拒绝 plan                      | autoresearch 在 execution 中发现 plan 不可执行              |
| rollback_reason    | `checkpoint_rejection`                                 | `execution_vague`                                           |
| preserve_execution | false（execution sub-object 不存在，清除是安全兜底）   | true（保留 resolved_conclusions + question_status）         |
| 回退携带信息       | rollback_details.user_feedback（用户拒绝 plan 的原因） | rollback_details.vagueness_details + resolved_questions     |
| DEBATE.md 处理     | 保留，追加新 round                                     | 保留，追加新 round（相同）                                  |
| PLAN.md 处理       | 保留，基于当前修复                                     | 保留，基于当前修复（相同）                                  |
| execution 结果     | 无（尚未执行）                                         | 保留已 resolved questions 的结果                            |
| debate 注入约束    | rollback_details.user_feedback（用户反馈）             | rollback_details.vagueness_details（per-question 模糊描述） |
| 统一操作           | phase_rollback(preserve_execution=false)               | phase_rollback(preserve_execution=true)                     |

**统一的好处**：

1. advance_plan 不再承担回退职责——所有 plan_number 递减的操作统一使用 phase_rollback
2. 回退信息记录统一——所有回退事件记录在 rollback_plans（而非 completed_plans 中夹杂反向前进记录）
3. debate sub-object 重置行为统一——phase_rollback 显式重置运行时字段（而非依赖 advance_plan 的 setdefault 隐式行为）
4. 信息注入统一——两种回退都通过 rollback_context 注入额外约束信息到后续 phase 的 dispatch prompt

**execution 结果保留规则**：

回退到 debate 时，已 resolved questions 的 execution 结果（Qn_REASONING.md + Qn_EXECUTION.md + Qn_VERIFICATION.md）保留在 notepads/[slug]/execution/ 目录中。debate-repair 不修改已 resolved questions 的 claims/deliverables——只修复模糊 questions 的 method 和 environment_requirements。

重新进入 phase_execution 后，autoresearch **必须从 Step 1（Read Plan & Determine Waves）重新开始**——不从 state.json.execution 的 current_question 断点继续。因为 debate-repair 可能改变了 question 结构（拆分/合并 question、重新排序 Waves），旧的 current_wave/current_question 可能不再对应新的 PLAN.md。

autoresearch 在 Step 2 读取 state.json.execution 后，根据 question_status 决定每个 question 的处理：

- 已 resolved questions → skip（使用保留的 resolved_conclusions + 磁盘文件）
- 因 vagueness blocked questions → debate-repair 细化后改为 pending（phase_rollback 已自动将 blocked→pending），使用细化后的 PLAN.md method 重新执行
- 原始 pending questions → 使用细化后的 PLAN.md method 正常执行

state.json.execution 的字段处理（phase_rollback preserve_execution=true 时）：

| 字段                                                  | 回退后处理   | 原因                                             |
| ----------------------------------------------------- | ------------ | ------------------------------------------------ |
| resolved_conclusions                                  | 保留         | dependency 注入需引用已 resolved question 的结论 |
| question_status (resolved)                            | 保留         | autoresearch skip resolved questions             |
| question_status (vagueness blocked)                   | 改为 pending | debate-repair 细化后可重新执行                   |
| question_status (pending)                             | 保留         | 正常执行                                         |
| question_status (failed/user_decision_needed blocked) | 保留         | 仍然 failed/blocked，不受 debate-repair 影响     |
| current_cycle                                         | 重置为 1     | 新 method = 新执行起点，之前的 cycle 消耗归零    |
| execution_shallow_retries/environment_retries         | 重置为 0     | 新 method 不继承旧 method 的 retry 历史          |
| verification_retries                                  | 重置为 0     | 同上                                             |
| current_wave/current_question                         | 重置为 null  | autoresearch 从 Step 1 重新读 PLAN.md 确定 Waves |

### D4：execution_produced 判定中加入内容深度检查

**决策**：autoresearch 对 local-executor 产出的判定从"文件存在 = produced"变为"文件存在 + 内容深度 ≥ 最低标准 = produced"。内容深度不足的产出定义为 `execution_shallow`，autoresearch 补充深度要求后重新派发 local-executor（1 次 shallow_retry，不消耗 cycle）。

**Qn_REASONING.md 和 Qn_EXECUTION.md 的可检验性要求**：

当前 Qn_REASONING.md 的结构模板（worker-prompts.md §Qn_REASONING.md Structure）已经定义了可检验性所需的字段（Intention、Method、Divergence、Assumption introduced），但参考执行中所有 agent 都没有按此结构产出——而是用了公式化的两步模板。

可检验性的核心要求是：

1. **推导步骤必须对应 PLAN.md method 步骤**——每个 PLAN.md method step 都应有对应的 reasoning step（可追踪性）
2. **每步的 Method 字段必须描述具体执行操作**——而非"检查了文件"或"应用了判定"
3. **Divergence 声明使得偏离可检测**——但只有当 step 真正包含推导时才有偏离可言
4. **Assumption introduced 使得隐性假设可检测**——但只有当 step 包含计算/推导才可能引入新假设

当前的"两步模板"破坏了所有可检验性：

- 2 个"检查-判定"步骤无法对应 PLAN.md 的多个 method 步骤 → step_completeness PASS 是假 PASS
- 没有推导就没有 Divergence → method_fidelity PASS 是空洞的 PASS
- 没有计算就没有新 Assumption → assumption_audit PASS 毫无意义

**改进方案**：在 local-executor dispatch prompt 中加入强制深度要求 + 在 autoresearch 判定中加入 shallow 检查：

- Qn_REASONING.md：每个 PLAN.md method step 必须有对应的推理步骤，每步包含具体计算/推导的 Method 字段。最低 100 行。
- Qn_EXECUTION.md：每个 PLAN.md method step 必须有至少一个具体产物（数值结果、代码输出、计算数据）。最低 50 行。
- partial execution 是允许的：如果环境 gap 阻止了某些步骤，对可执行的步骤仍然必须产出推导和结果。gap impact 必须逐步骤分析，不能用一句话"结构性/环境问题"概化。

### D5：三阶段判定 — 根因分析 + 分类修复

**决策**：将 autoresearch Step 4e 的单层判定扩展为三阶段：

Stage 1 — Output Completeness Check（现有的表扩展）：

- execution_produced → proceed to verification
- execution_shallow → 补充深度要求，1 次 shallow_retry（不消耗 cycle）
- execution_failed → proceed to Stage 2

Stage 2 — Root-Cause Analysis（新增）：

- 环境 gap（autoresearch Step 3 未捕获）→ 尝试 bash 自建，成功后重新派发（1 次 environment_retry，不消耗 cycle）
- PLAN.md method 模糊 → 输出 paused digest，建议回 phase_debate
- local-executor 崩溃/超时 → 简化任务范围重试（消耗 cycle）
- 结构性不可能 → paused digest

Stage 3 — Cycle Decision：

- 只有消耗 cycle 的操作才计入 3-cycle limit
- shallow_retry、environment_retry 不消耗 cycle（修复 dispatch 质量，而非 execution 质量）
- PLAN.md 模糊 → 不消耗 cycle（回退到 debate）

### D6：verification 内容深度约束

**决策**：基于对前期 phases verification 的审核，确定 verification 深度要求。

前期 phases 的 verification 质量分析：

- `audit_1_round1.md`（119 行）：有具体的 Finding 列表，每个 finding 包含 claim/issue/evidence/suggested_search/verification_source。这是良好的 verification 模板——每条发现都有支撑证据。
- `fbi_dct_nis` 的 Qn_VERIFICATION.md（49 行）：只有 PASS/FAIL 标签和一行 conclusion_summary。对比 audit phase 的 verification，差距显著。

问题出在 verification subagent 的 prompt 模板中缺少深度要求。research-verification SKILL.md 的 Step 6-7 已经定义了 5 个子字段和输出格式，但没有要求 verifier 为每个子字段提供详细证据（只需 PASS/FAIL 标签即可满足格式要求）。

**改进方案**：在 verification dispatch prompt 中要求：

- method_fidelity：每个 reasoning step 必须与 PLAN.md method 做显式逐句对比（引用 PLAN.md 原文 vs reasoning 描述），而非只写 PASS
- step_completeness：每个 PLAN.md method step 逐条列出 found/not-found 状态和内容摘要
- assumption_audit：每个 assumption 必须标注 framing_reasoning.md 的 section 编号/行号
- dependency_usage：每个 dependency 必须与 resolved_conclusions 的 scope 做显式范围对比
- conclusion verification：每个 claim 必须有至少 1 个 computational evidence artifact（执行代码块、脚本输出、数值比较），不能只有 LLM-only reasoning
- Qn_VERIFICATION.md 最低 80 行（不含 digest YAML）

### D7：digest.status=failed → execution_produced 的合理性

当前 edge-cases.md §Execution-level Failure Decision 中有一行：

> "digest.status=failed (partial output) → execution_produced → Proceed to verification dispatch"

**合理性**：`digest.status=failed` 表示 executor 做了实质性工作但部分步骤/test 失败（区别于 `execution_failed` = 完全崩溃无产出）。partial output 仍有验证价值——verification 精确诊断失败 claims，为 retry 提供方向，比"丢弃 + 整体重试"更高效。与"文件不存在 → execution_failed"互补覆盖。

> 详细论证见 `references/edge-cases.md` §Execution-level Three-Stage Decision §Stage 1 的 "Why digest.status=failed → execution_produced" 段（改动 7 定义该段为权威解释，本节仅作决策摘要，不重复展开）。

---

## 改动清单

### 涉及文件

| 文件                                                                    | 改动类型                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.aether/skills/autoresearch/SKILL.md`                                  | 重构 Step 3 Gap Check + 新增 Step 4 环境自建 + 重构 Step 5e 为三阶段判定（原 Step 4e）+ Step 5a skipped_vague 分支（改15）+ Step 5h0 verification 深度检查（改14）+ Step 5m failure synthesis（改7，改23 dispatch judgment-worker）+ Step 5b ENVIRONMENT.md re-read 明确（改18）+ dispatch 逻辑改为调用 judgment-worker（改23：Step 5e Stage 1 / 5h0 / 5m 由内联改为 dispatch）                                                                                                    |
| `.aether/skills/autoresearch/references/worker-prompts.md`              | 新增 Gap Classification + §Isolation Strategy Classification 表去 (critical)/(medium) 严重度标签（改4）+ 内联 gap check 文本替换为分类引用 + 新增产出深度约束 + 新增 verification 深度约束（含 enforcement 声明，改14）+ 新增 Partial Execution 子节 + 新增 §Judgment Worker Prompt Templates（改23）                                                                                                                                                                              |
| `.aether/skills/autoresearch/references/edge-cases.md`                  | 重构 Execution-level Failure Decision 为三阶段 + 新增 shallow/environment retry 计数器 + Session Recovery retry 类型崩溃恢复（改13，pending_judgment 优先级最高）+ verification_shallow_retry（改14）+ all-hard_blocked 终止路径（改16）+ 统一"7"推导流程图（改19）                                                                                                                                                                                                                |
| `.aether/skills/autoresearch/references/digest-schemas.md`              | 扩展 paused digest 格式 — 新增 plan_vague_need_debate pause_reason 类型 + final_execution_digest skipped_vague_questions section（改15）+ repair digest claim_impossible_handling（改20）                                                                                                                                                                                                                                                                                          |
| `.aether/agent/local-executor.md`                                       | 新增 partial execution 协议（不修改 Step 3 local strategy，不增加环境自建逻辑）                                                                                                                                                                                                                                                                                                                                                                                                    |
| `.aether/agent/research.md`                                             | 新增 plan_vague_need_debate paused digest 路由处理 — 回退到 phase_debate + claim_impossible L3 回退 phase_framing 路由（改20）+ EXPERIENCE_LOG 写入 + git checkout 排除协议（改22）                                                                                                                                                                                                                                                                                                |
| `.aether/agent/judgment-worker.md`                                      | **新增** judgment-worker subagent — 应用结构化 rubric 返回结构化判定（改23），只读（无 bash/write/edit，权限系统显式列举只读 MCP 工具而非通配符强制）+ `pending_judgment` dispatch 协议（改13+23）                                                                                                                                                                                                                                                                                 |
| `.aether/skills/research-question-framing/SKILL.md`                     | **新增** `mode=re_derive_gap` 第二运行模式 — 6 处修改：Lifecycle Contract（mode 参数+Output/State transition 变化）+ Step 1（读三文件 base）+ Step 2-5（仅受影响 Gap 局部重推导）+ Step 6-7（级联 staleness+全局段重生成+splice 写回 framing 输出）+ Step 8（PLAN.md splice）+ Step 10-11（跳过 advance_plan+re_derive_gap digest）（改20）                                                                                                                                        |
| `.aether/skills/debate-repair/SKILL.md`                                 | 新增"execution 回退 repair"能力 — 处理来自 phase_execution 的 vague method 问题 + claim_impossible L1/L2/L3 分层修正（改20）                                                                                                                                                                                                                                                                                                                                                       |
| `.aether/mcp/research-state/server.py`                                  | 新增 `phase_rollback` MCP tool — 支持从 phase_execution 回退到 phase_debate，保留 execution sub-object + 跨阶段回退守卫（cross_phase_rollback_count 上限 3 终止，step 3.5）+ `_default_state()` 同步 rollback_plans/rollback_context/cross_phase_rollback_count + `_read_state_safe` 嵌套字段补全（改17）+ health check phase_rollback 注册检查（改21）+ PERSISTENCE_WHITELIST 加 EXPERIENCE_LOG.md/WORKFLOW_TERMINATION_REPORT.md（改22）+ skill_chain 加 judgment-worker（改23） |
| `.aether/skills/research-coordinator/references/phase-routing.md`       | phase_checkpoint rollback git checkout 排除 state.json + EXPERIENCE_LOG.md（改22）                                                                                                                                                                                                                                                                                                                                                                                                 |
| `.aether/skills/research-coordinator/references/phase-detail-tables.md` | §Git Rollback Protocol 标准回退步骤加排除协议（改22）                                                                                                                                                                                                                                                                                                                                                                                                                              |

### 改动间依赖矩阵

| 改动                                | 前置依赖                           | 说明                                                                                                                                                             |
| ----------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 改动 1 (Step 3 Gap Check)           | 无                                 | 独立重构                                                                                                                                                         |
| 改动 2 (Step 4 环境自建)            | 改动 1                             | Step 3 分类后 auto_installable gap 进入 Step 4                                                                                                                   |
| 改动 3 (Step 5e 三阶段判定)         | 改动 7 (edge-cases 三阶段表)       | SKILL.md 引用 edge-cases.md 的详细判定表                                                                                                                         |
| 改动 4 (Gap Classification)         | 改动 1                             | 为 Step 3 分类提供详细规则表                                                                                                                                     |
| 改动 5 (产出深度约束)               | 改动 3                             | shallow 检查依赖三阶段判定流程                                                                                                                                   |
| 改动 6 (Partial Execution)          | 改动 5                             | partial execution 是 shallow 检查和深度约束的具体指导                                                                                                            |
| 改动 7 (edge-cases 三阶段)          | 改动 1 + 改动 4                    | 三阶段判定需要 gap 分类和环境自建流程的完整定义                                                                                                                  |
| 改动 8 (Verification 深度)          | 改动 3                             | verification 在 execution 后执行，深度约束嵌入 dispatch prompt                                                                                                   |
| 改动 9 (local-executor partial)     | 改动 5 + 改动 6                    | local-executor partial execution 协议与产出深度约束配合                                                                                                          |
| 改动 10 (digest-schemas)            | 改动 3                             | plan_vague paused digest 格式需要与三阶段判定中 Stage 2 的 plan_vague 路径一致                                                                                   |
| 改动 11 (research.md routing)       | 改动 10                            | coordinator 路由处理需要 paused digest 格式定义                                                                                                                  |
| 改动 12 (debate-repair)             | 改动 11                            | debate-repair 的 execution-refine 需要 coordinator 回退流程中注入的 vagueness_details                                                                            |
| 改动 13 (Session Recovery)          | 改动 7 + 改动 14                   | 依赖 execution_shallow_retries/environment_retries 字段（改动 7 新增）+ verification_shallow_retries（改动 14 新增）；统一 retry 类型崩溃恢复                    |
| 改动 14 (verification_shallow)      | 改动 3 + 改动 8                    | verification 深度检查依赖三阶段判定流程（改动 3）+ verification 深度判据（改动 8 已定义）                                                                        |
| 改动 15 (skipped_vague 接入)        | 改动 11                            | skipped_vague 由 coordinator Option 2（改动 11）设置，autoresearch 只读                                                                                          |
| 改动 16 (all hard_blocked)          | 改动 7                             | 终止路径在 edge-cases 三阶段表（改动 7）的 Stage 2 末尾补充                                                                                                      |
| 改动 17 (\_default_state)           | 改动 7（MCP server.py 部分）       | rollback_plans/rollback_context 字段定义在改动 7 phase_rollback 逻辑中                                                                                           |
| 改动 18 (ENVIRONMENT.md re-read)    | 改动 3                             | Step 5b 是改动 3 三阶段判定的 retry loop-back 目标                                                                                                               |
| 改动 19 (统一"7"推导)               | 改动 7 + 改动 14                   | 流程图需含 shallow/env/verification_shallow retry 路径                                                                                                           |
| 改动 20 (claim_impossible L1/L2/L3) | 改动 12 + 改动 11                  | 深化改动 12 的 claim_impossible 路径；L3 路由复用改动 11 的 coordinator rollback 流程；依赖 phase_rollback（改动 7）的 phase_framing target + preserve_execution |
| 改动 21 (health check 兼容)         | 改动 7（server.py phase_rollback） | phase_rollback 注册检查依赖 tool 已注册（改动 7）                                                                                                                |
| 改动 22 (EXPERIENCE_LOG)            | 改动 7 + 改动 11 + 改动 20         | PERSISTENCE_WHITELIST 更新依赖 server.py；写入由 coordinator 在 phase_rollback 前执行（改动 11 路由）；L3 场景复用改动 20 回退路径                               |
| 改动 23 (judgment-worker)           | 改动 3 + 改动 14                   | shallow-judgment 替换改动 3 的内联 Stage 1；verification-depth-judgment 替换改动 14 的内联 5h0；failure-synthesis 替换 Step 5m 内联                              |

### 改动 1：autoresearch/SKILL.md — Step 3 Gap Check 重构

**位置**：Step 3 第 5 点（当前文本）

**当前文本**：

> 5. **Gap check**: If critical gap exists → do NOT dispatch executor for affected tasks → mark in digest → coordinator reports to user

**替换为**：

> 5. **Gap classification + resolution attempt**: Classify each discovered gap per `references/worker-prompts.md` §Gap Classification. For each gap:
>    - `auto_installable` → proceed to Step 4 (environment self-build). Do NOT skip executor dispatch for questions affected by this gap — attempt resolution first
>    - `user_decision_needed` → mark questions affected by this gap as `blocked` in state.json.execution.question_status (blocking_dependency = gap description). Questions NOT affected by this gap continue execution normally. At execution end, include user_decision_needed gaps in final_execution_digest → coordinator informs user about environment requirements after execution completes
>    - `hard_blocked` → do NOT dispatch executor for affected questions. Other questions continue normally
>    - After classification → proceed to Step 4

### 改动 2：autoresearch/SKILL.md — 新增 Step 4 环境自建（原 Step 3 之后插入，原 Step 4→Step 5，原 Step 5→Step 6）

**插入位置**：原 Step 3 之后，原 Step 4 之前

```markdown
### Step 4: Environment Self-Build (auto_installable gaps only)

For each gap classified as `auto_installable` in Step 3:

1. For each auto_installable gap, determine installation method:
   - Use web search (webfetch/websearch) to find the correct installation method for the missing software in the current environment
   - Do NOT rely on hardcoded installation commands — software versions and installation methods change over time. Always discover the correct method for the current environment via web search
   - Web search retry: if first search returns no useful results (no installation guides found, or all results are irrelevant/outdated), retry with alternative search queries (up to 2 additional attempts with different keyword combinations). If all search attempts fail → reclassify this gap as `user_decision_needed` (skip installation attempt, mark affected questions as blocked)
   - If websearch/webfetch tool is unavailable or returns errors → reclassify this gap as `user_decision_needed` (skip installation attempt)
2. Execute installation via bash using the web-search-discovered method:
   - Python packages: install into .aether/research/.venv
   - Wolfram/Mathematica paclets: install via wolframscript
   - System tools: report as user_decision_needed (autoresearch MUST NOT run brew/apt/sudo without explicit user consent)
   - The exact commands are determined by web search results, NOT by this document
3. After each install attempt → re-probe to verify installation success
4. Update ENVIRONMENT.md:
   - If installed successfully → remove gap from gaps list, update host_system.tools or venv_state.installed_packages
   - If install failed → reclassify this gap:
     - Failed install → `user_decision_needed`. Mark questions affected by this gap as `blocked` in state.json.execution.question_status (blocking_dependency = gap description). At execution end, include in final_execution_digest for coordinator to inform user
5. Write updated ENVIRONMENT.md with final gap classification
```

**Step 编号顺延**：原 Step 4 (Per-Question Loop) → Step 5, 原 Step 5 (Final Output) → Step 6。

### 改动 3：autoresearch/SKILL.md — Step 5e 重构为三阶段判定（原 Step 4e）

**位置**：原 Step 4 的子步骤 e（执行完 local-executor 后的判定）

**当前文本**：

> After local-executor returns, apply decision table in `references/edge-cases.md` §Execution-level Failure Decision

**替换为**：

````markdown
#### e. Read execution results → Three-Stage Decision

After local-executor returns, apply THREE-STAGE decision per `references/edge-cases.md` §Execution-level Three-Stage Decision:

Stage 1 — Output Completeness Check:

- execution_produced → proceed to verification dispatch (step f-g)
- execution_shallow → **行数预筛（cheap pre-filter，避免不必要的 judgment-worker dispatch）**：autoresearch 用 bash 获取 substantive 行数（**不加载文件内容到 context**）：

  ```bash
  grep -cvE '^\s*$|^\s*#' notepads/[slug]/execution/Qn_REASONING.md
  ```

  - 若 substantive 行数 < 100 → execution_shallow（**fast path，跳过 judgment-worker**）：autoresearch 构造 generic shallow_retry dispatch prompt "Your Qn_REASONING.md has [N] substantive lines (minimum 100). Each PLAN.md method step requires a reasoning step with a concrete Method field describing the computation/derivation performed — not just 'inspected'/'checked'. Expand your derivation to cover every method step." Re-dispatch local-executor (1 shallow_retry per question, does NOT consume cycle)
  - 若 substantive 行数 ≥ 100 → **dispatch judgment-worker(shallow-judgment)** 做三准则 rubric 评估（padding 仍可被三准则检测）。judgment-worker 返回 deficient_steps + improvement_guidance → autoresearch 据此构造 targeted shallow_retry dispatch prompt。Re-dispatch local-executor (1 shallow_retry per question, does NOT consume cycle)

- execution_failed → proceed to Stage 2

Stage 2 — Root-Cause Analysis (for execution_failed only):
Autoresearch reads task_result + any partial local-executor output:

- Environment gap (tool/package missing, not caught in Step 3) → attempt bash self-build per Step 4 procedure. If self-build succeeds → update ENVIRONMENT.md, re-dispatch local-executor (1 environment_retry per question, does NOT consume cycle). If self-build fails → reclassify as user_decision_needed, output paused digest
- PLAN.md method too vague OR claim/falsification test fundamentally impossible → output paused digest (pause_reason=plan_vague_need_debate, vagueness_type=[method_vague|claim_impossible], affected_questions, suggestion: re-enter phase_debate to refine execution plan or mark claim as infeasible). Does NOT consume cycle. Does NOT retry execution — design-level problem that execution-level retry cannot fix.
  - vagueness_type=method_vague: executor cannot determine concrete execution steps from PLAN.md method description — method lacks actionable specificity (no specific tools/commands/parameters, no step-by-step instructions)
  - vagueness_type=claim_impossible: claim or falsification test contradicts mathematical/physical laws — the claim is fundamentally infeasible regardless of method refinement
- Local-executor crash/timeout → retry with simplified task scope. Consumes cycle
- Environment physically impossible (GPU unavailable, no Python runtime, no compilation toolchain) → mark affected questions as blocked in state.json.question_status (blocking_dependency = missing environment description). Other questions continue normally. Does NOT output paused digest for whole execution

Stage 3 — Cycle Decision:

- Only actions that consume cycles count toward the 3-cycle limit per question
- shallow_retry does NOT consume cycle (max 1 per cycle per question)
- environment_retry does NOT consume cycle (max 1 per cycle per question)
- plan_vague does NOT consume cycle (returns to debate)
- Max 1 shallow_retry + 1 environment_retry per question per cycle (each type independent)
- Execution cycle limit remains 3 (for actual execution attempts that consume cycles)
- **Total execution attempt limit**: each question max 7 local-executor dispatches (推导见 `references/edge-cases.md` §Execution-level Three-Stage Decision §Stage 3)

Retry loop-back, backup, state update, and dispatch prompt supplementation: see `references/edge-cases.md` §Execution-level Three-Stage Decision §Retry Loop-back Procedure for detailed operational steps. SKILL.md only declares the decision logic above — all operational procedures are in edge-cases.md.

Reset rules（execution_shallow_retries / environment_retries / verification_shallow_retries 在 cycle-consuming retry 或 question resolved 时 reset 为 0）的权威定义见 `references/edge-cases.md` §Retry Loop-back Procedure §Reset rules。SKILL.md 不重复。

### 改动 4：references/worker-prompts.md — 新增 §Gap Classification + §Isolation Strategy Classification 去严重度标签

**位置**：§Isolation Strategy Classification 表本身 + 其后新增 §Gap Classification

**§Isolation Strategy Classification 表更新**：移除 gap 行的严重度标签——所有原标 `gap (critical)` / `gap (medium)` 的行改为统一的 `gap`（不带严重度）。严重度不再由 Isolation 表判定，而由 §Gap Classification 决定（单一权威）：

| Condition                                              | Strategy                                      |
| ------------------------------------------------------ | --------------------------------------------- |
| Licensed/self-contained software, host available       | `local`                                       |
| Pure Python + wheel-installable packages, uv available | `uv_venv`                                     |
| Pure Python, uv NOT available                          | `gap`（流入 §Gap Classification）             |
| Compilation/build tasks, toolchain available           | `local_compile`                               |
| GPU workloads, local GPU available                     | `local` (with GPU)                            |
| Untrusted external repo code                           | `local_compile` with `untrusted_source: true` |
| Mixed (Python + compilation)                           | Split into separate tasks per strategy        |
| Compilation, toolchain NOT available                   | `gap`（流入 §Gap Classification）             |

**新增内容**（§Isolation Strategy Classification 表之后）：

```markdown
### Gap Classification

All `gap` entries produced by §Isolation Strategy Classification（无严重度标签）flow into this classification, which is the **single authority** for gap handling action. The former `gap (critical)` / `gap (medium)` severity labels are removed — severity is determined here by the specific missing item, not pre-labeled at Isolation stage.

| Category               | Definition                                                                                                                                                                            | autoresearch Action                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto_installable`     | Software that autoresearch can install via bash without requiring user consent for system-level operations                                                                            | Attempt installation via bash (Step 4). Use web search to find correct installation method — do NOT rely on hardcoded commands. If install succeeds → remove gap, continue. If install fails → reclassify as `user_decision_needed`                                                                                                                     |
| `user_decision_needed` | Software that requires user action: sudo/brew/apt system installs, manual source code modifications, license-bound software, or any installation that autoresearch failed to complete | Mark affected questions as `blocked` in state.json.execution.question_status (blocking_dependency = gap description). Questions NOT affected by this gap continue execution normally. At execution end, include user_decision_needed gaps in final_execution_digest → coordinator informs user about environment requirements after execution completes |
| `hard_blocked`         | Physical impossibility: GPU unavailable when required, no Python runtime at all, no compilation toolchain and user cannot install                                                     | Do NOT dispatch executor for affected questions. Other questions continue normally                                                                                                                                                                                                                                                                      |

Classification rules:

- Python packages missing, uv/venv available → `auto_installable`
- Wolfram paclets missing, wolframscript available → `auto_installable`
- System tools missing (requires sudo/brew/apt) → `user_decision_needed` (autoresearch MUST NOT run system installers without user consent)
- GPU required but unavailable → `hard_blocked`
- Python runtime missing, uv unavailable → `hard_blocked`
- Requires code modification outside .aether/research → `user_decision_needed`
- Unknown/ambiguous dependency → `user_decision_needed`
- Failed auto_installable attempt → reclassify as `user_decision_needed`

autoresearch determines installation method via web search, NOT via hardcoded commands. Different environments and software versions require different installation procedures — the agent must discover the correct method for the current environment.
```
````

**worker-prompts.md gap 处理更新**：worker-prompts.md 当前的内联 `**Gap check**: If critical gap exists → do NOT dispatch executor` 文本（§Environment Probe Commands 末尾）替换为引用——`**Gap classification**: Classify each discovered gap per §Gap Classification above, then proceed per SKILL.md Step 3 point 5（Gap classification + resolution attempt，改动 1 定义）`。移除原有"critical gap 直接阻断 dispatch"语义。注意：改动 1 会将 Step 3 point 5 的内容从旧"Gap check 直接阻断"重构为"Gap classification + resolution attempt 流转"，本引用指向重构后的语义。

**Step 编号全局更新**：worker-prompts.md 中所有对原 `Step 4` 的引用（包括 `Step 4d`、`Step 4g`、`Step 4e` 等）需全局搜索并替换为对应的新编号 `Step 5`（如 `Step 4d` → `Step 5d`，`Step 4g` → `Step 5g`）。所有对原 `Step 5` 的引用需替换为 `Step 6`。注意：此替换仅针对步骤编号引用，不涉及 SKILL.md 的改动（SKILL.md 改动 2 和改动 3 已经在新编号下撰写）。实现后用 grep 交叉校验 `Step [45]` 引用，确保无悬空引用。

### 改动 5：references/worker-prompts.md — 重构 §Local-Executor Prompt Template 产出深度约束

**位置**：§Local-Executor Prompt Template 的 `MANDATORY: You MUST write TWO output files:` 之后

**新增内容**：

```markdown
MANDATORY CONTENT DEPTH REQUIREMENTS:

1. Qn_REASONING.md depth requirements:
   - MUST contain a substantive derivation step for EACH method step in PLAN.md Execution Plan for Qn
   - Each step MUST include: (1) Intention (what this step achieves per PLAN.md), (2) Method (the concrete computation/derivation/operation performed — NOT just "inspected" or "checked"), (3) Divergence (if method diverges from PLAN.md), (4) Assumption introduced (if any new assumption)
   - The Method field in each step MUST describe a concrete operation that produces a new finding or result — "inspection" and "check" steps without producing new information are NOT sufficient
   - **Substantive derivation may overturn PLAN.md method step's preset**: if execution reveals that a PLAN.md method step's approach is incorrect or suboptimal, the reasoning step MUST document this overturning explicitly — in Divergence field, declare what the original PLAN.md method intended, why it was overturned, and what the replacement approach is. This is NOT a shallow pattern — overturning with documented reasoning is substantive derivation
   - If a step cannot be fully executed due to environment/dependency gaps → write partial execution results. Document: what was attempted, what partially succeeded, and the specific gap's impact on THIS step (NOT a blanket "environment gap" for all steps)
   - NEVER collapse multiple incomplete steps into a single "environment gap" statement
   - Substantive derivation criteria (for autoresearch shallow evaluation):
     a. Operational Specificity: each step's Method field MUST describe a concrete, independently reproducible operation with identifiable input→output transformation (NOT just an action label like "performed dimensional analysis" or "checked consistency")
     b. Output Traceability: each step MUST produce a traceable result in Qn_EXECUTION.md — numerical results, code outputs, computed data, or analytical conclusions with corresponding evidence
     c. PLAN Correspondence: each PLAN.md method step MUST have at least one reasoning step with substantive Method (NOT just a declaration "this step corresponds to PLAN method step N"). Reasoning steps that overturn PLAN.md method steps still satisfy PLAN Correspondence if they document the overturning with substantive reasoning
   - MINIMUM length: 100 lines (excluding section headers). Files under 100 lines will be classified as execution_shallow and re-dispatched with depth emphasis
   - Line count counts substantive content lines only — blank lines and lines containing only section headers (##, ###) do NOT count toward the 100-line minimum. Padding with empty lines or repetitive headers is detectable and will still be classified as execution_shallow

2. Qn_EXECUTION.md depth requirements:
   - MUST contain at least one concrete artifact per PLAN.md method step (numerical results, code output, computed values, analysis artifacts)
   - If full execution is blocked → partial artifacts from executable sub-steps are still mandatory
   - NEVER write only a "Status: FAILED" line without detailing: what was attempted, what partially succeeded, specific gap that blocked completion
   - Include execution logs, command outputs, and computed data
```

### 改动 6：references/worker-prompts.md — 新增 §Qn_REASONING.md Partial Execution 子节

**位置**：§Qn_REASONING.md Structure 的 `## Dependency Usage` 之后

**新增内容**：

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

### 改动 7：references/edge-cases.md — 重构 §Execution-level Failure Decision 为 §Execution-level Three-Stage Decision

**位置**：替换整个 §Execution-level Failure Decision 章节

**当前内容**（4行判定表）→ **替换为**：

````markdown
## Execution-level Three-Stage Decision

After local-executor returns, autoresearch applies three stages:

### Stage 1 — Output Completeness Check

| Condition                                                                                                                                                                                                                                                                                                                                                                    | Decision           | Next action                                                                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| task_result empty/no structured content                                                                                                                                                                                                                                                                                                                                      | execution_failed   | Proceed to Stage 2 (Root-Cause Analysis)                                                                                               |
| Qn_REASONING.md + Qn_EXECUTION.md not exist                                                                                                                                                                                                                                                                                                                                  | execution_failed   | Proceed to Stage 2                                                                                                                     |
| Qn_REASONING.md + Qn_EXECUTION.md exist, content depth sufficient (meets minimum line threshold per worker-prompts.md §MANDATORY CONTENT DEPTH REQUIREMENTS, each step has substantive Method per Operational Specificity/Output Traceability/PLAN Correspondence criteria, execution has concrete artifacts per step)                                                       | execution_produced | Proceed to verification dispatch (Step 5f-g)                                                                                           |
| Qn_REASONING.md + Qn_EXECUTION.md exist, content depth insufficient (below minimum line threshold per worker-prompts.md §MANDATORY CONTENT DEPTH REQUIREMENTS, or steps fail Operational Specificity/Output Traceability/PLAN Correspondence criteria per worker-prompts.md §MANDATORY CONTENT DEPTH REQUIREMENTS, or execution has only "Status: FAILED" without artifacts) | execution_shallow  | autoresearch supplements depth requirements into dispatch prompt, re-dispatch local-executor (1 shallow_retry, does NOT consume cycle) |
| digest.status=failed (partial output with substantive content)                                                                                                                                                                                                                                                                                                               | execution_produced | Proceed to verification dispatch — partial output still has verifiable value                                                           |

**Why digest.status=failed → execution_produced**: `digest.status=failed` means local-executor did substantive work but some steps/tests failed. Unlike execution_failed (no output at all), partial output can still be verified — verification identifies which claims pass and which fail, providing precise diagnosis for retry direction. Discarding partial results and retrying from scratch is less efficient than verifying what exists and retrying only the failed parts.

### Stage 2 — Root-Cause Analysis (for execution_failed only)

Autoresearch reads task_result + any partial local-executor output to classify root cause:

| Root Cause Category                                                                                                                                                               | Action                                                                                                                                                                                                                                                                           | Cycle consumption                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Environment gap (tool/package missing, not caught in Step 3)                                                                                                                      | Attempt bash self-build per Step 4 procedure. If succeeds → update ENVIRONMENT.md, re-dispatch local-executor (1 environment_retry, does NOT consume cycle). If fails → reclassify gap as user_decision_needed, mark affected questions as blocked in state.json.question_status | environment_retry: does NOT consume cycle (max 1) |
| PLAN.md method too vague OR claim/falsification test fundamentally impossible (local-executor cannot determine concrete actions, OR claim contradicts mathematical/physical laws) | Output paused digest (pause_reason=plan_vague_need_debate). Suggest coordinator re-enter phase_debate to refine execution plan or mark claim as infeasible. Does NOT retry execution — design-level problem                                                                      | Does NOT consume cycle (returns to debate)        |
| Local-executor crash/timeout                                                                                                                                                      | Retry with simplified task scope (reduce complexity, narrow scope)                                                                                                                                                                                                               | Consumes cycle                                    |
| Environment physically impossible (GPU unavailable when required, no Python runtime at all, no compilation toolchain)                                                             | Mark affected questions as `blocked` (blocking_dependency = missing environment description). Other questions continue normally. Include in final_execution_digest → coordinator informs user after execution completes                                                          | N/A (blocked, not terminal for whole execution)   |

### Stage 3 — Cycle Decision（权威定义）

- Only actions that consume cycles count toward the 3-cycle limit per question
- shallow_retry: max 1 per question per cycle, does NOT consume cycle (fixes dispatch quality). Reset to 0 on cycle-consuming retry, so each cycle has its own 1 shallow_retry allowance
- environment_retry: max 1 per question per cycle, does NOT consume cycle (fixes environment). Reset to 0 on cycle-consuming retry, so each cycle has its own 1 environment_retry allowance
- plan_vague: does NOT consume cycle (returns to debate, not an execution failure)
- Execution cycle limit remains 3 (for actual execution attempts that consume cycles)
- Each retry type is independently counted — using shallow_retry does not reduce available environment_retry
- **Total execution attempt limit**: each question max 7 local-executor dispatches:
  - Cycle 1: 1 dispatch + 1 shallow_retry + 1 environment_retry = 3 dispatches
  - Cycle 2: 1 dispatch + 1 shallow_retry + 1 environment_retry = 3 dispatches（retry 计数 reset 后重新可用）
  - Cycle 3: 1 dispatch = 1 dispatch
  - 合计 3 + 3 + 1 = 7（cycle 2/3 的 shallow/env retry 仅在该 cycle 的 dispatch 失败时才触发，最坏情况下每个 cycle 各触发一次）
- verification dispatch 另计（每 cycle 最多 1 normal + 1 verification_shallow_retry = 2 次，3 cycle 最多 6 次 verification dispatch）

### Retry Loop-back Procedure

After shallow_retry, environment_retry, or simplified-task retry decision:

1. Loop back to Step 5b (prepare execution context) — re-read dependency context and ENVIRONMENT.md to ensure consistency before re-dispatch. Dependency context may have changed if a prior question resolved between this question's last attempt and now
2. Backup previous output before re-dispatch:
   - shallow_retry: Qn_REASONING.md → Qn_REASONING_shallow1.md, Qn_EXECUTION.md → Qn_EXECUTION_shallow1.md
   - environment_retry: Qn_REASONING.md → Qn_REASONING_env1.md, Qn_EXECUTION.md → Qn_EXECUTION_env1.md
   - cycle retry (existing): Qn_REASONING.md → Qn_REASONING_cycle[N].md, etc. (per existing backup procedure)
3. Update state.json via jq:
   - shallow_retry: `jq '.execution.execution_shallow_retries.[Qn] += 1 | .execution.current_step = "execution"' state.json`
   - environment_retry: `jq '.execution.environment_retries.[Qn] += 1 | .execution.current_step = "execution"' state.json`
   - cycle retry: `jq '.execution.current_cycle += 1 | .execution.verification_retries.[Qn] = 0 | .execution.execution_shallow_retries.[Qn] = 0 | .execution.environment_retries.[Qn] = 0 | .execution.current_step = "execution"' state.json`
4. Supplement dispatch prompt with retry context:
   - shallow_retry: autoresearch reads the shallow Qn_REASONING.md, identifies steps with insufficient Method fields (only "inspected"/"checked"/"applied criterion" — no concrete computation described), and constructs targeted improvement guidance. The dispatch prompt MUST include: (a) "PREVIOUS OUTPUT WAS SHALLOW", (b) list of specific shallow steps with their deficiencies (e.g., "Step 3 Method field only says 'checked dimensional consistency' — you MUST describe the specific SymPy computation performed and its numerical result"), (c) reference to shallow backup file for context. Autoresearch decides improvement guidance flexibly — no fixed template
   - environment_retry: "ENVIRONMENT GAP RESOLVED — missing [tool/package] has been installed. Re-attempt full execution using the now-available tool. Previous failed output saved as [Qn]\_REASONING_env1.md for reference"
5. Simplified-task cycle-consuming retry (crash/timeout → Stage 2 → simplified scope):
   - Autoresearch decides simplified scope autonomously — reduce method steps, narrow verification range, simplify computation
   - After simplified task completes with diagnostic insights → dispatch full-task execution (consumes a new cycle)
   - Simplified task insight MUST be injected into full-task dispatch prompt: "Previous simplified execution for [Qn] revealed: [insights from simplified run]. Use these insights to guide full execution"
6. Failure synthesis (cycle-consuming retry only — **SKILL.md 新增 Step 5m**，插入位置：Step 5l "Backup before retry" 之后，作为 cycle retry 的最后一步，在 backup 完成、cycle 递增之后、dispatch 新 cycle 之前执行)：
   - Before dispatching next cycle's local-executor, autoresearch MUST read previous cycle's backup files (Qn_REASONING_cycle[N].md + Qn_VERIFICATION_cycle[N].md) and synthesize failure context
   - Failure synthesis reads: verification_digest from previous cycle → claims_failed + reasoning_verification FAIL sub-fields; Qn_REASONING_cycle[N].md → which steps had Method deficiencies
   - Construct structured cycle revision context: "Previous cycle [N] verification findings: (1) claims [X, Y] failed — reason: [from verification_digest]; (2) reasoning method_fidelity FAIL at step [N] — [specific description]; (3) [other FAIL sub-field diagnoses]"
   - Inject cycle revision context into next cycle's dispatch prompt alongside revision_needed — this supplements (not replaces) the local-executor's own revision_needed with autoresearch's synthesized diagnostic summary

Reset rules（权威定义 — SKILL.md 与其他处均引用此处）:

- execution_shallow_retries[Qn]: reset to 0 on cycle-consuming retry or question resolved
- environment_retries[Qn]: reset to 0 on cycle-consuming retry or question resolved
- verification_shallow_retries[Qn]: reset to 0 on cycle-consuming retry or question resolved（改动 14 新增）
- current_retry_type: dispatch 返回后（无论成功失败）重置为 normal；cycle-consuming retry 或 question resolved 时亦重置为 normal

### Per-Question Execution Retry Sequence Flow

All retry types for a single question [Qn], showing priority order and interaction:

```
[Qn] per-question execution lifecycle (max 7 local-executor dispatches):

Step 5b: Prepare execution context
  │
  ▼ Step 5c: Update current_step = "execution"
  ▼ Step 5d: Dispatch local-executor (cycle 1)
  │
  ▼ Step 5e: Read execution results → THREE-STAGE DECISION

  ┌─ Stage 1: Output Completeness Check ──────────────────────────┐
  │ execution_produced → proceed to Step 5f (verification)        │
  │                                                                │
  │ execution_shallow → shallow_retry (max 1 per cycle):          │
  │   loop → Step 5b → 5c → 5d (dispatch with targeted depth     │
  │   improvement prompt) → 5e (re-evaluate)                      │
  │   if still shallow after 1 retry → consume cycle,             │
  │   execution_shallow_retries[Qn] resets to 0, proceed to Stage 2        │
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
  │   output paused digest (pause_reason=plan_vague_need_debate)  │
  │   → coordinator routes to phase_rollback → debate             │
  │                                                                │
  │ Local-executor crash/timeout → cycle retry:                   │
  │   if cycle < 3: simplified scope retry → full scope retry    │
  │     (consumes cycle, execution_shallow_retries + environment_retries    │
  │      both reset to 0)                                         │
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
  │   loop → Step 5b → 5c → 5d → 5e → 5f → 5g → 5h             │
  │                                                                │
  │ paused_ask_user → output paused digest →                      │
  │   coordinator asks user → re-dispatch with user decision      │
  │                                                                │
  │ failed → mark question_status=failed →                        │
  │   failure propagation (Step 5k)                                │
  └────────────────────────────────────────────────────────────────┘

Maximum sequence for worst-case question (7 dispatches):
  1. Cycle 1: dispatch → execution_shallow →
  2. shallow_retry1 → execution_produced → verification retry_execution →
  3. Cycle 2: dispatch → execution_failed → environment gap → self-build →
  4. environment_retry1 → execution_produced → verification retry_execution →
  5. Cycle 3: dispatch → verification failed →
     mark Qn failed (cycle limit exhausted)
  OR (alternative worst case):
  1. Cycle 1: dispatch → execution_shallow →
  2. shallow_retry1 → execution_shallow (still shallow after retry) →
     consume cycle → execution_shallow_retries reset
  3. Cycle 2: dispatch → execution_failed → environment gap → self-build →
  4. environment_retry1 → execution_produced → verification failed →
  5. Cycle 3: dispatch → execution_produced → verification resolved → done
```

### New state.json fields

Add to state.json.execution schema:

```json
{
  "execution": {
    ... (existing fields) ...,
    "execution_shallow_retries": {
      "Q1": 0
    },
    "environment_retries": {
      "Q1": 0
    }
  }
}
```
````

- execution_shallow_retries[Qn]: initialized to 0 per question. Incremented on each shallow_retry. Max 1. Reset to 0 on cycle retry or question resolved.
- environment_retries[Qn]: initialized to 0 per question. Incremented on each environment_retry attempt. Max 1. Reset to 0 on cycle retry or question resolved.

Jq operations for new fields:

```bash
# Initialize new fields (append to existing initialization command):
jq '.execution.execution_shallow_retries = {} | .execution.environment_retries = {}' state.json

# Increment execution_shallow_retries for Qn:
jq '.execution.execution_shallow_retries.[Qn] += 1' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Increment environment_retries for Qn:
jq '.execution.environment_retries.[Qn] += 1' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Reset both on cycle retry or question resolved:
jq '.execution.execution_shallow_retries.[Qn] = 0 | .execution.environment_retries.[Qn] = 0' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json
```

````

### Safety Constraints Update (edge-cases.md)

当前 edge-cases.md §Safety Constraints 中有：

> "Rollback to earlier phase: execution sub-object is entirely cleared (question IDs may change), no interaction with audit sub-object"

**统一回退规则**（替换上述单一规则）：

所有 phase 回退统一使用 `phase_rollback`（coordinator 不使用 `advance_plan` 做 plan_number 递减操作）。规则按 `preserve_execution` 参数区分：

> **preserve_execution=false**（checkpoint 回退等场景）：execution sub-object 如果存在则被清除（安全兜底——checkpoint 回退时通常不存在）。如果不存在则无操作。与 advance_plan 前进时清除行为一致。
>
> **preserve_execution=true**（execution 回退等场景）：execution sub-object 保留，但重置运行时字段（current_cycle=1, execution_shallow_retries=0, environment_retries=0, verification_retries=0, current_wave=null, current_question=null, current_step=null），并将 vagueness blocked 的 question_status 改为 pending、skipped_vague 的 question_status 改为 pending。保留 resolved_conclusions 和 resolved/pending/failed/user_decision_needed_blocked 的 question_status。
>
> **通用规则**：rollback_plans 数组记录所有回退事件（与 completed_plans 平行但独立）。rollback_context 保留最近一次回退的上下文信息（coordinator 读取此字段构造 re-dispatch prompt）。debate sub-object 的 current_sub_phase 重置为 null，escalate_topics 清空，rounds_completed 保留（作为上下文）。
>
> **advance_plan 不做回退**：advance_plan 只负责前进（plan_number 递增）。所有 plan_number 递减的操作使用 phase_rollback。coordinator 禁止调用 advance_plan 传入比当前 plan_number 更小的值。

### 改动 8：references/worker-prompts.md — 新增 §Verification Worker Prompt Template 深度约束

**位置**：§Verification Worker Prompt Template 的 `Decision rules:` 之后

**新增内容**：

```markdown
MANDATORY VERIFICATION DEPTH:

Qn_VERIFICATION.md MUST contain detailed evidence for each sub-field verdict, not just PASS/FAIL labels:
- For method_fidelity: each reasoning step MUST be compared to PLAN.md method with explicit quote-and-compare. For each step: "PLAN.md says [quote] → Qn_REASONING.md does [description] → match/divergence [reasoning]"
- For step_completeness: every PLAN.md method step MUST be listed individually with found/not-found status and content summary. Format: "Step [N] [PLAN method description]: FOUND (content: [1-line summary]) / NOT FOUND"
- For assumption_audit: each assumption MUST be cross-referenced with framing_reasoning.md section number. Format: "Assumption '[description]' → framing_reasoning.md §[section] line [N]: FOUND / NOT FOUND (undeclared)"
- For dependency_usage: each dependency MUST be checked against resolved_conclusions scope with explicit scope comparison. Format: "Dependency [Qd]: used as [how Qd was used] → Qd conclusion scope: [scope description] → within scope / overgeneralization [reason]"
- For conclusion verification: verification evidence MUST match the claim type per the following hierarchy:

  Claim-type verification hierarchy:

  | Claim Type              | Verification Requirement                                                                                                           | "independently confirmed" Standard                                |
  | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
  | Computational/numerical | MUST have computational evidence artifact (executed code, script output, numerical comparison) — LLM-only is NOT sufficient         | Computational oracle required                                      |
  | Structural/algebraic   | SHOULD have computational evidence (SymPy/algebraic verification). If unavailable, MUST provide literature citation + derivation chain | Computational oracle preferred; citation-backed derivation acceptable |
  | Conceptual/qualitative | MUST provide literature citation for each key premise + logical reasoning chain connecting sub-components. Computational evidence for sub-components recommended but not required | Citation-backed reasoning required; computational evidence optional |

  LLM-only reasoning WITHOUT any of the above (no computation, no citation, no reasoning chain) is NEVER sufficient for "independently confirmed" — regardless of claim type.

  When dispatch prompt requirements are stricter than the general verification skill's minimum requirements, follow the dispatch prompt's stricter standard.
- MINIMUM Qn_VERIFICATION.md length: 80 lines (excluding digest YAML block). Files under 80 lines are considered shallow verification
- Line count counts substantive evidence lines only — blank lines, section headers, and PASS/FAIL labels without supporting evidence do NOT count toward the 80-line minimum
````

### 改动 9：local-executor.md — 新增 partial execution 协议（不修改 Step 3 local strategy）

**位置**：在 Step 8（Verify Against Acceptance Tests）和 Step 9（Write Execution Report）之间插入 Step 8.5

**新增内容**：

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

This step ensures autoresearch (the parent agent) receives complete failure context for root-cause analysis. local-executor does NOT attempt to install missing system tools or Wolfram paclets — that is autoresearch's responsibility. local-executor only reports what is missing and what was partially achieved.
```

**不修改 Step 3 local strategy**：local-executor 遇到环境缺失时，只报告完整错误信息（通过 Step 8.5 的 partial execution documentation），不自行尝试安装系统级工具。环境自建是 autoresearch 的职责。

### 改动 10：references/digest-schemas.md — 扩展 paused digest 格式

**位置**：§paused digest 的 `pause_reason` 值域和 `user_options`

**当前 paused digest 格式**（pause_reason 值域仅 3 种）：

```yaml
pause_reason: "[fallback_failed_ask_user / critical_dep_failed / max_retries_exhausted]"
```

**扩展为**（新增 plan_vague_need_debate + environment_blocked_ask_user 类型）：

```yaml
pause_reason: "[fallback_failed_ask_user / critical_dep_failed / max_retries_exhausted / plan_vague_need_debate / environment_blocked_ask_user]"
```

**新增 plan_vague_need_debate 的 paused digest 格式**：

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
        vagueness_description: "[per-question 具体描述 — executor 试图执行时遇到什么困难，PLAN.md method 的哪些部分缺乏可操作性]"
        method_reference: "[PLAN.md Execution Plan 中 Qn 的 method 描述原文]"
    suggestion: "Re-enter phase_debate to refine execution plan for [vague questions list]"
    execution_progress:
      resolved_questions: ["[list of already resolved questions]"]
      failed_questions: ["[list]"]
      blocked_questions: ["[list]"]
      current_wave: [N]
      current_question: "[Qn where vagueness was detected]"
  user_options:
    - "Return to phase_debate to refine the execution plan (Recommended)"
    - "Continue execution with current plan (skip vague questions)"
    - "Abort execution"
```

**与现有 paused digest 的差异**：

| 维度             | 现有 paused digest                      | plan_vague_need_debate paused digest                       | environment_blocked_ask_user paused digest            |
| ---------------- | --------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------- |
| pause_reason     | 3 种（fallback/dep/retries）            | 新增 plan_vague                                            | 新增 environment_blocked                              |
| user_options     | 3 通用选项（skip/assumption/abort）     | 3 专用选项（回退debate/跳过模糊问题/abort）                | 3 专用选项（安装后继续/接受部分结果/中止）            |
| 核心信息         | failed_question + failure_summary       | vague_questions + vagueness_description + method_reference | missing_environment + blocked_questions               |
| coordinator 路由 | 请求用户决策 → re-dispatch autoresearch | 请求用户确认回退 → phase_rollback(phase_debate)            | 请求用户操作 → re-dispatch 或 advance_plan(completed) |
| 恢复后行为       | 继续从 paused point 推进                | 回退到 debate → 重新执行                                   | 安装后继续 → 或接受部分结果结束项目                   |

**新增 environment_blocked_ask_user 的 paused digest 格式**：

当所有 question 都因 user_decision_needed 环境缺失被阻断（无 pending question 可继续执行）时，autoresearch 输出此 paused digest。**注意**：如果仍有 pending question（部分 question 不受此 gap 影响），则继续执行那些 pending question，不输出此 paused digest——只将受影响 question 标记为 blocked。

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: per_question_execution
  status: paused
  pause_reason: "environment_blocked_ask_user"
  pause_details:
    missing_environment:
      - gap_description: "[具体缺失描述 — 哪个工具/软件缺失，为什么无法自行安装]"
        required_for_questions: ["[Qn list affected by this gap]"]
        install_hint: "[如果已知安装方法，给出提示 — 如 'brew install gcc' 或 'pip install [package]']"
    blocked_questions:
      - question: "[Qn]"
        blocking_dependency: "[gap description]"
    resolved_questions: ["[list of already resolved questions — if any]"]
    execution_progress:
      current_wave: [N]
      current_question: "[Qn where block was detected]"
  user_options:
    - "I have installed the missing software — continue execution"
    - "Accept partial results (cannot install missing software)"
    - "Abort execution"
```

**environment_blocked_ask_user 的 coordinator 路由处理**：

1. Append paused digest to DIGESTS.md (1 entry)
2. Use question tool to present environment block information and options

3. After user decision:
   - **Option 1 (installed, continue)** → re-dispatch autoresearch:
     coordinator re-dispatches research-worker (autoresearch), prompt 注入用户决策 "User has installed missing software — re-probe environment and continue execution from Step 1"。autoresearch 从 Step 1 重新开始（重新探测环境，重新确定 Waves），已 resolved questions 的结果从 state.json.resolved_conclusions 中读取（保留）
     Re-dispatch prompt 注入：`rollback_context` 不适用（这不是回退，而是重新执行），coordinator 在 prompt 中明确指出 "USER has installed: [missing_environment descriptions from digest]"
   - **Option 2 (accept partial results)** → advance_plan(completed):
     coordinator 调用 advance_plan(phase=completed) → present partial results（已 resolved questions 的结论 + blocked questions 的环境缺失说明）
   - **Option 3 (abort)** → advance_plan(completed):
     同 Option 2，但额外标注 abort 原因

### 改动 11：research.md (coordinator) — 新增 plan_vague_need_debate 路由处理

**位置**：§Digest processing 的 Status routing 表 + §用户决策恢复

**当前 Status routing 表**：

| Digest status | Coordinator action                      |
| ------------- | --------------------------------------- |
| completed     | advance_plan(completed)                 |
| partial       | advance_plan(completed)                 |
| paused        | 请求用户决策 → re-dispatch autoresearch |

**扩展为**：

| Digest status | pause_reason                                 | Coordinator action                                                                                |
| ------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| completed     | N/A                                          | advance_plan(completed) → present results                                                         |
| partial       | N/A                                          | advance_plan(completed) → present partial results                                                 |
| paused        | fallback_failed / critical_dep / max_retries | 请求用户决策 → re-dispatch autoresearch (现有机制不变)                                            |
| paused        | plan_vague_need_debate                       | **新增路由** → 请求用户确认回退 debate → phase_rollback(phase_debate, preserve_execution=true)    |
| paused        | environment_blocked_ask_user                 | **新增路由** → 请求用户操作（安装软件/接受部分结果/中止）→ re-dispatch 或 advance_plan(completed) |

**跨阶段回退守卫（所有触发 phase_rollback 的路由共享）**：

任何路由在调用 phase_rollback 前无需自行检查计数器——phase_rollback 内部（实现逻辑 step 3.5）在递增 `cross_phase_rollback_count` 后若达上限 3，直接返回 `{"action": "terminated", "reason": "cross_phase_rollback_limit_reached", "count": 3}` 而非执行回退。coordinator 收到此返回值后执行**终止流程**（见下文 §跨阶段回退终止流程），不再继续原路由的 re-dispatch。

**§跨阶段回退终止流程**（phase_rollback 返回 terminated 时）：

1. 调用 `advance_plan(phase=completed, plan_number=最终 plan_number)` 将项目标记为已完成
2. 写入 `persistence/WORKFLOW_TERMINATION_REPORT.md`（工作情况分析报告）：
   - `## Termination Reason`：cross_phase_rollback_limit_reached（agent 工作流陷入反复回退，无法通过自我修复解决）
   - `## Rollback History`：从 `state.json.progress.rollback_plans` 提取全部回退记录（from→to/reason/timestamp）
   - `## Lessons Accumulated`：从 `persistence/EXPERIENCE_LOG.md` 提取累积教训链摘要（每次回退的 failed_approach / what_went_wrong / what_to_avoid）
   - `## Current State Snapshot`：当前 PLAN.md / DEBATE.md / execution results 状态摘要（已 resolved questions、failed/blocked questions）
   - `## Failure Pattern Diagnosis`：分析为何 agent 陷入反复回退——识别失败模式（如：method_vague 与 claim_impossible 交替、同一 Gap 被反复判定错误、framing 推导链结构性缺陷等）
   - `## Human Intervention Needed`：对人类用户的建议——哪些环节需要人工介入（如 PLAN.md 设计需专家判断、Gap 识别需补充领域知识、convention 约束需澄清等）
3. 使用 question tool 向用户呈现报告核心结论 + 报告文件路径，等待人工介入。**不** re-dispatch 任何 worker——此时继续自动化只会重蹈覆辙

**新增 plan_vague_need_debate 处理流程**：

1. Append paused digest to DIGESTS.md (1 entry)
2. Use question tool to present vagueness information and options:

```
PLAN.md execution plan for [vague questions] is too vague for the executor to determine concrete steps.

Details:
- [Q1]: [vagueness_description from digest]
  PLAN.md method: "[method_reference from digest]"
- [Q3]: [vagueness_description from digest]
  PLAN.md method: "[method_reference from digest]"

Already resolved questions: [list] — their results will be preserved.

Options:
1. Return to phase_debate to refine the execution plan (Recommended)
2. Continue execution with current plan (skip vague questions, accept partial results)
3. Abort execution
```

3. After user decision:
   - **Option 1 (return to debate)** → execution rollback to debate:
     1. Preserve DEBATE.md (new round content appends after existing)
     2. Do NOT rollback PLAN.md (debate-repair based on current PLAN.md including any resolved results)
     3. Preserve execution results for resolved questions (Qn_REASONING.md + Qn_EXECUTION.md + Qn_VERIFICATION.md remain in notepads/[slug]/execution/)
     4. Preserve ENVIRONMENT.md (environment probe results useful during debate)
     5. Call phase_rollback(target_phase=phase_debate, target_plan_number=8, preserve_execution=true) via research-state MCP
     6. Update STATE.md: phase=phase_debate, Blockers section append vagueness_details
     7. Git commit: `git add .aether/research/ && git commit -m "research: execution rollback to phase_debate (plan vague — [questions])"`
     8. Dispatch research-worker for debate round (inject vagueness_details as additional constraint)

   - **Option 2 (skip vague questions)** → re-dispatch autoresearch with user decision to skip:
     Same as existing re-dispatch mechanism. Inject user decision "Skip [vague questions], accept partial results" into re-dispatch prompt. autoresearch marks vague questions as `skipped_vague` in state.json.execution.question_status (a new status value distinct from `blocked`). Skipped_vague questions are treated like blocked for execution continuation (skip in per-question loop), but are distinguished in final_execution_digest and persistence 汇总文件:
     - final_execution_digest: add `skipped_vague_questions` section (parallel to `failed_questions` and `blocked_questions`), each entry includes: question, vagueness_description, method_reference
     - persistence/EXECUTION.md: add "Skipped (Plan Vague)" table parallel to "Blocked Questions" table, listing each skipped_vague question with vagueness description
     - persistence/VERIFICATION.md: add "Skipped (Plan Vague)" table noting "Not verified (PLAN.md method too vague for execution)"

   - **Option 3 (abort)** → advance_plan(phase=completed) with partial results.

4. For Option 1, debate dispatch prompt:

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

- [Q3]: [vagueness_description]
  PLAN.md method: "[method_reference]"
  Executor difficulty: [what the executor tried and why it couldn't proceed]

Already resolved questions: [resolved_questions list] — their claims and methods MUST NOT be modified in this debate round.

DEBATE FOCUS: The primary focus of this round is to refine the Execution Plan for [vague_questions] — expand vague method descriptions into concrete, executable steps with specific tools, commands, and expected outputs. Also ensure Environment Requirements cover the refined methods.

Invoke /[debate_skill] skill. Follow all steps in SKILL.md."
)
```

**与 checkpoint 回退的协调**：

两种回退现在统一使用 `phase_rollback`。execution 回退到 debate 后，如果用户在后续 checkpoint 又拒绝，coordinator 再次使用 `phase_rollback(rollback_reason=checkpoint_rejection)`。Round counter 继续递增（rounds_completed 保留），不重置。每次回退允许最多 3 更多 rounds（cumulative）。

**coordinator 对 phase_checkpoint 拒绝的处理变更**：之前使用 `advance_plan` 做"反向前进"，现在改为使用 `phase_rollback(rollback_reason=checkpoint_rejection, preserve_execution=false)`。coordinator 从 state.json.rollback_context 读取 user_feedback 构造 debate re-dispatch prompt。

### 改动 12：debate-repair/SKILL.md — 新增"execution 回退 repair"能力

**位置**：Step 2 §Assess Repair Scope & Impact 的 severity 表 + Step 3 §Execute Repair 的 repair 模式列表

**新增 severity 类型**（在现有 Local/Structural/Exploratory 之后）：

| Severity             | Criteria                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Repair Scope                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Execution-refine** | Problem originates from phase_execution rollback — PLAN.md method description is too vague for executor to determine concrete actions OR claim/falsification test is fundamentally impossible; executor has reported specific difficulty with the method. vagueness_type from paused digest determines repair strategy: method_vague → expand vague method into concrete step-by-step execution instructions; claim_impossible → 按 L1/L2/L3 分层修正（见改动 20，禁止 retract claim） | Expand vague method into concrete step-by-step execution instructions with specific tools, commands, inputs, and expected outputs per step (for method_vague). claim_impossible 按 L1(修订 claim)/L2(重设计 Question,保留 Gap 映射)/L3(标 gap_reexamination_needed,回退 framing) 分层处理（改动 20 详述）。Add corresponding concrete Acceptance Tests. Ensure Environment Requirements cover the refined method. Do NOT modify resolved questions' claims |

**新增 execution-refine repair pattern**（在 Step 3 §Structural repair patterns 之后）：

7. **Execution plan refinement** (common for plan_vague_need_debate from execution rollback): Expand vague method descriptions into concrete, executable step-by-step instructions. For each vague method step:
   - Specify exact tool/command to use (e.g., "Run SymPy dimensional analysis via .aether/research/.venv/bin/python script" instead of "Use dimensional analysis")
   - Specify concrete input parameters and expected output format
   - Specify intermediate verification checkpoints
   - Ensure each step has a corresponding concrete Acceptance Test
   - Ensure Environment Requirements section lists all software needed by the refined steps
   - Add fallback methods for steps that may encounter environment gaps
   - Do NOT modify claims or falsification criteria of already resolved questions — only refine the Execution Plan method description and Acceptance Tests for vague questions

**execution-refine repair 的约束**（在 Integrity Rules 中新增）：

- **Do NOT modify claims or falsification criteria of resolved questions** — when execution rollback returns to debate, some questions may already be resolved. debate-repair MUST NOT alter their claims, acceptance tests, or falsification criteria. Only refine the Execution Plan for vague questions.
- **Vagueness details from execution are binding constraints** — the executor's specific difficulty reports (from the paused digest vagueness_description) are factual evidence about what makes the plan unexecutable. debate-repair MUST address each reported difficulty point, not dismiss it.
- **Resolved question execution results are preserved** — debate-repair MUST NOT request deletion of Qn_REASONING.md/Qn_EXECUTION.md/Qn_VERIFICATION.md for resolved questions. These files remain in notepads/[slug]/execution/ and are available for reference during debate.
- **Refined method MUST be self-contained** — each method step MUST include enough detail for a local-executor to execute without needing to interpret vague instructions. The local-executor is a leaf agent with no skill_refs — it relies entirely on the dispatch prompt and ENVIRONMENT.md for execution guidance.

**Step 4 Consistency Verification 新增检查项**（execution-refine 专属）：

After execution-refine repair, additionally verify:

1. Refined method steps have corresponding concrete Acceptance Tests (not just "verify result" — specify verification method, expected values, tolerance)
2. Refined method steps are executable with declared Environment Requirements (no new undeclared dependencies)
3. Refined method does not contradict claims or falsification criteria of UPHELD or resolved questions
4. Each refined step has a specific tool/command that exists in ENVIRONMENT.md or is installable
5. Resolved questions' execution results are still consistent with the refined PLAN.md (no contradiction introduced)

**Digest 新增字段**（在 repair digest schema 中）：

```yaml
execution_refine_details: # 新增字段，仅在 execution-refine repair 时出现
  - question: "[Qn]"
    vagueness_addressed: "[description of how each vagueness point was addressed]"
    refined_steps_added: [N] # 新增的具体执行步骤数量
    acceptance_tests_refined: [N] # 细化的 Acceptance Tests 数量
    environment_requirements_added: [N] # 新增的环境需求声明数量
```

`execution_refine_details` 是可选字段 — 仅当本轮 repair 包含 execution-refine 类型时才出现。如果本轮只有普通 Local/Structural/Exploratory repair，此字段为 null 或省略。

---

### 改动 13：edge-cases.md — Session Recovery 支持 retry 类型崩溃恢复

**问题**：新增 `execution_shallow_retries` / `environment_retries` 后，Session Recovery（当前 edge-cases.md §Session Recovery L138-151）未更新。shallow_retry / environment_retry dispatch 中途崩溃时，`current_step="execution"` 且 Qn_REASONING.md 存在（来自 retry 前的输出），恢复逻辑会直接进 verification，把浅薄/失败输出送入 verification，违背 retry 设计意图。environment_retry 崩溃时还无法判断环境自建是否完成。

**方案**：引入 `current_retry_type` 字段（4 值域：`normal|shallow|environment|verification_shallow`）标识当前 retry 上下文，统一 execution_shallow / environment / verification_shallow 三类 retry 的崩溃恢复判定。

**新增 state.json.execution 字段**：

```json
{
  "execution": {
    ...,
    "current_retry_type": "normal"  // normal | shallow | environment | verification_shallow（改动14扩展）
  }
}
```

- `current_retry_type` 在每次 dispatch 前（local-executor 或 verification worker）写入：正常 dispatch→`normal`，shallow_retry→`shallow`，environment_retry→`environment`，verification_shallow_retry→`verification_shallow`（改动 14 扩展）
- dispatch 返回后（无论成功失败）重置为 `normal`

**Session Recovery 更新**（edge-cases.md §Session Recovery 重构——**current_retry_type 检查优先于 current_step 通用逻辑**，避免 shallow/env retry 崩溃时误走通用 "文件存在→直接 decision/verification" 路径）：

```markdown
Session Recovery 重构后的判断顺序：

1. **先读 `pending_judgment`**（改动 23 新增，优先级最高——深度强制是质量门，崩溃恢复不得绕过）：
   - = "execution_shallow" → 产出文件已由 local-executor 写入，re-dispatch judgment-worker(shallow-judgment) 重新判定深度，**不直接送 verification**
   - = "verification_depth" → Qn_VERIFICATION.md 已由 verification worker 写入，re-dispatch judgment-worker(verification-depth-judgment) 重新判定深度，**不直接做 decision**
   - = "failure_synthesis" → 非质量门，清除 pending_judgment，走 step 2 通用逻辑（缺失 failure synthesis 上下文不影响正确性）
   - = null（或字段缺失，向后兼容）→ 走 step 2
2. **再读 `current_retry_type`**（pending_judgment=null 时）：
   - = "shallow" | "verification_shallow" → shallow retry 统一恢复分支（见下）
   - = "environment" → environment retry 恢复分支（见下）
   - = "normal"（或字段缺失，向后兼容）→ 走原 current_step 通用逻辑（下文 step 3）
3. current_step 通用逻辑（pending_judgment=null 且 current_retry_type=normal 时）：
   - = "execution" → Qn_REASONING.md + Qn_EXECUTION.md 存在且完整 → 构造 fallback digest，直接进入 verification dispatch（verification_retries 从 state.json 继续，不重置）；文件不存在 → re-dispatch local-executor (cycle=current_cycle)，重置 verification_retries 为 0
   - = "verification" → Qn_VERIFICATION.md 存在 → 构造 fallback verification digest，直接做 decision；不存在 → re-dispatch verification worker（verification_retries 继续，不重置）
   - question_status 有 blocked → continue next non-blocked question
   - question_status 有 pending → continue from that question
```

**shallow retry 统一恢复分支**（current_retry_type=shallow 或 verification_shallow 时——execution_shallow 与 verification_shallow 共享语义：retry 目的是修复浅薄产出，崩溃时磁盘上的文件是 retry 前的原始浅薄产出，不能直接进入下一步）：

shallow retry 共享恢复模式（差异用 [execution_shallow] / [verification_shallow] 标注）：

- 将现有产出文件视为浅薄产出——[execution_shallow: Qn_REASONING.md + Qn_EXECUTION.md, current_step="execution"；verification_shallow: Qn_VERIFICATION.md, current_step="verification"]——**不能**直接送入下一步（[execution_shallow 不能送 verification；verification_shallow 不能做 decision]）
- 检查对应 retry 计数——[execution_shallow: execution_shallow_retries[Qn]；verification_shallow: verification_shallow_retries[Qn]]：
  - 若已达上限（=1）→ **降级**：
    - [execution_shallow] → consume cycle（increment current_cycle, reset execution_shallow_retries/environment_retries to 0, current_retry_type=normal）→ re-dispatch local-executor (cycle=new current_cycle)
    - [verification_shallow] → 视为 verification 失败：若 reasoning 子字段 FAIL → retry_execution（consume cycle）；若 reasoning 全 PASS 但 conclusion 证据不足 → retry_execution（method 可能 flawed）
  - 若未达上限 → 保持对应 retry 计数当前值（dispatch 已计入但未返回），重新构造对应 shallow_retry dispatch prompt，re-dispatch（不再次递增计数）
  - 若产出文件不存在 → shallow_retry dispatch 未产出，直接 re-dispatch 对应 shallow_retry（不递增计数）

**environment retry 恢复分支**（current_retry_type=environment，current_step="execution" 时）：

- environment_retry 前已执行 Step 4 环境自建，崩溃时自建可能完成也可能未完成（bash install 可能已执行但 ENVIRONMENT.md 尚未更新）
- **不依赖 ENVIRONMENT.md gaps 判断**——崩溃可能发生在 install 之后、ENVIRONMENT.md 更新之前（工具已实际安装但 gaps 未移除 → 读 gaps 会假阴性误判 blocked）。改为**重新执行 Step 3 环境 probe**（bash 探测原 gap 对应的工具/包是否可用），以 probe 实际结果为准：
  - probe 显示工具已可用（自建成功，即使 ENVIRONMENT.md 未更新）→ 更新 ENVIRONMENT.md（移除 gap），按 normal execution 恢复（产出文件存在→verification；不存在→re-dispatch normal, current_retry_type=normal, 不递增 environment_retries）
  - probe 显示工具仍不可用（自建未完成或失败）→ reclassify 为 user_decision_needed，mark question blocked，continue next question
- 若 environment_retries[Qn] 已达上限（=1）→ reclassify 为 user_decision_needed, mark blocked

current_retry_type 在恢复决策完成后、re-dispatch 前重置为对应类型（继续 shallow/env retry 则设为对应值，回退 normal 则设为 normal）。

````

**jq 操作**：

```bash
# dispatch 前设置 retry 类型
jq '.execution.current_retry_type = "shallow"' state.json  # 或 "environment" / "verification_shallow" / "normal"
# dispatch 返回后重置
jq '.execution.current_retry_type = "normal"' state.json
````

**初始化**：`current_retry_type` 在 state.json.execution 初始化时设为 `"normal"`（加入 edge-cases.md §Initialization 的 jq 命令）。

### 改动 14：autoresearch/SKILL.md + edge-cases.md + worker-prompts.md — verification_shallow_retry 机制

**问题**：D4 给 execution 侧加了 shallow_retry 强制机制，但 D6 对 verification 侧只有 prompt 约束无 enforcement。verifier 产出 < 80 行但 YAML 合法、标 "ALL PASS" 时，autoresearch 会直接 resolved——虚假解决。这是问题 4 在 verification 侧的复现，根因正是"没有强制"。

**方案**：在 Step 5h（读 verification_digest → decision）前插入 verification 深度检查，对称 execution_shallow_retry。

**新增 state.json.execution 字段**：

```json
{
  "execution": {
    ...,
    "verification_shallow_retries": { "Q1": 0 }
  }
}
```

- 初始化为 0 per question。max 1 per cycle。cycle retry 或 question resolved 时 reset 为 0。

**SKILL.md Step 5h 改动**（在"Extract verification_digest YAML block ... Apply decision table"之前插入）：

````markdown
#### h0. Verification depth check (before decision)

**行数预筛（cheap pre-filter，与 Step 5e Stage 1 对称）**：autoresearch 用 bash 获取 substantive 行数（**不加载文件内容到 context**）：

```bash
grep -cvE '^\s*$|^\s*#' notepads/[slug]/execution/Qn_VERIFICATION.md
```
````

- 若 substantive 行数 < 80 → verification_shallow（**fast path，跳过 judgment-worker**）：构造 generic verification_shallow_retry dispatch prompt "Your Qn_VERIFICATION.md has [N] substantive lines (minimum 80). Each verification sub-field (method_fidelity/step_completeness/assumption_audit/dependency_usage/fallback_applicability) requires concrete evidence quoting PLAN.md — not just PASS/FAIL labels. Conclusion verification requires per-claim computational/literature evidence per claim type." Re-dispatch verification worker (1 verification_shallow_retry, does NOT consume cycle/retries)
- 若 substantive 行数 ≥ 80 → **dispatch judgment-worker(verification-depth-judgment)** 做深度 rubric 评估（PASS/FAIL 标签无证据的 padding 仍可被三准则检测）。judgment-worker 返回 deficient_fields + improvement_guidance → autoresearch 据此构造 targeted verification_shallow_retry dispatch prompt

按 worker-prompts.md §MANDATORY VERIFICATION DEPTH 的判据检查内容深度（复用 execution_shallow 的三准则哲学——每个子字段须有可追溯证据，而非仅 PASS/FAIL 标签）：

- verification_produced（深度足够：每个子字段有具体证据、conclusion verification 按 claim 类型分层要求满足）→ proceed to decision (h)
- verification_shallow（经 judgment-worker 确认：子字段仅 PASS/FAIL 标签无证据）→
  - verification_shallow_retry dispatch 前设置 current_step="verification", current_retry_type="verification_shallow"
  - 备份 Qn_VERIFICATION.md → Qn_VERIFICATION_shallow1.md
  - dispatch prompt 注入 "PREVIOUS VERIFICATION WAS SHALLOW" + 具体子字段缺陷列表
  - 仍 shallow after 1 retry → 视为 verification 失败：若 reasoning 子字段 FAIL → retry_execution（consume cycle）；若 reasoning 全 PASS 但 conclusion 证据不足 → retry_execution（method 可能 flawed）

````

**current_retry_type 扩展值域**：新增 `"verification_shallow"`（改动 13 的值域从 `normal|shallow|environment` 扩展为 `normal|shallow|environment|verification_shallow`）。verification_shallow 的 Session Recovery 已纳入改动 13 的 shallow retry 统一恢复分支（与 execution_shallow 共享恢复逻辑，差异在降级路径）。

**edge-cases.md 改动**：

- §Verification Decision 判定规则表前新增 verification depth check 行
- §Verification Digest 解析失败处理 中补充：verification_shallow_retry 不计入 verification_retries（与 execution shallow_retry 对称：修复 dispatch 质量而非 execution 质量）
- 新增 jq：`jq '.execution.verification_shallow_retries.[Qn] += 1'` / reset on cycle retry or resolved

**worker-prompts.md 改动**：§MANDATORY VERIFICATION DEPTH（改动 8 已定义）补充一句"autoresearch 会检查上述深度要求是否满足，不满足的 verification 将被 re-dispatch（verification_shallow_retry）"——使 verifier 知晓 enforcement 存在。

**与 execution_shallow_retry 的对称性**：

| 维度                                      | execution_shallow_retry    | verification_shallow_retry                            |
| ----------------------------------------- | -------------------------- | ----------------------------------------------------- |
| 触发                                      | Qn_REASONING.md 浅薄       | Qn_VERIFICATION.md 浅薄                               |
| max per cycle                             | 1                          | 1                                                     |
| consume cycle                             | 否                         | 否                                                    |
| consume (execution/verification)\_retries | 否                         | 否（独立计数 verification_shallow_retries）           |
| 降级                                      | 仍 shallow → consume cycle | 仍 shallow → 视为 verification 失败 → retry_execution |
| reset                                     | cycle retry 或 resolved    | cycle retry 或 resolved                               |

### 改动 15：SKILL.md + edge-cases.md + digest-schemas.md — skipped_vague 接入

**问题**：改动 11 Option 2 引入 `skipped_vague` 作为新 question_status，但未接入 Step 5a 检查、state.json schema 注释、final_execution_digest 定义。

**SKILL.md Step 5a（原 Step 4a）扩展**（question_status 检查新增分支）：

```markdown
#### a. Check question_status

- "blocked" → skip
- "pending" → proceed
- "resolved" → skip (already completed)
- "failed" → skip (max retries exhausted)
- "skipped_vague" → skip (user chose to skip vague questions — distinct from blocked; no execution attempt)
````

**edge-cases.md §state.json.execution Schema 注释补充**：question_status 值域增加 `skipped_vague`（标注：由 coordinator Option 2 设置，autoresearch 只读不写）。

**digest-schemas.md §final_execution_digest 新增 section**（与 failed_questions / blocked_questions 平行）：

```yaml
skipped_vague_questions:
  - question: "[Qn]"
    vagueness_description: "[from paused digest pause_details]"
    method_reference: "[PLAN.md method 原文]"
```

**digest-schemas.md §Persistence 汇总格式 §EXECUTION.md 新增表**（与 Blocked Questions 表平行）：

```markdown
## Skipped Questions (Plan Vague)

| Question | Vagueness Description   | Method Reference   |
| -------- | ----------------------- | ------------------ |
| Q3       | [vagueness_description] | [method_reference] |
```

VERIFICATION.md 同理新增 "Skipped (Plan Vague)" 表：`Not verified (PLAN.md method too vague for execution)`。

**autoresearch 职责边界**：skipped_vague 由 coordinator 在 Option 2 re-dispatch 时通过 prompt 指示 autoresearch 设置；autoresearch 在 Step 5a skip 这些 question，在 Step 6 Final Output 时将它们列入 final_execution_digest 的 skipped_vague_questions section。

### 改动 16：edge-cases.md — all hard_blocked 显式终止路径

**问题**：D2 定义 hard_blocked → 不派发 executor。验收清单 21 说"不输出 paused digest"。但若所有 question 都是 hard_blocked，依赖 early abort（Step 5j 无 pending）触发。该路径未在改动或验收清单中显式声明。

**方案**：在 edge-cases.md §Execution-level Three-Stage Decision §Stage 2 末尾新增显式规则：

```markdown
**All questions hard_blocked 终止路径**：

若 Step 3 Gap classification 后所有 question 均为 hard_blocked（无 pending question）：

- 不进入 per-question loop，直接进入 Step 5 Final Output
- final_execution_digest: status=partial, resolved_questions=[], 所有 question 列入 blocked_questions (blocking_dependency = hard_blocked: [gap description])
- coordinator 收到后 advance_plan(completed) 呈现 partial results
- 这是 early abort 的特例（Step 5j 在第一个 question 前即触发：无 pending → early abort）
```

**验收清单新增**：所有 question 因 hard_blocked 阻断（无 pending）→ early abort → final_execution_digest status=partial，全部列入 blocked_questions。

### 改动 17：MCP server.py — phase_rollback 纳入 \_default_state()

**问题**：`_default_state()`（server.py:51-65）定义所有 state.json 默认字段。新增 `rollback_plans` / `rollback_context` 不在其中，`_read_state_safe()` 只补 `_default_state()` 已有 key，新字段不会自动补全，可能导致 coordinator 读取 `rollback_context` 时 KeyError 或 None 不一致。

**方案**：改动清单 MCP server.py 改动类型补充——`_default_state()` 新增：

```python
def _default_state() -> dict:
    return {
        "phase": "gate",
        "plan_number": "0",
        "conventions": {},
        "project_contract": {},
        "progress": {"completed_plans": [], "total_plans": 0, "rollback_plans": []},  # rollback_plans 新增
        "phase_commits": {},
        "execution_cycle": 0,
        "rollback_context": None,  # 新增
        "cross_phase_rollback_count": 0,  # 新增（跨阶段回退计数，上限 3）
        "audit": {...},
    }
```

- `rollback_plans` 放在 progress 下（与 completed_plans 平行，L179 已定义数组格式）
- `rollback_context` 顶层字段（L204 已定义为 `{"reason", "details", "timestamp"}` 或 None）
- `cross_phase_rollback_count` 顶层字段（见改动 [G3]，跨阶段回退计数器）

**`_read_state_safe()` 嵌套字段补全（必须显式处理）**：现有 L92-102 的 defaults 合并只对**顶层** key 做 `if key not in state` 补全。`rollback_plans` 嵌套在 `progress` 下，而旧 state.json 的 `progress`（dict，含 `completed_plans`）已存在，不会触发顶层补全分支，也不会进入 `if not isinstance(state.get("progress"), dict)` 分支（progress 是 dict）。因此必须显式补全 progress 内部字段。

`_read_state_safe()` 在现有 L92-102 合并逻辑之后追加嵌套补全：

```python
# 嵌套字段补全（progress.rollback_plans、cross_phase_rollback_count 等）
defaults = _default_state()
if isinstance(state.get("progress"), dict):
    prog_defaults = defaults["progress"]
    for key in prog_defaults:
        if key not in state["progress"]:
            state["progress"][key] = prog_defaults[key]
elif "progress" not in state:
    state["progress"] = defaults["progress"]
# 顶层新字段（rollback_context、cross_phase_rollback_count）已被上面顶层合并覆盖
```

这样保证：旧项目读 state.json 时，`progress.rollback_plans` 与顶层 `rollback_context` / `cross_phase_rollback_count` 都被自动补全为默认值。

**phase_rollback 实现补充**：phase_rollback 写 rollback_plans 时用 `state["progress"].setdefault("rollback_plans", []).append(entry)`（兜底，防字段缺失）。

### 改动 18：SKILL.md Step 5b — ENVIRONMENT.md re-read 覆盖所有 dispatch

**问题**：L608-612 Retry Loop-back step 1 说"Loop back to Step 5b"，暗示 5b 是 retry 专用。但正常 question 推进也经过 5b。若 Q1 触发 environment_retry 更新了 ENVIRONMENT.md，同 Wave 的 Q2 是否 re-read 取决于 5b 适用范围，未明确。

**方案**：SKILL.md Step 5b 标题与首行补充明确语义：

```markdown
#### b. Prepare execution context (执行于每个 question 的每次 dispatch — 正常推进与 retry 均经过此步)

1. Read PLAN.md §Execution Plan → Qn's method, tools, falsification test, Dependencies
2. For each dependency Qd ...
3. **Re-read ENVIRONMENT.md**（每次 dispatch 前都 re-read——前一个 question 的 environment_retry 可能已更新 ENVIRONMENT.md，本 question 必须看到最新环境状态）。若 Qn 需额外软件 → autoresearch supplements bash probe 并增量写入 ENVIRONMENT.md
```

**要点**：将原 Step 4b 第 3 点的"Read ENVIRONMENT.md"改为"Re-read ENVIRONMENT.md"，并明确"每次 dispatch 前"（含正常推进与 retry）。Retry Loop-back step 1 的"loop back to Step 5b"与此一致——5b 本就是每次 dispatch 的必经步骤。

### 改动 19：edge-cases.md — 统一"7"的推导与流程图

**问题**：L466/L606 声明"max 7 execution attempts"，推导为 2(shallow+env on cycle1) + 2(shallow+env on cycle2) + 3(cycle dispatch) = 7。但 worst-case 流程图（L708-722）只展示 5 次 dispatch，与"7"不一致。

**方案**：重写 worst-case 流程图为完整 7 次 local-executor dispatch 序列（verification dispatch 在流程中标注但不计入"7"）：

```
Maximum sequence for worst-case question (7 local-executor dispatches;
verification dispatches shown inline but counted separately):

  1. Cycle 1 dispatch [1] → execution_shallow →
  2. shallow_retry1 [2] → execution_failed → environment gap → self-build →
  3. environment_retry1 [3] → execution_produced → verification (FAIL) → retry_execution (cycle 2)
  4. Cycle 2 dispatch [4] (execution_shallow_retries/environment_retries reset to 0) → execution_shallow →
  5. shallow_retry1 [5] (post-reset) → execution_failed → environment gap → self-build →
  6. environment_retry1 [6] (post-reset) → execution_produced → verification (FAIL) → retry_execution (cycle 3)
  7. Cycle 3 dispatch [7] → execution_produced → verification (FAIL) →
     mark Qn failed (cycle limit exhausted)

  Shorter worst case (5 local-executor dispatches, only one retry type per cycle):
  1. Cycle 1 dispatch [1] → execution_shallow →
  2. shallow_retry1 [2] → execution_produced → verification (FAIL) → retry_execution (cycle 2)
  3. Cycle 2 dispatch [3] → execution_failed → environment gap → self-build →
  4. environment_retry1 [4] → execution_produced → verification (FAIL) → retry_execution (cycle 3)
  5. Cycle 3 dispatch [5] → execution_produced → verification (resolved/FAIL)

  注：verification_shallow_retry 发生在 verification dispatch 内部（Step 5h0），
  不计入上述 7 次 local-executor dispatch。每 cycle verification dispatch 最多
  1 normal + 1 verification_shallow_retry = 2 次，3 cycle 最多 6 次 verification dispatch。
```

edge-cases.md 保留上文完整推导作为**权威定义**（Stage 3 "Total execution attempt limit" 行）。SKILL.md 改动 3 Stage 3 中对应 bullet 替换为引用——`"Total execution attempt limit: each question max 7 local-executor dispatches (推导见 references/edge-cases.md §Execution-level Three-Stage Decision §Stage 3)"`，避免 SKILL.md 与 edge-cases.md 两处重复推导。

---

### 改动 20：debate-repair + digest-schemas + research.md + server.py — claim_impossible 分层修正（L1/L2/L3）+ phase_framing 回退能力

**问题**：改动 12 给 debate-repair 新增 claim_impossible 处理（"revise or retract the infeasible claim"），但 retract claim 会破坏 Gap→Question→Claim 推导链，且未定义"claim 不可修正"时的处理。根本问题：claim_impossible 意味着 debate 没审出的 plan 根本问题被 execution 暴露，需按问题层级（Claim/Question/Gap）分层修正。

**核心原则**：禁止删除 claim——必须保留 Question 与 Gap 映射。claim_impossible 的处理在三个层级中选一：

| 层级                      | 判据                                                       | 问题归属    | 修正动作                                                                                                                                  | 作用域                                             |
| ------------------------- | ---------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| **L1（Claim 过强）**      | Question 合理，但具体 claim 表述过强/不可达                | Claim 层    | 修订 claim 为可达版本 + 重写 falsification test（debate-repair Local repair 现有能力）                                                    | PLAN.md §Claims + §Acceptance Tests                |
| **L2（Question 误框架）** | Question 本身框架错误——Gap→Question 推导引入了不可能的需求 | Question 层 | 重设计 Question（新 falsification 三元素 + 新 method），**保留 Gap 映射**，framing_reasoning.md 加 staleness marker（保留原推导链供审计） | research_questions.md + PLAN.md（question 重设计） |
| **L3（Gap 错误）**        | Gap 不成立/被误识别——知识缺口不存在或被误判                | Gap 层      | debate-repair 标记 gap_reexamination_needed → coordinator 回退 phase_framing 重新识别 Gap                                                 | framing_reasoning.md + 级联                        |

**debate-repair Step 2 改动**（severity 表扩展）：execution-refine 类型按 vagueness_type 二分：

```markdown
| execution-refine (method_vague) | PLAN.md method 过于模糊不可执行 | Local/Structural repair: 展开为具体执行步骤 |
| execution-refine (claim_impossible) | claim 不可达，需分层修正 | 按 L1/L2/L3 分层处理（见下） |
```

**claim_impossible 分层判定流程**（debate-repair 收到 execution 回退的 vagueness_details 后执行）：

1. 审查 executor 提供的 evidence（数学矛盾/物理不可能的具体证据）
2. 判断问题层级：
   - 若 Question 的推导框架合理，仅 claim 表述过强 → **L1**：修订 claim 为可达版本（保留 Question），重写对应 falsification test。这是 Local repair
   - 若 Question 推导框架本身错误（Gap→Question 路径引入不可能需求）→ **L2**：重设计 Question（新 falsification + method），**保留对同一 Gap 的映射**。这是 Structural repair
   - 若 Gap 本身不成立/被误识别 → **L3**：debate-repair **不执行 definitive 修改**，在 digest 标记 `gap_reexamination_needed: true` + `affected_gap_id`，由 coordinator 回退 phase_framing

**L2 的 framing_reasoning.md 边界处理**（Structural repair 扩展）：

重设计 Question 时，debate-repair 在 framing_reasoning.md 对应 Gap section header 加 staleness marker：

```markdown
[execution_revealed: question derivation flawed — see PLAN.md for re-derived question, original derivation preserved above for audit]
```

- **保留原推导链**（供审计），仅标记其与新 Question 的对应关系过期
- 新 Question 仍映射到**同一 Gap**（Gap 是知识缺口，Question 是攻击方式；Question 错了换攻击方式，不换缺口）
- 依赖该 Question 的下游 question：现有 Dependency Consistency Verification（debate-repair Step 4）处理级联

**L3 的路由处理**（research.md / 改动 11 扩展）：

debate-repair digest 含 `gap_reexamination_needed: true` 时：

1. coordinator 调用 `phase_rollback(target_phase=phase_framing, target_plan_number=6, preserve_execution=true, rollback_reason=claim_impossible_L3, rollback_details={affected_gap_id, evidence, what_to_avoid})`
   - `preserve_execution=true`：保留与错误 Gap 无关的 resolved questions（它们可能不受影响）
   - phase_rollback 重置运行时字段（cycle/retries/wave），保留 resolved_conclusions + question_status
2. **不执行 git checkout**——L3 是系统发起的回退。framing 重新运行以 **section-preserving re-derivation 模式**（见下方 framing skill 改动）局部更新 framing_reasoning.md / research_questions.md，而非整文件覆盖。rollback_context 天然存活于 state.json（不被 git checkout wipe）
3. 重新 dispatch framing worker（mode=re_derive_gap），dispatch prompt 注入 rollback_context：
   ```
   rollback_context indicates Gap [affected_gap_id] is fundamentally flawed.
   Evidence: [executor 发现的具体矛盾]
   What to avoid: [原推导路径的错误]
   Re-derive ONLY Gap [affected_gap_id] and its dependent questions (downstream questions whose dependencies reference [affected_gap_id]).
   Preserve framing of other Gaps — do NOT redo them.
   Mode: re_derive_gap — read existing framing_reasoning.md as base, re-derive affected sections, regenerate global sections (Priority Justification / Dependency Graph / Execution Order), splice-write back.
   ```
4. framing 重新运行后，正常进入 audit_3 → debate → execution 流程

**framing skill 完整修改方案**（`.aether/skills/research-question-framing/SKILL.md`）：

L3 回退重新 dispatch framing 时，coordinator 在 dispatch prompt 中注入 `mode=re_derive_gap` + `affected_gap_id` + rollback_context。framing worker 读到 mode 参数后走 `re_derive_gap` 分支——**不整文件覆盖**，而是基于现有三文件（framing_reasoning.md / research_questions.md / PLAN.md）做局部重推导 + 全局段重生成 + splice 写回。`re_derive_gap` 是 framing skill 的第二运行模式，与默认模式（从零整文件写）并存，**改写 framing skill 的以下 6 个部分**（每部分给出默认模式与 re_derive_gap 模式的差异，实施者按此对照修改 framing skill 各处）：

**修改 1：Lifecycle Contract**（framing skill §Lifecycle Contract）

- 新增 **Mode 参数**：`mode = full_derive（默认） | re_derive_gap`。re_derive_gap 模式额外要求 Input 含 `affected_gap_id` + `rollback_context`（coordinator 注入）
- Output 变化：默认模式写完整 4 文件；re_derive_gap 模式**splice 更新** 3 文件（framing_reasoning.md / research_questions.md / PLAN.md），STATE.md 更新由 coordinator 负责（framing 不写）
- State transition 变化：默认模式 `phase_framing → phase_audit_3`（framing 调 advance_plan）；re_derive_gap 模式 framing **不调 advance_plan**（coordinator 在 framing 返回后控制 phase 推进到 audit_3）

**修改 2：Step 1 — Read Current State 增加 base 读取分支**

默认模式：读 ROADMAP.md / landscape_map.md / research_analysis.md / audits（全局输入）。

re_derive_gap 模式：除读 STATE.md 确认 phase + 读 rollback_context（affected_gap_id / evidence / what_to_avoid）外，**额外读三个 base 文件**：

1. `notepads/<slug>/framing_reasoning.md` — 识别 `## Gap → Question Mapping` 下 per-gap 段边界（`### Gap N` 开头到下一个 `### Gap` 或下一个 `## ` 结束）
2. `notepads/<slug>/research_questions.md` — 识别各 `## Question N` 段边界
3. `persistence/PLAN.md` — 识别 `### Claims` / `### Acceptance Tests` / `### Deliverables` / `### Execution Plan` / `### Environment Requirements` 各段及段内 bullet 边界

- **不全局重读 landscape_map**——仅必要时局部重读受影响 Gap 相关的 landscape excerpt（re_derive 是"原推导错了"需看证据重新推导，非重做 survey）

**修改 3：Step 2-5 — 局部重推导（仅受影响 Gap）**

默认模式：对所有选中 Gap 执行 Step 2（Select Gaps + Significance）/ Step 3（Solution Paths + Tractability）/ Step 4（Derive Question）/ Step 5（Falsification）。

re_derive_gap 模式：**仅对 [affected_gap_id] 执行 Step 2-5**，重生成该 Gap 的 6 个子段（Significance Argument / Solution Paths Survey / Tractability Argument / Assumptions Introduced / Inter-Question Dependencies / Derived Question + Falsification）。输入：受影响 Gap 在 base 中的现有 framing 段 + rollback_context（evidence + what_to_avoid）+ 局部 landscape excerpt。其他 Gap 段**原样保留——不重读、不修改**。新 Question **沿用原 question ID**（受影响 Gap 原为 Q2 则重设计后仍是 Q2，不重新编号）。

**修改 4：Step 6-7 — 级联 staleness 标记 + 全局段重生成 + splice 写回 framing 输出**

默认模式（Step 6-7）：Step 6 对所有 question 构造依赖图 + 拓扑排序；Step 7 整文件 write framing_reasoning.md + research_questions.md。

re_derive_gap 模式：

- **级联 staleness 标记**：若重设计后的 Question 改变了依赖边，对**直接下游** Gap 段（其 `#### Inter-Question Dependencies` 引用了受影响 Gap 的 question）加 staleness marker，插入到该下游 Gap 段标题之后：

  ```markdown
  ### Gap [downstream_id]: ...

  [downstream_recheck_needed: dependency on Gap [affected_gap_id] changed — Inter-Question Dependencies section may need re-validation. Original preserved for audit.]
  ```

  staleness marker 不删除原内容，仅提示 audit_3 优先审查。下游 Gap 的重新推导**不在本次 dispatch 内完成**——由 audit_3 决定是否需补 dispatch（与 framing 现有"retry max 1 for structural incompleteness"机制结合）

- **全局段重生成**：基于（重推导的受影响 Gap + 保留的其他 Gap）汇总，重生成 framing_reasoning.md 的三个全局段：
  - `## Priority Justification`（跨 Gap 比较矩阵——受影响 Gap 的 significance/tractability 可能变）
  - `## Dependency Graph`（含受影响 Gap 重设计 question 后的新边）
  - `## Execution Order`（Dependency Graph 的拓扑排序，可能改变 Wave 分配）
    `## Source Knowledge Base` 与 `## Unresolved Knowledge Gaps` 不受影响，原样保留

- **splice 写回**（用 edit 工具，**非整文件 write**）：
  - framing_reasoning.md：替换受影响 Gap 段（`### Gap [affected_gap_id]` 整段）+ 三个全局段；其余 Gap 段 + Source Knowledge Base + Unresolved Knowledge Gaps 原样保留
  - research_questions.md：替换受影响 Gap 对应的 `## Question [Qn]` 段（沿用原 ID）

**修改 5：Step 8 — PLAN.md splice 写回（与 framing 输出对称）**

默认模式（Step 8）：整文件 write PLAN.md（基于 framing_reasoning.md §Execution Order + §Derived Question 构造完整 Contract）。

re_derive_gap 模式：用 edit 工具对 PLAN.md 做**精确替换**，**非整文件重写**（整文件重写会导致未受影响 Gap 的 claim 措辞漂移、question 编号重排，破坏 resolved_conclusions 的 question ID 映射）。替换内容：

- `### Claims` 段：受影响 Gap 对应的 claim bullet（用新版本替换，其他 claim 原样保留——通过 `question: [Qn]` 字段定位对应 bullet）
- `### Acceptance Tests` 段：对应的 test bullet（绑定到受影响 Gap 的 claim）
- `### Deliverables` 段：绑定到受影响 Gap claim 的 deliverable（若有）
- `### Execution Plan` 段：**重生成整个 Wave 结构**（基于修改 4 的新 Dependency Graph 拓扑排序），替换整个 `### Execution Plan` 段（Wave 结构是跨 question 的，需整体重生成而非单 bullet 替换）。受影响 Gap 的 question 块（`**Qn: ...**`）用新 method/tools/falsification 替换；其他 question 块原样保留（沿用原 ID）
- `### Environment Requirements` 段：若受影响 Gap 的重设计引入新工具/依赖，增补对应 requirement bullet；否则原样保留
- 新 Question 沿用原 question ID，确保 PLAN.md 中 question→claim 映射与 resolved_conclusions 一致

**修改 6：Step 10-11 — State 更新跳过 + digest 扩展**

默认模式（Step 10-11）：Step 10 更新 STATE.md + 调 advance_plan；Step 11 输出默认 digest（`sub_phase: null`）。

re_derive_gap 模式：

- **Step 10 跳过 advance_plan**——framing 只更新 STATE.md 的 key decisions（记录"re_derive_gap for Gap [affected_gap_id]"），phase 推进由 coordinator 控制（framing 返回后 coordinator dispatch audit_3）
- **Step 9（Check Conventions）无需分支**——两种模式都执行（convention 一致性检查与推导模式无关）
- **Step 11 输出 re_derive_gap digest**（`sub_phase: re_derive_gap` + `re_derive_details`，schema 见下文 §framing digest 扩展）：

coordinator 读取 framing digest：`question_id_mapping_broken=true` 时，将 `orphaned_questions` 对应的 `state.json.resolved_conclusions` 条目标记为 `orphaned`（保留供审计但不参与新 execution），并提示 audit_3 优先审查。

**与 question ID 映射的兼容性**（preserve_execution=true 的兑现条件）：

- L2（重设计 Question，保留 Gap 映射）已在 framing_reasoning.md 加 staleness marker 保留原推导链——L3 re_derive_gap 模式（修改 3）读到 staleness marker 时识别该 Gap 曾被 L2 修改过，重推导时新 Question **沿用原 question ID**（如 Q2 仍是 Q2），不重新编号
- 若 re_derive_gap 发现受影响 Gap 的重设计导致 question **数量变化**（如合并/拆分），则 question ID 映射破坏——此时 framing digest 标 `question_id_mapping_broken: true` + 列出 `orphaned_questions`，coordinator 收到后将 resolved_conclusions 中受影响 question 标记为 `orphaned`（保留供审计但不参与新 execution），新 execution 从头跑受影响 Wave
- 正常情况（L3 是 Gap 误识别修正，question 结构通常变化不大）question ID 映射保持，resolved_conclusions 可继续参与 execution（已 resolved 的 skip）

**phase_rollback target 扩展**：`phase_framing`（index 6）作为合法回退目标加入 phase_rollback 的 target_phase 校验白名单。phase_rollback 实现中 `preserve_execution=true` 保留 resolved_conclusions + question_status 的逻辑（改动 7 已定义）适用于 L3 场景。

**debate-repair Integrity Rules 更新**（新增）：

- **claim_impossible 禁止删除 claim**——必须保留 Question 与 Gap 映射，通过 L1（修订 claim）/ L2（重设计 Question，保留 Gap 映射）/ L3（回退 framing）处理
- L2 重设计 Question 时，新 Question **必须映射到同一 Gap**（不创建新 Gap，不删除原 Gap）
- L3 不执行 definitive 修改（不碰 claims/acceptance tests），仅标记 gap_reexamination_needed

**digest-schemas.md 改动**（debate-repair repair digest 扩展，改动 12 的 execution_refine_details 细化）：

```yaml
  execution_refine_details:
    vagueness_type: method_vague | claim_impossible
    # method_vague: 展开为具体执行步骤（改动 12 已定义）
    # claim_impossible: 分层处理（本改动新增）
    claim_impossible_handling: null  # 仅 vagueness_type=claim_impossible 时非 null
    claim_impossible_handling:
      level: L1 | L2 | L3
      affected_gap_id: "[Gap id, L2/L3 必填]"
      action_taken: "[L1: claim revised to ... / L2: question re-derived, falsification redesigned / L3: gap_reexamination_needed]"
      gap_reexamination_needed: false  # true 仅 L3
```

**与改动 12 的关系**：本改动深化改动 12 的 claim_impossible 路径（分层 L1/L2/L3 + framing section-preserving re-derivation）。method_vague 路径不变（改动 12 已定义）。

**framing digest 扩展**（`re_derive_gap` 模式下 framing worker 的 PhaseResultDigest 新增字段，纳入 `.aether/skills/research-question-framing/SKILL.md` Step 11 digest schema）：

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

coordinator 读取 framing digest：`question_id_mapping_broken=true` 时，将 `orphaned_questions` 对应的 `state.json.resolved_conclusions` 条目标记为 `orphaned`（保留供审计但不参与新 execution），并提示 audit_3 优先审查。

---

### 改动 21：MCP server.py — health check 与 phase_rollback 兼容性

**问题**：现有 health check（server.py `_check_runtime`）用 advance_plan 做"前进→回退"往返测试。E1 确立"advance 只前进、rollback 只回退"后，回退腿应改用 phase_rollback，但 phase_rollback 会污染 rollback_plans 审计链，且 health_test 非合法 target_phase。

**方案**：health check 是合成往返测试（测 state.json 写路径），非真实回退——保持 advance_plan 往返（测试豁免），phase_rollback 仅做注册检查（不实际调用，避免审计污染）。

**server.py `_check_runtime` 改动**：

1. **advance_plan 往返保留**（现有 L1099-1119 不变）：测试 state.json 原子写读路径。注释补充：

   ```python
   # health check exemption: advance_plan round-trip tests write path only,
   # not a production rollback. Coordinator never uses advance_plan for
   # rollback in production (uses phase_rollback instead).
   ```

2. **新增 phase_rollback 注册检查**（替代往返测试 phase_rollback）：

   ```python
   # phase_rollback registration check (no round-trip — avoids rollback_plans pollution)
   rollback_tool = mcp._tool_manager._tools.get("phase_rollback")
   if rollback_tool and rollback_tool.parameters:
       checks["phase_rollback_registration"] = {
           "status": "pass",
           "method": "registration_check_only",
           "reason": "round_trip_avoided: rollback_plans_pollution",
       }
   else:
       checks["phase_rollback_registration"] = {
           "status": "fail",
           "failure_class": "tool_not_registered",
       }
       issues.append("phase_rollback tool not registered")
   ```

3. **health check 输出标注**：`phase_rollback_test` 项使用 `registration_check_only` method，与 `advance_plan_test` 的 `round_trip` method 区分，明确两者职责。

**设计原则**（与 E1 一致）：生产环境严格分离（advance 只前进、rollback 只回退）；测试环境豁免（advance_plan 往返测写路径，phase_rollback 仅注册检查不触发真实回退语义）。phase_rollback 的逻辑正确性（preserve/reset/审计）由单元测试保证，非 health check 职责。

---

### 改动 22：persistence/EXPERIENCE_LOG.md + server.py + research.md + phase-routing.md + phase-detail-tables.md — 跨回退教训档案

**问题**：git checkout 全量还原（checkpoint 回退场景）制造三层经验断层——摘要层（rollback_context 随 state.json 丢失）、证据层（executor 发现的矛盾随 notepads/execution/ 丢失）、教训层（从未存在专门存储）。重新跑 framing/analysis 时 worker 看到干净历史快照，可能重蹈覆辙推导出同样错误方案。

**方案**：EXPERIENCE_LOG.md —— 追加式、git-checkout-排除、自包含的教训档案。与 rollback_context（state.json 内的薄摘要 + 指针）分工：state.json 保持小（原子写），EXPERIENCE_LOG.md 承载详细教训链。

**位置**：`.aether/research/persistence/EXPERIENCE_LOG.md`

**核心属性**：

1. **追加式**（append-only）：每次回退追加一条 entry，不覆盖 → 累积多次尝试的教训链
2. **git-checkout-排除**：checkpoint 回退时 git checkout 排除 state.json + EXPERIENCE_LOG.md（见下文排除协议）
3. **自包含**：每条 entry 内嵌证据（不引用将被 wipe 的文件），仅用 commit SHA 指针指向完整日志（git 历史永久保留失败尝试的完整状态）

**entry 结构**：

```markdown
## Rollback [timestamp] — [source_phase] → [target_phase]

- rollback_id: [唯一 id，如 rollback-20260618-001]
- reason: claim_impossible (L3) | plan_vague | checkpoint_rejection | environment_blocked
- source_commit: [失败尝试的 git commit SHA — 完整状态可从 git 历史检索]
- failed_approach:
  - Question: [Qn]
  - Method: [PLAN.md method 原文摘要]
  - Claim: [失败的 claim 原文，若 claim_impossible]
- evidence: [executor/verification 发现的具体证据 — 内嵌，非文件引用]
  - 例："在 convention C 下，方程 X 蕴含 Y≠Z，与 claim 假设 Z=Y 矛盾"
- lessons_learned:
  - what_went_wrong: [推导链哪里错 — Gap→Question 或 Question→Claim]
  - what_to_avoid: [重推导时必须规避的假设/路径]
  - alternative_direction: [建议的修正方向]
- preserved_results: [若 preserve_execution=true，保留的 resolved questions 摘要；若 false，标 "none"]
```

**写入职责与时机**：

- **写入者**：coordinator（持有 autoresearch 的 paused digest pause_details 作为内容来源；checkpoint 场景持有用户反馈）
- **时机**：coordinator 调用 phase_rollback **之前**写入（确保教训在回退前已持久化）
- **内容来源**：
  - execution→debate 回退（改动 11）：autoresearch 输出的 paused digest pause_details（已含 vagueness_description / evidence / affected_questions）
  - L3 回退 framing（改动 20）：debate-repair digest 的 claim_impossible_handling + gap_reexamination_needed 上下文
  - checkpoint 回退（用户拒绝 plan）：用户反馈 + 当前 PLAN.md/DEBATE.md 状态摘要

**读取时机**（dispatch prompt 注入）：

- 重新 dispatch framing worker（L3 回退或 checkpoint 回退到 framing）：prompt 注入 "Read persistence/EXPERIENCE_LOG.md — 含前次失败尝试的教训链，重推导时必须规避文档记录的错误路径"
- 重新 dispatch analysis worker（checkpoint 回退到 analysis）：同理
- 重新 dispatch debate worker（execution→debate 回退）：debate-repair 需读取以了解前次 execution 失败的完整上下文（虽 execution notepads 在 preserve_execution=true 时已保留，EXPERIENCE_LOG 提供跨多次回退的累积视角）

**git checkout 排除协议**（更新 phase-routing.md §phase_checkpoint rollback + phase-detail-tables.md §Git Rollback Protocol）：

```bash
# checkpoint 回退（preserve_execution=false 场景）：排除 state.json + EXPERIENCE_LOG.md
git checkout <target_sha> -- .aether/research/ \
  ':(exclude).aether/research/persistence/state.json' \
  ':(exclude).aether/research/persistence/EXPERIENCE_LOG.md'
git add .aether/research/
git commit -m "research: rollback to phase_[target] (plan [N]) — EXPERIENCE_LOG preserved"
```

- state.json 排除：保留 phase_rollback 的语义化写入（plan_number/rollback_plans/rollback_context/rollback_details）
- EXPERIENCE_LOG.md 排除：保留累积教训链
- 其余文件（PLAN.md/DEBATE.md/notepads 等）正常还原

**注**：系统发起的回退（execution→debate 改动 11、L3→framing 改动 20）**不走 git checkout**——直接 phase_rollback + re-dispatch（worker 覆盖文件）。因此这些场景下 EXPERIENCE_LOG.md 天然存活，无需排除协议。排除协议仅用于 checkpoint 场景（用户发起的、需还原精确历史状态的回退）。

**server.py 改动**：

1. **PERSISTENCE_WHITELIST 更新**（L1378-1388）：新增 `EXPERIENCE_LOG.md` + `WORKFLOW_TERMINATION_REPORT.md`——否则 `validate_file_locations` 会将其标记为非白名单文件违规

   ```python
   PERSISTENCE_WHITELIST = {
        "STATE.md", "ROADMAP.md", "PLAN.md", "DIGESTS.md", "state.json",
        "EXECUTION.md", "VERIFICATION.md", "ENVIRONMENT.md", "DEBATE.md",
        "EXPERIENCE_LOG.md",  # 新增（改动 22）
        "WORKFLOW_TERMINATION_REPORT.md",  # 新增（跨阶段回退终止报告）
   }
   ```

2. **可选 MCP tool**：`append_experience_log(project_dir, entry_yaml)` —— atomic append 一条 entry 到 EXPERIENCE_LOG.md。供 coordinator 写入，避免 coordinator 用 bash 写大文件。若不新增 tool，coordinator 用 edit 工具 append（EXPERIENCE_LOG.md 在 file_scope 内）。

**rollback_context 与 EXPERIENCE_LOG.md 的分工**：

| 载体                             | 角色            | 内容粒度                                                      | 生命周期                             |
| -------------------------------- | --------------- | ------------------------------------------------------------- | ------------------------------------ |
| `rollback_context`（state.json） | 指针 + 最新摘要 | reason + details 摘要 + rollback_id 指向 EXPERIENCE_LOG entry | 单条（下次回退覆盖，仅保留最近一次） |
| `EXPERIENCE_LOG.md`              | 完整教训档案    | 内嵌证据 + lessons + commit SHA + 累积所有回退                | 追加式（累积所有回退，不覆盖）       |

framing/analysis worker 先读 rollback_context（知道最近一次为何回退），再读 EXPERIENCE_LOG.md（看完整教训链 + 历史模式）。

---

### 改动 23：新增 judgment-worker subagent + autoresearch 卸载重型文本判断

**问题**：autoresearch 内联执行所有文本判断（execution_shallow 判定、verification 深度判定、failure synthesis），最坏单 question ~16 次重型判断（读 200 行 Qn_REASONING.md + 应用 rubric）。上下文累积 6000+ 行文件内容，判断质量随 retry 深度衰减——这是问题 4（内容简略）的深层根因之一。

**方案**：新增 judgment-worker subagent，卸载"读大文件 + 应用 rubric + 返回结构化判定"的重型判断。autoresearch 保留编排判断（根因分类、路由决策、状态管理），其上下文只留结构化判定结果，可持续承载多 question / 多 retry 不衰减。

**新增 agent**：`.aether/agent/judgment-worker.md`

```yaml
---
description: Apply structured rubrics to research output files and return structured judgments
color: "#10B981"
mode: subagent
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

- judgment-worker **只读不写**——它返回结构化 YAML 判定作为最终消息，不写任何文件。权限系统显式授权 read/grep/glob/list + research-state 的只读工具（`get_state`/`get_progress`），**无 bash、无 write/edit、无 advance_plan/update_debate_state/update_audit_state 等写操作**——"只读"由权限系统精确强制（显式列举只读工具而非 `research_state_*` 通配符），不依赖 LLM 自我约束
- delegation_depth=0（叶子节点，不 dispatch further subagents）
- 行数统计通过 Read 工具完成（Read 返回行号前缀），不使用 bash

**三个判断任务模板**（worker-prompts.md 新增 §Judgment Worker Prompt Templates）：

**a. shallow-judgment（execution_shallow 判定，Step 5e Stage 1）**：

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

**b. verification-depth-judgment（Step 5h0，改动 14）**：

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
      - field: [method_fidelity | step_completeness | assumption_audit | dependency_usage | fallback_applicability]
        deficiency: [仅标签无证据 | 证据不足]
        detail: [具体缺什么]
    improvement_guidance: '[针对性改进指引，供 autoresearch 构造 verification_shallow_retry dispatch prompt]'
  "
)
```

**c. failure-synthesis（Step 5m）**：

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

**autoresearch dispatch 逻辑改动**（SKILL.md）：

| Step                                       | 改动前（内联）                                   | 改动后（dispatch judgment-worker）                                                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step 5e Stage 1（execution_shallow 判定）  | autoresearch 读 Qn_REASONING.md + 应用三准则     | **行数预筛**（bash `grep -cv`，< 100 行直接判 shallow 跳过 judgment-worker）→ ≥ 100 行 dispatch judgment-worker(shallow-judgment) → 读结构化判定 → 若 shallow 用 improvement_guidance 构造 shallow_retry prompt                       |
| Step 5h0（verification 深度检查，改动 14） | autoresearch 读 Qn_VERIFICATION.md + 应用 rubric | **行数预筛**（bash `grep -cv`，< 80 行直接判 shallow 跳过 judgment-worker）→ ≥ 80 行 dispatch judgment-worker(verification-depth-judgment) → 读结构化判定 → 若 shallow 用 improvement_guidance 构造 verification_shallow_retry prompt |
| Step 5m（failure synthesis）               | autoresearch 读备份 + 提炼 revision context      | dispatch judgment-worker(failure-synthesis) → 读 cycle_revision_context → 注入下轮 dispatch prompt                                                                                                                                    |

**行数预筛的两阶段设计**（execution_shallow / verification_shallow 共享）：

行数阈值（Qn_REASONING.md 100 行 / Qn_VERIFICATION.md 80 行）在**两个阶段**发挥作用，兼顾成本与准确性：

| 阶段                     | 执行者          | 手段                                                                                              | 行数未达标时                                                                           | 行数达标时                                                                                           |
| ------------------------ | --------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **预筛（cheap）**        | autoresearch    | bash `grep -cvE '^\s*$\|^\s*#'` 获取 substantive 行数（不加载内容到 context）                     | 直接判 shallow，构造 generic retry prompt（**跳过 judgment-worker dispatch**，省成本） | 进入第二阶段                                                                                         |
| **权威评估（accurate）** | judgment-worker | 读文件 + 应用三准则 rubric（Operational Specificity / Output Traceability / PLAN Correspondence） | 不适用（预筛已拦截）                                                                   | 判 produced/shallow，若 shallow 返回 deficient_steps + improvement_guidance（targeted retry prompt） |

**设计理由**：

- **预筛省成本**：对文档化的失败模式（如 28 行"两步模板"），行数预筛直接判定，省去 judgment-worker dispatch。autoresearch 用 bash `grep -cv` 获取行数，不加载文件内容到 context——零上下文膨胀
- **权威评估保准确性**：行数达标的文件可能含 padding（冗长但无实质的描述），judgment-worker 的三准则语义评估仍需执行。预筛的失效（padding 过线）不降低准确性，只降低效率
- **generic vs targeted retry prompt 的权衡**：预筛路径用 generic retry prompt（"每步需实质性推导"），judgment-worker 路径用 targeted retry prompt（列出具体 deficient steps）。generic prompt 对极端过短产出足够有效；对接近阈值的产出，judgment-worker 的 targeted 指引更精准

**成本量化**（补充用户要求）：

| 场景                                     | judgment-worker dispatch 次数/question                                                                       | 说明                                                           |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 正常（产出合格）                         | 1（verification-depth-judgment，行数预筛通过）                                                               | execution shallow 不触发（行数达标），仅 verification 深度检查 |
| execution shallow（行数不足，fast path） | 1（仅 verification-depth-judgment）                                                                          | execution shallow 被预筛拦截，跳过 shallow-judgment dispatch   |
| execution shallow（行数达标但 padding）  | 2（shallow-judgment + verification-depth-judgment）                                                          | padding 过预筛，judgment-worker 三准则检测出 shallow           |
| 最坏（多 cycle 多 retry）                | 每 cycle 最多 2（shallow-judgment + verification-depth-judgment）+ 1（failure-synthesis）= 3；3 cycle 最多 9 | judgment-worker 无状态只读，dispatch 开销有界                  |

对比无预筛设计（所有 shallow 判定都 dispatch judgment-worker）：正常场景无差异（产出合格时不 dispatch shallow-judgment）；shallow 场景预筛节省 1 次 dispatch/question。对 7-question 项目 + 全部 shallow 的最坏情况，预筛最多节省 7 次 dispatch。

**autoresearch 保留内联的判断**（不卸载）：

| 保留内联的判断                                                             | 理由                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| **行数预筛**（bash `grep -cv`，dispatch judgment-worker 前执行）           | 廉价（不加载内容到 context），对极端过短产出省去 dispatch                 |
| 根因分类（Stage 2：environment_missing/plan_vague/crash/claim_impossible） | 从 digest 字段判断，轻量，不需读大文件                                    |
| 路由决策（resolved/retry/failed/paused）                                   | 从结构化判定结果做编排决策，是 autoresearch 核心职责                      |
| 状态管理（cycle/retries/state.json/current_retry_type/pending_judgment）   | autoresearch 独占                                                         |
| shallow_retry/verification_shallow_retry dispatch prompt 构造              | 用 judgment-worker 返回的 improvement_guidance（或预筛 generic 模板）填充 |

**judgment-worker 失败处理（降级模式）**：

- judgment-worker dispatch 失败（task 超时/空返回）→ 重试 max 2 次
- 3 次失败 → autoresearch 退回**内联判断**（降级模式，在 digest 标注 `judgment_worker_unavailable: true`）。此时 autoresearch 直接读文件 + 应用三准则 rubric（行数预筛此时已无意义——行数达标的文件需 autoresearch 内联读内容做 rubric 判断）
- 降级模式确保 judgment-worker 不可用时系统仍能运行（但 autoresearch 上下文可能膨胀，质量可能下降）
- **注**：行数预筛（bash `grep -cv`）始终可用（不依赖 judgment-worker），但仅能拦截极端过短产出；行数达标的文件在降级模式下仍需 autoresearch 内联读内容评估

**与改动 13（current_retry_type）的关系**：judgment-worker 不修改 state.json（只读），不涉及 current_retry_type 的写入。**current_retry_type 只管 local-executor / verification worker 的 dispatch 上下文，不管 judgment-worker 的 dispatch**——judgment-worker 是在 local-executor/verification 返回**之后**才 dispatch 的（判断产出质量），此时 current_retry_type 已重置为 normal。无论判定来自 judgment-worker 还是内联降级判断，autoresearch 若据此决定 shallow_retry，才在**重新 dispatch local-executor 前**设 current_retry_type=execution_shallow（或 verification_shallow_retry 前设 verification_shallow）。即：judgment → 判定 → 决定 retry → 设 current_retry_type → dispatch worker。

**judgment-worker dispatch 崩溃恢复（`pending_judgment` 机制）**：

judgment-worker 是深度强制的质量门——若 dispatch 中途崩溃，恢复时 `current_retry_type=normal` + 产出文件存在，通用 Session Recovery 会跳过深度检查直接送 verification/decision，**静默绕过深度强制**（浅薄产出蒙混过关）。为闭合此缺口，引入 `pending_judgment` 字段标识 judgment dispatch 上下文：

**新增 state.json.execution 字段**：

```json
{
  "execution": {
    ...,
    "pending_judgment": null  // null | "execution_shallow" | "verification_depth" | "failure_synthesis"
  }
}
```

- `pending_judgment` 在 dispatch judgment-worker **之前**写入对应类型值，收到 judgment-worker 返回（成功或降级内联判断）后重置为 `null`
- judgment-worker 是**无状态只读**的——重读相同文件 + 应用相同 rubric 产生相同判定，因此崩溃后 re-dispatch 是幂等安全的
- Session Recovery **首先检查 `pending_judgment`**（优先级高于 current_retry_type 和 current_step 通用逻辑）：
  - `pending_judgment = "execution_shallow"` → 产出文件（Qn_REASONING.md + Qn_EXECUTION.md）已由 local-executor 写入（judgment 在 local-executor 返回后才 dispatch），re-dispatch judgment-worker(shallow-judgment) 重新判定深度，不直接送 verification
  - `pending_judgment = "verification_depth"` → Qn_VERIFICATION.md 已由 verification worker 写入，re-dispatch judgment-worker(verification-depth-judgment) 重新判定深度，不直接做 decision
  - `pending_judgment = "failure_synthesis"` → 非质量门（failure synthesis 仅注入下一 cycle 上下文，无强制语义），崩溃恢复时清除 `pending_judgment`，按 current_step 通用逻辑恢复（缺失 failure synthesis 上下文不影响正确性，只影响下一 cycle 质量——autoresearch 可在下一 cycle 的 judgment-worker 补偿）
  - `pending_judgment = null`（或字段缺失，向后兼容）→ 走 current_retry_type / current_step 通用逻辑（改动 13 现有流程不变）

**jq 操作**：

```bash
# dispatch judgment-worker 前设置
jq '.execution.pending_judgment = "execution_shallow"' state.json  # 或 "verification_depth" / "failure_synthesis"
# judgment-worker 返回后清除
jq '.execution.pending_judgment = null' state.json
```

**初始化**：`pending_judgment` 在 state.json.execution 初始化时设为 `null`（加入 edge-cases.md §Initialization 的 jq 命令）。

**与降级模式的关系**：若 judgment-worker dispatch 3 次失败 → autoresearch 降级内联判断。降级判断完成后同样清除 `pending_judgment=null`（降级判断在 autoresearch 进程内完成，无额外 dispatch 崩溃风险）。即：`pending_judgment` 只在"judgment-worker dispatch 挂起中"非 null，降级判断完成前 autoresearch 不会崩溃（它是内联执行）。

**health check skill_chain 更新**（server.py `_check_skill_chain`）：

- 新增 judgment-worker agent 检查：验证 `.aether/agent/judgment-worker.md` 存在
- 加入 skill_refs_map：`"autoresearch_judgment_worker": "judgment-worker"`

**收益/成本总结**：

- **收益（核心）**：autoresearch 上下文隔离——重型判断的文件读取（200 行 Qn_REASONING.md × 多次）移出 autoresearch 上下文，只留结构化判定（几十行）。直击 #1 风险（上下文膨胀致判断衰减），这是问题 4 深层根因
- **收益**：rubric 专注度——judgment-worker prompt 纯粹是 rubric + 目标文件，一致性高于 autoresearch 把判断当众多任务之一
- **收益**：信息无损——结构化判定（improvement_guidance/deficient_steps/cycle_revision_context）可直接用于构造 dispatch prompt
- **成本**：dispatch 开销——每次判断一次 task()。但任务轻量（读 1-2 文件 + rubric），tokens 有界。正常 case 每 question ~2 次，最坏 ~16 次（此时正是隔离价值最大时，用延迟换质量保全）
- **成本**：架构复杂度——新增 agent + 3 模板。但复用 local-executor/verifier 成熟模式，增量小

**结论**：收益 >> 成本，采用本设计。

---

## 改动影响矩阵

| 用户问题                                  | 解决方案                                                                                                 | 改动文件                                                                                |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 问题1：认为环境不存在而终止               | D1+D2（职责分层+Gap分类+环境自建）                                                                       | SKILL.md Step 3/4, worker-prompts.md Gap Classification                                 |
| 问题2：没有正确拉起subagent               | D2+D5（Gap不再阻断dispatch+三阶段判定）                                                                  | SKILL.md Step 3/5e, edge-cases.md                                                       |
| 问题3：遇到问题轻易放弃                   | D5+D3（根因分析+分类修复+回退debate机制）                                                                | SKILL.md Step 5e, edge-cases.md, research.md, debate-repair SKILL.md, digest-schemas.md |
| 问题4：reasoning/verification内容过于简略 | D4+D6+改动14（产出深度约束+shallow判定+verification深度约束**+verification_shallow_retry enforcement**） | worker-prompts.md, edge-cases.md, local-executor.md                                     |
| 持续性：retry 崩溃恢复                    | 改动13（Session Recovery retry 类型崩溃恢复 + current_retry_type 统一 + environment_retry 重新 probe）   | edge-cases.md, SKILL.md                                                                 |
| 持续性：状态默认值一致性                  | 改动17（\_default_state 同步 rollback_plans/rollback_context/cross_phase_rollback_count + 嵌套字段补全） | server.py                                                                               |
| 持续性：跨阶段回退无界循环                | phase_rollback step 3.5（cross_phase_rollback_count 计数 + 上限 3 终止 + 工作情况分析报告）              | server.py, research.md, persistence/WORKFLOW_TERMINATION_REPORT.md                      |
| 持续性：phase_rollback 原子写             | phase_rollback steps 3-9 操作内存 dict，step 10 唯一 `_write_state`（原子写，禁止逐 step 写盘）          | server.py phase_rollback 实现                                                           |
| 持续性：judgment-worker dispatch 崩溃恢复 | `pending_judgment` 机制（Session Recovery 最高优先级检查，re-dispatch judgment-worker 重新判定深度）     | edge-cases.md, judgment-worker.md, SKILL.md                                             |

---

## 实施顺序

1. **第一批**（解决过快终止，7 个改动）：改动 1-4 + 改动 7 + 改动 9 + MCP server.py phase_rollback（含改动 17 \_default_state 同步）
2. **第二批**（解决内容空洞，3 个改动）：改动 5-6 + 改动 8
3. **第三批**（解决回退debate机制，3 个改动）：改动 10-12
4. **第四批**（持续性/一致性补丁，11 个改动）：改动 13-23

第一批和第二批可合并实施（改动文件重叠度高）。第三批与第一/二批部分重叠（edge-cases.md 中已涉及 plan_vague 行），建议合并为一次实施。MCP server.py 的 phase_rollback 必须在第一批中实施——改动 11 (research.md routing) 依赖 phase_rollback 存在。

第四批与前三批强耦合（均在已改动文件上叠加），建议与第一/二/三批合并实施而非单独迭代——改动 13/14/19 依赖改动 7/8 已定义的字段与判据，改动 15 依赖改动 11，改动 20 深化改动 12 并复用改动 11 路由，改动 22 依赖改动 7(PERSISTENCE_WHITELIST)/改动 11(coordinator 写入)/改动 20(L3 场景)，改动 23 替换改动 3/14 的内联判断。跨阶段回退守卫（phase_rollback step 3.5 + `cross_phase_rollback_count` + 终止流程 + `WORKFLOW_TERMINATION_REPORT.md`）须与改动 7(phase_rollback) 同批实施——守卫是 phase_rollback 内置逻辑，不可分离。分开迭代会导致 edge-cases.md / SKILL.md / debate-repair / worker-prompts 被反复重写。推荐实施单元：(改动 1-12 + 改动 17 + 改动 21 + 跨阶段守卫) 一并落地 → (改动 13-16 + 改动 18-20) 作为同一文件的补丁层 → (改动 22-23) 作为架构增强层（涉及新增 agent + coordinator 路由更新，可独立验证）。

---

## 验收清单

1. autoresearch Step 3 Gap Check 不再直接阻断 executor dispatch——`auto_installable` gap 先尝试自建
2. autoresearch Step 4 环境自建使用 web search 搜索安装方法（含 retry 机制，最多 3 次搜索尝试），搜索失败时 reclassify 为 user_decision_needed，不依赖硬编码命令
3. autoresearch Step 4 安装失败时将受影响 question 标记为 blocked，coordinator 在 execution 结束后告知用户
4. §Isolation Strategy Classification 表的 gap 行**不再带 (critical)/(medium) 严重度标签**——统一为 `gap`，所有 gap 一律流入 §Gap Classification，由 Gap Classification（单一权威）决定 auto_installable/user_decision_needed/hard_blocked（改动 4）
5. autoresearch Step 5e 三阶段判定：shallow/environment retry 不消耗 cycle，各 max 1 per cycle（cycle retry 时 reset）
6. PLAN.md method 模糊时输出 paused digest（pause_reason=plan_vague_need_debate, vagueness_type=method_vague），claim 不可能时输出 paused digest（pause_reason=plan_vague_need_debate, vagueness_type=claim_impossible），不自行展开
7. coordinator 收到 plan_vague_need_debate paused digest → 请求用户确认回退 debate → phase_rollback(phase_debate, preserve_execution=true)
8. 回退 debate 时 phase_rollback 保留 execution sub-object（resolved_conclusions + question_status），重置运行时字段（cycle/retries/wave）
9. debate dispatch prompt 注入 vagueness_details 作为额外约束
10. debate-repair 新增 execution-refine severity 类型，根据 vagueness_type 选择修复策略：method_vague → 展开为具体执行步骤；claim_impossible → 按 L1/L2/L3 分层修正（改动 20，禁止 retract claim）
11. debate-repair 不修改已 resolved questions 的 claims/deliverables
12. debate-repair repair digest 新增 execution_refine_details 字段
13. Qn_REASONING.md 最低 100 行，每步有实质性 Method
14. Qn_EXECUTION.md 不允许只有 "Status: FAILED" 一行
15. Qn_VERIFICATION.md 最低 80 行，每子字段有详细证据而非 PASS/FAIL 标签。conclusion verification 按 claim 类型分层要求：computational claim 必须有 computational oracle；conceptual/qualitative claim 必须有 citation-backed reasoning chain
16. local-executor 不承担环境自建职责——只报告完整错误给 autoresearch
17. local-executor Step 8.5 partial execution documentation 确保失败上下文完整传递
18. state.json.execution 新增 execution_shallow_retries 和 environment_retries 计数器
19. digest-schemas.md paused digest pause_reason 值域新增 plan_vague_need_debate 和 environment_blocked_ask_user
20. user_decision_needed gap 部分阻断 → 标记受影响 question 为 blocked，其余继续执行；全部阻断（无 pending question）→ 输出 paused digest (pause_reason=environment_blocked_ask_user)
21. coordinator 对 environment_blocked_ask_user paused digest 的 3 种用户选项路由：安装后继续 → re-dispatch autoresearch；接受部分结果 → advance_plan(completed)；中止 → advance_plan(completed)
22. environment_impossible（硬件/软件物理不可行）→ 标记 question 为 blocked，不输出 paused digest（物理不可行无法通过用户操作解决）
23. claim_impossible 与 method_vague 在 pause_reason 中同属 plan_vague_need_debate，但通过 vagueness_type 区分：method_vague → debate-repair 展开具体步骤；claim_impossible → debate-repair 按 L1/L2/L3 分层修正（改动 20）
24. phase_rollback MCP 新增——统一处理所有回退（checkpoint 回退 + execution 回退），不再使用 advance_plan 做 plan_number 递减。rollback_reason 区分场景；rollback_details 携带结构化信息；rollback_plans 数组记录所有回退事件；rollback_context 保留最近一次回退信息供 coordinator 构造 re-dispatch prompt
25. edge-cases.md Safety Constraints 回退规则统一：preserve_execution=false 清除 execution sub-object；preserve_execution=true 保留 resolved_conclusions + question_status 但重置运行时字段。advance_plan 不再承担回退职责（coordinator 禁止使用 advance_plan 做 plan_number 递减）
26. 重新进入 phase_execution 时 autoresearch 从 Step 1 重新开始（不从断点继续）
27. Option 2 (skip vague questions) → skipped_vague question 在 final_execution_digest 和 persistence 汇总中单独列出（区别于 blocked）
28. shallow_retry dispatch prompt 由 autoresearch 灵活构造：识别具体 shallow steps，给出针对性改进指引（非固定模板）
29. web search retry 机制：最多 3 次搜索尝试，搜索失败 → reclassify gap 为 user_decision_needed
30. autoresearch 中新增 failure synthesis 步骤（Step 5m）：cycle retry 前读取前 cycle 的 verification + reasoning 备份，提炼为 cycle revision context 注入下一 cycle dispatch prompt
31. Session Recovery 读取 `current_retry_type`：shallow/verification_shallow retry 统一恢复分支（共享恢复逻辑，差异在降级路径），environment retry 独立分支——崩溃时不直接送 verification 或做 decision，而是重新 dispatch 对应 retry 类型或降级（改动 13）
32. `current_retry_type` 值域 `normal|shallow|environment|verification_shallow`，dispatch 前写入、返回后重置为 normal（改动 13+14）
33. environment_retry 崩溃恢复时**重新执行 Step 3 环境 probe**（bash 探测原 gap 对应工具/包是否可用）判断自建是否完成，**不依赖 ENVIRONMENT.md gaps**——崩溃可能发生在 install 之后、ENVIRONMENT.md 更新之前，读 gaps 会假阴性误判 blocked（改动 13）
34. Step 5h0 verification 深度检查：verification_shallow → 1 verification_shallow_retry（不消耗 cycle、不消耗 verification_retries），仍 shallow → 视为 verification 失败（改动 14）
35. verification_shallow_retry 备份 Qn_VERIFICATION.md → Qn_VERIFICATION_shallow1.md；dispatch prompt 注入 "PREVIOUS VERIFICATION WAS SHALLOW" + 子字段缺陷列表（改动 14）
36. state.json.execution 新增 `verification_shallow_retries[Qn]`，max 1 per cycle，cycle retry 或 resolved 时 reset（改动 14）
37. verification_shallow 判据复用 execution_shallow 三准则哲学（每个子字段须有可追溯证据）（改动 14）
38. Step 5a question_status 检查含 `skipped_vague → skip`（改动 15）
39. final_execution_digest + EXECUTION.md + VERIFICATION.md 含 skipped_vague_questions / "Skipped (Plan Vague)" 表（改动 15）
40. 所有 question hard_blocked（无 pending）→ early abort → final_execution_digest status=partial，全部列入 blocked_questions（改动 16）
41. `_default_state()` 含 `progress.rollback_plans=[]`、`rollback_context=None`、`cross_phase_rollback_count=0`；`_read_state_safe` 对**嵌套**字段 `progress.rollback_plans` 显式补全（非仅顶层 key 合并），避免旧 state.json 的 progress 已存在时嵌套新字段不被补全（改动 17）
42. Step 5b 每次 dispatch（正常推进与 retry）前 re-read ENVIRONMENT.md（改动 18）
43. worst-case 流程图与"7"推导一致：3(cycle1) + 3(cycle2) + 1(cycle3) = 7 local-executor dispatches；verification dispatch 另计（最多 6）（改动 19）
44. claim_impossible 禁止删除 claim——必须保留 Question 与 Gap 映射，按 L1(修订claim)/L2(重设计Question,保留Gap映射)/L3(回退framing) 分层处理（改动 20）
45. L2 重设计 Question 时，新 Question 映射到同一 Gap；framing_reasoning.md 加 staleness marker，保留原推导链供审计（改动 20）
46. L3（Gap 错误）→ debate-repair digest 标 gap_reexamination_needed=true → coordinator phase_rollback(phase_framing, preserve_execution=true) → 重新 dispatch framing（mode=re_derive_gap，注入 rollback_context，不执行 git checkout）（改动 20）
47. L3 回退 framing 时 framing worker 以 `re_derive_gap` 模式运行——读现有 framing_reasoning.md + research_questions.md + PLAN.md 三个文件作 base，仅重推导受影响 Gap 段（Step 2-5 输入：受影响 Gap 现有 framing 段 + rollback_context + 局部 landscape，非全局重读）+ 重生成三个全局段（Priority Justification/Dependency Graph/Execution Order）+ 下游 Gap 加 staleness marker + **三个文件均 splice 写回（含 PLAN.md splice：替换受影响 Gap 的 claim/test/deliverables bullet + 重生成 Execution Plan Wave 结构，非整文件重写，避免 claim 措辞漂移破坏 ID 映射）**。保留与错误 Gap 无关的 resolved questions（preserve_execution=true）（改动 20）
48. `re_derive_gap` 模式下新 Question **沿用原 question ID**（preserve_execution 兑现条件）；若 question 数量变化导致 ID 映射破坏 → framing digest 标 question_id_mapping_broken（framing digest `re_derive_details.question_id_mapping_broken`）+ 列出 orphaned_questions → resolved_conclusions 受影响 question 标 orphaned（改动 20）
49. debate-repair repair digest 含 execution_refine_details.claim_impossible_handling（level/affected_gap_id/action_taken/gap_reexamination_needed）（改动 20）
50. phase_rollback 接受 phase_framing 作为合法 target（改动 20）
51. health check 保持 advance_plan 往返测写路径（注释标注 health check exemption）；phase_rollback 仅做注册检查（registration_check_only，不实际调用，避免审计污染）（改动 21）
52. health check 输出区分 advance_plan_test (round_trip) 与 phase_rollback_registration (registration_check_only)（改动 21）
53. EXPERIENCE_LOG.md 位于 persistence/，追加式（append-only），每条 entry 含 rollback_id/reason/source_commit/failed_approach/evidence(内嵌)/lessons_learned/preserved_results（改动 22）
54. checkpoint 回退时 git checkout 排除 state.json + EXPERIENCE_LOG.md（排除协议）；系统回退（execution→debate / L3→framing）不走 git checkout，EXPERIENCE_LOG 天然存活（改动 22）
55. coordinator 在 phase_rollback 之前写入 EXPERIENCE_LOG entry（内容来源：paused digest pause_details / debate-repair claim_impossible_handling / 用户反馈）（改动 22）
56. 重新 dispatch framing/analysis/debate worker 时 prompt 注入"Read persistence/EXPERIENCE_LOG.md"（改动 22）
57. rollback_context（state.json）是薄摘要+指针，EXPERIENCE_LOG.md 是完整累积教训链——两者分工明确（改动 22）
58. PERSISTENCE_WHITELIST 含 EXPERIENCE_LOG.md（validate_file_locations 不误报）（改动 22）
59. judgment-worker subagent 只读不写——权限系统**显式列举只读工具**（`research_state_get_state`/`research_state_get_progress`，**不使用 `research_state_*` 通配符**——通配符会授予 advance_plan/update_debate_state 等写操作，违反只读约束），仅 read/grep/glob/list + 只读 MCP，无 bash、无 write/edit，返回结构化 YAML 判定（verdict/deficient_steps/improvement_guidance 等），delegation_depth=0（改动 23）
60. Step 5e Stage 1（execution_shallow）/ 5h0（verification depth）/ 5m（failure synthesis）改为 dispatch judgment-worker，autoresearch 用返回的结构化判定构造 retry dispatch prompt（改动 23）
61. autoresearch 保留内联：**行数预筛**（bash `grep -cv`）、根因分类（Stage 2）、路由决策、状态管理——不卸载编排判断（改动 23）
62. judgment-worker dispatch 失败 3 次 → autoresearch 降级内联判断（digest 标 judgment_worker_unavailable: true）；行数预筛始终可用（不依赖 judgment-worker）（改动 23）
63. health check skill_chain 含 judgment-worker agent 检查（验证 .aether/agent/judgment-worker.md 存在）（改动 23）
64. **跨阶段回退守卫**：phase_rollback step 3 递增 `cross_phase_rollback_count`（仅对**系统发起的回退**计数：rollback_reason ∈ {execution_vague, claim_impossible_L3}；用户发起的 checkpoint_rejection 不计入——用户多次拒绝 plan 是正常交互非 agent 困境），step 3.5 达上限 3 时返回 `terminated` 而非执行 step 4+ 回退；被守卫拒绝的那次 rollback_plans entry 标注 `"guarded": true`（与成功回退 entry 区分）。coordinator 收到 terminated 后终止整个 research workflow——advance_plan(completed) + 写入 `WORKFLOW_TERMINATION_REPORT.md`（含 rollback 历史/累积教训/状态快照/失败模式诊断/人工介入建议）+ 使用 question tool 向用户呈现报告核心结论，等待人工介入（不 re-dispatch）
65. judgment-worker 与 current_retry_type 的交互：current_retry_type 只管 local-executor/verification dispatch 上下文，不管 judgment-worker dispatch（judgment-worker 在 worker 返回后 dispatch，此时 current_retry_type 已 reset）；autoresearch 据 judgment 判定决定 retry 后，才在重新 dispatch worker 前设 current_retry_type（改动 23）
66. PERSISTENCE_WHITELIST 含 EXPERIENCE_LOG.md + WORKFLOW_TERMINATION_REPORT.md（validate_file_locations 不误报）
67. **rollback_reason 值域不含环境缺失 blocked**——环境缺失导致 question blocked 是 pause（不是 rollback）：所有 question 因 user_decision_needed 环境 blocked（无 pending）→ 输出 paused digest（pause_reason=environment_blocked_ask_user）→ coordinator 请求用户操作，**不调用 phase_rollback、不计入 cross_phase_rollback_count**（原 execution_all_blocked rollback_reason 行已删除——它与 D2/改动10/11 的 pause 语义矛盾）
68. **phase_rollback 原子性**：steps 3-9 全部操作内存中的 state dict，只有 step 10 `_write_state` 是唯一磁盘写入点（FileLock + json.dump + mv tmp 原子写，与 advance_plan 一致）。崩溃发生在 step 10 之前→state.json 未被修改→重跑 phase_rollback 即可。**禁止逐 step 写盘**（不得在 step 3/4/5/7/9 各自调用 jq 写 state.json）
69. **`pending_judgment` 机制**（闭合 judgment-worker dispatch 崩溃的深度强制缺口）：state.json.execution 新增 `pending_judgment`（`null | "execution_shallow" | "verification_depth" | "failure_synthesis"`），dispatch judgment-worker 前写入对应类型，收到返回后清除为 null。Session Recovery **优先检查 pending_judgment**（优先级高于 current_retry_type 和 current_step）：`execution_shallow`/`verification_depth` → re-dispatch 对应 judgment-worker 重新判定深度（judgment-worker 无状态只读，重 dispatch 幂等安全），不直接送 verification/decision；`failure_synthesis` → 非质量门，清除后走通用逻辑（改动 13+23）
70. judgment-worker 降级模式（3 次 dispatch 失败→内联判断）完成后同样清除 `pending_judgment=null`（降级判断在 autoresearch 进程内完成，无额外 dispatch 崩溃风险）
71. **行数预筛（两阶段设计）**：autoresearch 在 dispatch judgment-worker 前用 bash `grep -cvE '^\s*$\|^\s*#'` 获取 substantive 行数（不加载内容到 context）。Qn_REASONING.md < 100 行 / Qn_VERIFICATION.md < 80 行 → 直接判 shallow（fast path，跳过 judgment-worker dispatch），构造 generic retry prompt；行数达标 → dispatch judgment-worker 做三准则 rubric 评估（padding 仍可被检测）。预筛省成本，权威评估保准确性（改动 3+14+23）
