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
- `user_decision_needed`：需要用户安装/决策（如需要 sudo 的系统工具、需要用户修改源码）
- `hard_blocked`：物理不可行（如 GPU 不可用、uv 不可用且无 Python）

**理由**：

- `auto_installable` gap 不应阻断 executor dispatch——autoresearch 先尝试自建，成功后继续
- `user_decision_needed` gap 不应阻断整个 per-question 循环——将受影响 question 标记为 blocked，其余 question 继续执行。执行结束后 coordinator 告知用户需要补充的环境
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

新增 MCP tool `phase_rollback`，专门处理执行层回退（从 phase_execution 回退到 phase_debate）。与 `advance_plan` 的区别：

| 维度                 | advance_plan                     | phase_rollback                               |
| -------------------- | -------------------------------- | -------------------------------------------- |
| 语义                 | 前进到下一阶段                   | 回退到之前阶段                               |
| plan_number          | 递增                             | 可递减                                       |
| progress 记录        | 记录到 completed_plans           | 不记录到 completed_plans（回退不是"完成"）   |
| execution sub-object | 前进到 phase_execution 时创建    | preserve_execution=true 时保留（不清除）     |
| debate/audit init    | 进入 debate/audit phase 时初始化 | 回退到 debate 时重新初始化 debate sub-object |

`phase_rollback` 参数：

```python
def phase_rollback(
    target_phase: str,       # 目标 phase（如 phase_debate）
    target_plan_number: str, # 目标 plan_number（如 8）
    project_dir: str,
    preserve_execution: bool = True,  # 是否保留 execution sub-object
    commit_sha: str = "",
) -> dict[str, Any]:
```

实现逻辑：

1. 读取 state.json → 获取当前 phase 和 plan_number
2. 验证：target_plan_number 必须小于当前 plan_number（只允许向后回退）
3. 将当前状态记录到 `progress.rollback_plans`（新字段，与 completed_plans 分离）：`{"from_phase": current_phase, "from_plan": current_plan_number, "to_phase": target_phase, "to_plan": target_plan_number, "reason": "execution_vague"}`
4. 更新 phase 和 plan_number
5. 如果 preserve_execution=true → 保留 state.json.execution sub-object（不清除），但重置以下字段：
   - `current_cycle` → 重置为 1（新 method = 新起点）
   - `shallow_retries` → 重置所有为 0
   - `environment_retries` → 重置所有为 0
   - `verification_retries` → 重置所有为 0
   - `current_wave` → 重置为 null（autoresearch 从 Step 1 重新读 PLAN.md）
   - `current_question` → 重置为 null
   - `current_step` → 重置为 null
   - `question_status` 中已 resolved → 保留（skip）
   - `question_status` 中因 vagueness blocked → 改为 pending（debate-repair 细化后重新执行）
   - `question_status` 中 pending → 保留
6. 如果 preserve_execution=false → 清除整个 execution sub-object（与 advance_plan 前进行为一致）
7. 如果 target_phase=phase_debate → 重新初始化 debate sub-object（rounds_completed=0, escalate_topics=[], current_sub_phase=null）
8. 如果 commit_sha → 记录到 phase_commits
9. 写入 state.json
10. 返回 previous/current/progress 信息

**VALID_PHASES 限制**：当前 advance_plan 有 VALID_PHASES 列表校验。phase_rollback 的 target_phase 也必须在 VALID_PHASES 中。phase_debate (index 8) 是合法回退目标。

**health check 兼容性**：health check 用 advance_plan 做测试（前进 → 回退）。phase_rollback 也可以做类似测试，但需要注意 health check 不应使用 preserve_execution=true（测试场景不应保留真实 execution 数据）。

**与 phase_checkpoint 回退的区别**：

| 维度            | checkpoint 回退（现有机制） | execution 回退（新增机制）                                                                    |
| --------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| 触发时机        | 用户在 checkpoint 拒绝 plan | autoresearch 在 execution 中发现 plan 不可执行                                                |
| 回退原因        | 用户主观判断 plan 有问题    | executor 客观发现 method 无法执行                                                             |
| 回退目标        | phase_debate（已有机制）    | phase_debate（同目标，新增触发路径）                                                          |
| 回退操作        | advance_plan（前进语义）    | phase_rollback（回退语义，保留 execution sub-object）                                         |
| DEBATE.md 处理  | 保留，追加新 round          | 保留，追加新 round（相同）                                                                    |
| PLAN.md 处理    | 保留，基于当前修复          | 保留，基于当前修复（相同）                                                                    |
| execution 结果  | 无（尚未执行）              | 保留已 resolved questions 的结果                                                              |
| state.json      | 无特殊处理                  | preserve_execution=true：保留 resolved_conclusions + question_status，重置 cycle/retries/wave |
| debate 注入约束 | 用户反馈                    | vagueness_details（per-question 模糊描述 + executor 试图执行时遇到的困难）                    |

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
| shallow_retries/environment_retries                   | 重置为 0     | 新 method 不继承旧 method 的 retry 历史          |
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

**合理性论证**：

- `digest.status=failed` 是 local-executor 自己报告的内部状态，含义是"执行未完全成功但产出了部分内容"
- 这与 `task_result empty/no structured content`（execution_failed）不同——后者意味着 executor 完全崩溃，没有任何产出
- `digest.status=failed` 但 Qn_REASONING.md + Qn_EXECUTION.md 存在 → 说明 executor 做了实质性工作，只是部分步骤失败或部分 test 未通过
- 这些部分产出仍然有价值——verification 可以检验已完成部分的质量，识别哪些 claims 通过、哪些失败
- 将 partial output 送入 verification 比"丢弃部分结果 + 重试整个执行"更高效——verification 可以精确诊断失败原因，为 retry 提供方向

因此：digest.status=failed + 文件存在 → execution_produced（送入 verification）是合理的。它与"文件不存在 → execution_failed"形成互补覆盖。

---

## 改动清单

### 涉及文件

| 文件                                                       | 改动类型                                                                                                                                        |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `.aether/skills/autoresearch/SKILL.md`                     | 重构 Step 3 Gap Check + 新增 Step 4 环境自建 + 重构 Step 5e 为三阶段判定（原 Step 4e）                                                          |
| `.aether/skills/autoresearch/references/worker-prompts.md` | 新增 Gap Classification + 移除 Self-Build Installation Procedures + 新增产出深度约束 + 新增 verification 深度约束 + 新增 Partial Execution 子节 |
| `.aether/skills/autoresearch/references/edge-cases.md`     | 重构 Execution-level Failure Decision 为三阶段 + 新增 shallow/environment retry 计数器                                                          |
| `.aether/skills/autoresearch/references/digest-schemas.md` | 扩展 paused digest 格式 — 新增 plan_vague_need_debate pause_reason 类型                                                                         |
| `.aether/agent/local-executor.md`                          | 新增 partial execution 协议（不修改 Step 3 local strategy，不增加环境自建逻辑）                                                                 |
| `.aether/agent/research.md`                                | 新增 plan_vague_need_debate paused digest 路由处理 — 回退到 phase_debate                                                                        |
| `.aether/skills/debate-repair/SKILL.md`                    | 新增"execution 回退 repair"能力 — 处理来自 phase_execution 的 vague method 问题                                                                 |
| `.aether/mcp/research-state/server.py`                     | 新增 `phase_rollback` MCP tool — 支持从 phase_execution 回退到 phase_debate，保留 execution sub-object                                          |

### 改动间依赖矩阵

| 改动                            | 前置依赖                     | 说明                                                                                  |
| ------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------- |
| 改动 1 (Step 3 Gap Check)       | 无                           | 独立重构                                                                              |
| 改动 2 (Step 4 环境自建)        | 改动 1                       | Step 3 分类后 auto_installable gap 进入 Step 4                                        |
| 改动 3 (Step 5e 三阶段判定)     | 改动 7 (edge-cases 三阶段表) | SKILL.md 引用 edge-cases.md 的详细判定表                                              |
| 改动 4 (Gap Classification)     | 改动 1                       | 为 Step 3 分类提供详细规则表                                                          |
| 改动 5 (产出深度约束)           | 改动 3                       | shallow 检查依赖三阶段判定流程                                                        |
| 改动 6 (Partial Execution)      | 改动 5                       | partial execution 是 shallow 检查和深度约束的具体指导                                 |
| 改动 7 (edge-cases 三阶段)      | 改动 1 + 改动 4              | 三阶段判定需要 gap 分类和环境自建流程的完整定义                                       |
| 改动 8 (Verification 深度)      | 改动 3                       | verification 在 execution 后执行，深度约束嵌入 dispatch prompt                        |
| 改动 9 (local-executor partial) | 改动 5 + 改动 6              | local-executor partial execution 协议与产出深度约束配合                               |
| 改动 10 (digest-schemas)        | 改动 3                       | plan_vague paused digest 格式需要与三阶段判定中 Stage 2 的 plan_vague 路径一致        |
| 改动 11 (research.md routing)   | 改动 10                      | coordinator 路由处理需要 paused digest 格式定义                                       |
| 改动 12 (debate-repair)         | 改动 11                      | debate-repair 的 execution-refine 需要 coordinator 回退流程中注入的 vagueness_details |

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
- execution_shallow → autoresearch supplements depth requirements into dispatch prompt, re-dispatch local-executor (1 shallow_retry per question, does NOT consume cycle)
- execution_failed → proceed to Stage 2

Stage 2 — Root-Cause Analysis (for execution_failed only):
Autoresearch reads task_result + any partial local-executor output:

- Environment gap (tool/package missing, not caught in Step 3) → attempt bash self-build per Step 4 procedure. If self-build succeeds → update ENVIRONMENT.md, re-dispatch local-executor (1 environment_retry per question, does NOT consume cycle). If self-build fails → reclassify as user_decision_needed, output paused digest
- PLAN.md method too vague OR claim fundamentally impossible → output paused digest (pause_reason=plan_vague_need_debate, affected_questions, suggestion: re-enter phase_debate to refine execution plan or mark claim as infeasible). Does NOT consume cycle. Does NOT retry execution — design-level problem that execution-level retry cannot fix. Includes: (1) method lacks actionable specificity, (2) claim/falsification test contradicts mathematical/physical laws
- Local-executor crash/timeout → retry with simplified task scope. Consumes cycle
- Environment physically impossible (GPU unavailable, no Python runtime, no compilation toolchain) → mark affected questions as blocked in state.json.question_status (blocking_dependency = missing environment description). Other questions continue normally. Does NOT output paused digest for whole execution

Stage 3 — Cycle Decision:

- Only actions that consume cycles count toward the 3-cycle limit per question
- shallow_retry does NOT consume cycle (max 1 per question)
- environment_retry does NOT consume cycle (max 1 per question)
- plan_vague does NOT consume cycle (returns to debate)
- Max 1 shallow_retry + 1 environment_retry per question (each type independent)
- Execution cycle limit remains 3 (for actual execution attempts that consume cycles)
- **Total execution attempt limit**: each question has max 5 execution attempts (2 free: shallow_retry + environment_retry, 3 cycle-consuming: cycle 1/2/3)

Retry Loop-back Procedure:

After shallow_retry or environment_retry decision:

1. Loop back to Step 5d (dispatch local-executor) directly — do NOT re-run Step 5a-5c
2. Backup shallow/failed output before re-dispatch:
   - Qn_REASONING.md → Qn_REASONING_shallow1.md or Qn_REASONING_env1.md (for diagnostic reference, NOT for cycle backup)
   - Qn_EXECUTION.md → Qn_EXECUTION_shallow1.md or Qn_EXECUTION_env1.md
3. Update state.json via jq:
   - Increment: `jq '.execution.shallow_retries.[Qn] += 1'` or `jq '.execution.environment_retries.[Qn] += 1'`
   - Set current_step: `jq '.execution.current_step = "execution"'`
4. Supplement dispatch prompt with retry context:
   - shallow_retry: "PREVIOUS OUTPUT WAS SHALLOW — depth requirements not met. You MUST produce substantive derivation for each PLAN.md method step (≥ 100 lines reasoning, ≥ 50 lines execution). Previous shallow output is saved as [Qn]\_REASONING_shallow1.md for reference — do NOT repeat the same shallow pattern"
   - environment_retry: "ENVIRONMENT GAP RESOLVED — missing [tool/package] has been installed. Re-attempt full execution using the now-available tool. Previous failed output is saved as [Qn]\_REASONING_env1.md for reference"
5. After simplified-task cycle-consuming retry (crash/timeout → Stage 2 → simplified scope → cycle retry):
   - Loop back to Step 5d with simplified task scope
   - After simplified task completes and produces diagnostic insights → dispatch full-task execution (consumes a new cycle)
   - Simplified task insight MUST be injected into full-task dispatch prompt: "Previous simplified execution for [Qn] revealed: [insights from simplified run]. Use these insights to guide full execution"

Reset rules:

- shallow_retries[Qn]: reset to 0 on cycle-consuming retry or question resolved
- environment_retries[Qn]: reset to 0 on cycle-consuming retry or question resolved

### 改动 4：references/worker-prompts.md — 新增 §Gap Classification（替换原 §Isolation Strategy Classification 中的硬编码 gap 处理）

**位置**：§Isolation Strategy Classification 表之后

**新增内容**：

```markdown
### Gap Classification

After environment probe, autoresearch classifies each discovered gap into one of three categories:

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

**删除内容**：原 §Self-Build Installation Procedures 整节删除（原计划中的硬编码 bash 命令表格）。

**Step 编号全局更新**：worker-prompts.md 第 3 行 "Step 4d (local-executor) and Step 4g (verification subagents)" → 更新为 "Step 5d (local-executor) and Step 5g (verification subagents)"。所有引用原 Step 4/5 的地方统一更新为新编号 Step 5/6。

### 改动 5：references/worker-prompts.md — 重构 §Local-Executor Prompt Template 产出深度约束

**位置**：§Local-Executor Prompt Template 的 `MANDATORY: You MUST write TWO output files:` 之后

**新增内容**：

```markdown
MANDATORY CONTENT DEPTH REQUIREMENTS:

1. Qn_REASONING.md depth requirements:
   - MUST contain a substantive derivation step for EACH method step in PLAN.md Execution Plan for Qn
   - Each step MUST include: (1) Intention (what this step achieves per PLAN.md), (2) Method (the concrete computation/derivation/operation performed — NOT just "inspected" or "checked"), (3) Divergence (if method diverges from PLAN.md), (4) Assumption introduced (if any new assumption)
   - The Method field in each step MUST describe a concrete operation that produces a new finding or result — "inspection" and "check" steps without producing new information are NOT sufficient
   - If a step cannot be fully executed due to environment/dependency gaps → write partial execution results. Document: what was attempted, what partially succeeded, and the specific gap's impact on THIS step (NOT a blanket "environment gap" for all steps)
   - NEVER collapse multiple incomplete steps into a single "environment gap" statement
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

| Condition                                                                                                                                                                                   | Decision           | Next action                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| task_result empty/no structured content                                                                                                                                                     | execution_failed   | Proceed to Stage 2 (Root-Cause Analysis)                                                                                               |
| Qn_REASONING.md + Qn_EXECUTION.md not exist                                                                                                                                                 | execution_failed   | Proceed to Stage 2                                                                                                                     |
| Qn_REASONING.md + Qn_EXECUTION.md exist, content depth sufficient (reasoning ≥ 100 lines, each step has substantive Method, execution has concrete artifacts per step)                      | execution_produced | Proceed to verification dispatch (Step 5f-g)                                                                                           |
| Qn_REASONING.md + Qn_EXECUTION.md exist, content depth insufficient (reasoning < 100 lines, or steps lack substantive derivation, or execution has only "Status: FAILED" without artifacts) | execution_shallow  | autoresearch supplements depth requirements into dispatch prompt, re-dispatch local-executor (1 shallow_retry, does NOT consume cycle) |
| digest.status=failed (partial output with substantive content)                                                                                                                              | execution_produced | Proceed to verification dispatch — partial output still has verifiable value                                                           |

**Why digest.status=failed → execution_produced**: `digest.status=failed` means local-executor did substantive work but some steps/tests failed. Unlike execution_failed (no output at all), partial output can still be verified — verification identifies which claims pass and which fail, providing precise diagnosis for retry direction. Discarding partial results and retrying from scratch is less efficient than verifying what exists and retrying only the failed parts.

### Stage 2 — Root-Cause Analysis (for execution_failed only)

Autoresearch reads task_result + any partial local-executor output to classify root cause:

| Root Cause Category                                                                                                                                                               | Action                                                                                                                                                                                                                                                                           | Cycle consumption                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Environment gap (tool/package missing, not caught in Step 3)                                                                                                                      | Attempt bash self-build per Step 4 procedure. If succeeds → update ENVIRONMENT.md, re-dispatch local-executor (1 environment_retry, does NOT consume cycle). If fails → reclassify gap as user_decision_needed, mark affected questions as blocked in state.json.question_status | environment_retry: does NOT consume cycle (max 1) |
| PLAN.md method too vague OR claim/falsification test fundamentally impossible (local-executor cannot determine concrete actions, OR claim contradicts mathematical/physical laws) | Output paused digest (pause_reason=plan_vague_need_debate). Suggest coordinator re-enter phase_debate to refine execution plan or mark claim as infeasible. Does NOT retry execution — design-level problem                                                                      | Does NOT consume cycle (returns to debate)        |
| Local-executor crash/timeout                                                                                                                                                      | Retry with simplified task scope (reduce complexity, narrow scope)                                                                                                                                                                                                               | Consumes cycle                                    |
| Environment physically impossible (GPU unavailable when required, no Python runtime at all, no compilation toolchain)                                                             | Mark affected questions as `blocked` (blocking_dependency = missing environment description). Other questions continue normally. Include in final_execution_digest → coordinator informs user after execution completes                                                          | N/A (blocked, not terminal for whole execution)   |

### Stage 3 — Cycle Decision

- Only actions that consume cycles count toward the 3-cycle limit per question
- shallow_retry: max 1 per question, does NOT consume cycle (fixes dispatch quality)
- environment_retry: max 1 per question, does NOT consume cycle (fixes environment)
- plan_vague: does NOT consume cycle (returns to debate, not an execution failure)
- Execution cycle limit remains 3 (for actual execution attempts that consume cycles)
- Each retry type is independently counted — using shallow_retry does not reduce available environment_retry
- **Total execution attempt limit**: each question has max 5 execution attempts (2 free: shallow_retry + environment_retry, 3 cycle-consuming: cycle 1/2/3)

### Retry Loop-back Procedure

After shallow_retry, environment_retry, or simplified-task retry decision:

1. Loop back to Step 5d (dispatch local-executor) directly — do NOT re-run Step 5a-5c
2. Backup previous output before re-dispatch:
   - shallow_retry: Qn_REASONING.md → Qn_REASONING_shallow1.md, Qn_EXECUTION.md → Qn_EXECUTION_shallow1.md
   - environment_retry: Qn_REASONING.md → Qn_REASONING_env1.md, Qn_EXECUTION.md → Qn_EXECUTION_env1.md
   - cycle retry (existing): Qn_REASONING.md → Qn_REASONING_cycle[N].md, etc. (per existing backup procedure)
3. Update state.json via jq:
   - shallow_retry: `jq '.execution.shallow_retries.[Qn] += 1 | .execution.current_step = "execution"' state.json`
   - environment_retry: `jq '.execution.environment_retries.[Qn] += 1 | .execution.current_step = "execution"' state.json`
   - cycle retry: `jq '.execution.current_cycle += 1 | .execution.verification_retries.[Qn] = 0 | .execution.shallow_retries.[Qn] = 0 | .execution.environment_retries.[Qn] = 0 | .execution.current_step = "execution"' state.json`
4. Supplement dispatch prompt with retry context:
   - shallow_retry: "PREVIOUS OUTPUT WAS SHALLOW — depth requirements not met. You MUST produce substantive derivation for each PLAN.md method step (≥ 100 lines reasoning, ≥ 50 lines execution). Previous shallow output saved as [Qn]\_REASONING_shallow1.md for reference — do NOT repeat the same shallow pattern"
   - environment_retry: "ENVIRONMENT GAP RESOLVED — missing [tool/package] has been installed. Re-attempt full execution using the now-available tool. Previous failed output saved as [Qn]\_REASONING_env1.md for reference"
5. Simplified-task cycle-consuming retry (crash/timeout → Stage 2 → simplified scope):
   - Autoresearch decides simplified scope autonomously — reduce method steps, narrow verification range, simplify computation
   - After simplified task completes with diagnostic insights → dispatch full-task execution (consumes a new cycle)
   - Simplified task insight MUST be injected into full-task dispatch prompt: "Previous simplified execution for [Qn] revealed: [insights from simplified run]. Use these insights to guide full execution"

Reset rules:

- shallow_retries[Qn]: reset to 0 on cycle-consuming retry or question resolved
- environment_retries[Qn]: reset to 0 on cycle-consuming retry or question resolved

### New state.json fields

Add to state.json.execution schema:

```json
{
  "execution": {
    ... (existing fields) ...,
    "shallow_retries": {
      "Q1": 0
    },
    "environment_retries": {
      "Q1": 0
    }
  }
}
```
````

- shallow_retries[Qn]: initialized to 0 per question. Incremented on each shallow_retry. Max 1. Reset to 0 on cycle retry or question resolved.
- environment_retries[Qn]: initialized to 0 per question. Incremented on each environment_retry attempt. Max 1. Reset to 0 on cycle retry or question resolved.

Jq operations for new fields:

```bash
# Initialize new fields (append to existing initialization command):
jq '.execution.shallow_retries = {} | .execution.environment_retries = {}' state.json

# Increment shallow_retries for Qn:
jq '.execution.shallow_retries.[Qn] += 1' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Increment environment_retries for Qn:
jq '.execution.environment_retries.[Qn] += 1' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json

# Reset both on cycle retry or question resolved:
jq '.execution.shallow_retries.[Qn] = 0 | .execution.environment_retries.[Qn] = 0' .aether/research/persistence/state.json > .aether/research/persistence/state.json.tmp && mv .aether/research/persistence/state.json.tmp .aether/research/persistence/state.json
```

````

### Safety Constraints Update (edge-cases.md)

当前 edge-cases.md §Safety Constraints 中有：

> "Rollback to earlier phase: execution sub-object is entirely cleared (question IDs may change), no interaction with audit sub-object"

新增例外规则：

> **例外**：当 `phase_rollback(target_phase=phase_debate, preserve_execution=true)` 被调用时，execution sub-object 不会被清除。phase_rollback 保留 execution sub-object 但重置运行时字段（current_cycle=1, shallow_retries=0, environment_retries=0, verification_retries=0, current_wave=null, current_question=null, current_step=null），并将因 vagueness blocked 的 question_status 改为 pending。保留 resolved_conclusions 和 resolved/pending/failed/user_decision_needed_blocked 的 question_status。

> 此例外仅适用于 `phase_rollback(preserve_execution=true)` 的场景。`advance_plan` 正常前进时仍然遵循原规则（前进到 completed phase 时 execution sub-object 被清除）。

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

**扩展为**（新增 plan_vague_need_debate 类型）：

```yaml
pause_reason: "[fallback_failed_ask_user / critical_dep_failed / max_retries_exhausted / plan_vague_need_debate]"
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

| 维度             | 现有 paused digest                      | plan_vague_need_debate paused digest                       |
| ---------------- | --------------------------------------- | ---------------------------------------------------------- |
| pause_reason     | 3 种（fallback/dep/retries）            | 新增 plan_vague                                            |
| user_options     | 3 通用选项（skip/assumption/abort）     | 3 专用选项（回退debate/跳过模糊问题/abort）                |
| 核心信息         | failed_question + failure_summary       | vague_questions + vagueness_description + method_reference |
| coordinator 路由 | 请求用户决策 → re-dispatch autoresearch | 请求用户确认回退 → phase_rollback(phase_debate)            |

### 改动 11：research.md (coordinator) — 新增 plan_vague_need_debate 路由处理

**位置**：§Digest processing 的 Status routing 表 + §用户决策恢复

**当前 Status routing 表**：

| Digest status | Coordinator action                      |
| ------------- | --------------------------------------- |
| completed     | advance_plan(completed)                 |
| partial       | advance_plan(completed)                 |
| paused        | 请求用户决策 → re-dispatch autoresearch |

**扩展为**：

| Digest status | pause_reason                                 | Coordinator action                                                                             |
| ------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| completed     | N/A                                          | advance_plan(completed) → present results                                                      |
| partial       | N/A                                          | advance_plan(completed) → present partial results                                              |
| paused        | fallback_failed / critical_dep / max_retries | 请求用户决策 → re-dispatch autoresearch (现有机制不变)                                         |
| paused        | plan_vague_need_debate                       | **新增路由** → 请求用户确认回退 debate → phase_rollback(phase_debate, preserve_execution=true) |

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
     Same as existing re-dispatch mechanism. Inject user decision "Skip [vague questions], accept partial results" into re-dispatch prompt. autoresearch marks vague questions as blocked and continues with remaining questions.

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

execution 回退到 debate 后，如果用户在后续 checkpoint 又拒绝，可以再次回退到 debate（使用现有 checkpoint 回退机制）。Round counter 继续递增，不重置。每次回退允许最多 3 更多 rounds（cumulative，与 checkpoint 回退规则相同）。

### 改动 12：debate-repair/SKILL.md — 新增"execution 回退 repair"能力

**位置**：Step 2 §Assess Repair Scope & Impact 的 severity 表 + Step 3 §Execute Repair 的 repair 模式列表

**新增 severity 类型**（在现有 Local/Structural/Exploratory 之后）：

| Severity             | Criteria                                                                                                                                                                                         | Repair Scope                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Execution-refine** | Problem originates from phase_execution rollback — PLAN.md method description is too vague for executor to determine concrete actions; executor has reported specific difficulty with the method | Expand vague method into concrete step-by-step execution instructions with specific tools, commands, inputs, and expected outputs per step. Add corresponding concrete Acceptance Tests. Ensure Environment Requirements cover the refined method. Do NOT modify resolved questions' claims |

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

## 改动影响矩阵

| 用户问题                                  | 解决方案                                               | 改动文件                                                                                |
| ----------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| 问题1：认为环境不存在而终止               | D1+D2（职责分层+Gap分类+环境自建）                     | SKILL.md Step 3/4, worker-prompts.md Gap Classification                                 |
| 问题2：没有正确拉起subagent               | D2+D5（Gap不再阻断dispatch+三阶段判定）                | SKILL.md Step 3/5e, edge-cases.md                                                       |
| 问题3：遇到问题轻易放弃                   | D5+D3（根因分析+分类修复+回退debate机制）              | SKILL.md Step 5e, edge-cases.md, research.md, debate-repair SKILL.md, digest-schemas.md |
| 问题4：reasoning/verification内容过于简略 | D4+D6（产出深度约束+shallow判定+verification深度约束） | worker-prompts.md, edge-cases.md, local-executor.md                                     |

---

## 实施顺序

1. **第一批**（解决过快终止，7 个改动）：改动 1-4 + 改动 7 + 改动 9 + MCP server.py phase_rollback
2. **第二批**（解决内容空洞，3 个改动）：改动 5-6 + 改动 8
3. **第三批**（解决回退debate机制，3 个改动）：改动 10-12

第一批和第二批可合并实施（改动文件重叠度高）。第三批与第一/二批部分重叠（edge-cases.md 中已涉及 plan_vague 行），建议合并为一次实施。MCP server.py 的 phase_rollback 必须在第一批中实施——改动 11 (research.md routing) 依赖 phase_rollback 存在。

---

## 验收清单

1. autoresearch Step 3 Gap Check 不再直接阻断 executor dispatch——`auto_installable` gap 先尝试自建
2. autoresearch Step 4 环境自建使用 web search 搜索安装方法，不依赖硬编码命令
3. autoresearch Step 4 安装失败时将受影响 question 标记为 blocked，coordinator 在 execution 结束后告知用户
4. autoresearch Step 5e 三阶段判定：shallow/environment retry 不消耗 cycle
5. PLAN.md method 模糊或 claim 不可能时输出 paused digest（pause_reason=plan_vague_need_debate），不自行展开
6. coordinator 收到 plan_vague_need_debate paused digest → 请求用户确认回退 debate → phase_rollback(phase_debate, preserve_execution=true)
7. 回退 debate 时 phase_rollback 保留 execution sub-object（resolved_conclusions + question_status），重置运行时字段（cycle/retries/wave）
8. debate dispatch prompt 注入 vagueness_details 作为额外约束
9. debate-repair 新增 execution-refine severity 类型，细化模糊 method 为具体执行步骤
10. debate-repair 不修改已 resolved questions 的 claims/deliverables
11. debate-repair repair digest 新增 execution_refine_details 字段
12. Qn_REASONING.md 最低 100 行，每步有实质性 Method
13. Qn_EXECUTION.md 不允许只有 "Status: FAILED" 一行
14. Qn_VERIFICATION.md 最低 80 行，每子字段有详细证据而非 PASS/FAIL 标签。conclusion verification 按 claim 类型分层要求：computational claim 必须有 computational oracle；conceptual/qualitative claim 必须有 citation-backed reasoning chain
15. local-executor 不承担环境自建职责——只报告完整错误给 autoresearch
16. local-executor Step 8.5 partial execution documentation 确保失败上下文完整传递
17. state.json.execution 新增 shallow_retries 和 environment_retries 计数器
18. digest-schemas.md paused digest pause_reason 值域新增 plan_vague_need_debate
19. user_decision_needed gap 不输出 paused digest——标记受影响 question 为 blocked，其余继续执行
20. 每个 question 最大总执行尝试次数 = 5（2 free + 3 cycle-consuming）
21. shallow/environment retry loop-back 到 Step 5d，补充 prompt 变化，备份浅薄/失败输出
22. coordinator 在 execution 结束后告知用户 user_decision_needed gaps 的环境需求
23. environment_impossible（硬件/软件物理不可行）→ 标记 question 为 blocked，不输出 paused digest
24. claim_impossible 合并到 plan_vague_need_debate（统一回退 debate 处理）
25. phase_rollback MCP 新增——execution 回退 debate 使用 phase_rollback(preserve_execution=true)，不使用 advance_plan
26. edge-cases.md Safety Constraints 新增 phase_rollback 例外：preserve_execution=true 时不清除 execution sub-object
27. 重新进入 phase_execution 时 autoresearch 从 Step 1 重新开始（不从断点继续）
