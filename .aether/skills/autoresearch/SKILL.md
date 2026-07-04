---
name: autoresearch
owner: research
description: |
  逐问题执行管理器。按 PLAN.md 依赖图逐问题执行与验证，据验证结果决策。
  由 research-worker 调用。
  产出 <workdir>execution/Qn_*.md + <workdir>EXECUTION.md + <workdir>VERIFICATION.md。
---

# AutoResearch — 逐问题执行管理器

按 PLAN.md 依赖图逐问题执行与验证，据验证结果决策。

## Lifecycle Contract

**Input**: `<workdir>PLAN.md` + `persistence/research_state.md`（Questions/Claims 状态）

**Output** (MUST write all):

1. `<workdir>execution/Qn_REASONING.md` — per-question 推理
2. `<workdir>execution/Qn_EXECUTION.md` — per-question 执行结果
3. `<workdir>execution/Qn_VERIFICATION.md` — per-question 验证报告
4. `<workdir>EXECUTION.md` — phase 汇总
5. `<workdir>VERIFICATION.md` — phase 汇总

**MUST NOT**: Modify PLAN.md. Skip verification for any question.
（人类指示修改 PLAN.md method 由 primary agent 在 dispatch 前处理，execution worker 运行时 PLAN.md 已反映修改）

## Terminology

- **Wave** = topologically sorted dependency batch (from PLAN.md §Execution Plan)
- **Qn** = question identifier from PLAN.md

## Procedure

### Step 1: Read Plan & Determine Waves

1. Read `persistence/research_state.md` — 获取 Active Workdir、Questions/Claims（status/method/dependencies）、Human Directives（调度类指示）
2. Read `<workdir>PLAN.md` — extract §Execution Plan（per-Wave, method, tools, falsification test, Dependencies）
3. Determine Waves from PLAN.md §Execution Plan
4. Sort within Wave by tractability confidence (HIGH > MEDIUM > LOW)
5. 若 Human Directives 有调度类指示（优先做/暂缓/完成后暂停）: 据指示调整 Wave 调度。若指示与依赖冲突（如"优先做 Q3"但 Q3 依赖未满足），拒绝并解释
6. 读每个 question 的 status，判断哪些需要处理。已 resolved 的跳过；其他据 status 和上下文判断是否需要执行

### Step 2: ENVIRONMENT.md 责任

execution worker 负责 `persistence/ENVIRONMENT.md`：

1. 启动时读 `persistence/ENVIRONMENT.md`（若存在）
2. 对照 PLAN.md environment_requirements，探测缺失信息（可用软件、Python 版本、库）
3. 自行安装所需软件（在项目 venv 内，如 uv pip install）
4. 增量更新 ENVIRONMENT.md（不覆盖已有信息，追加新发现）
5. 每个 question 执行前可重读 ENVIRONMENT.md（前一 question 可能更新了环境）

### Step 3: 执行原则

以下不是固定施工步骤，而是 agent 必须遵守的原则与必须做的事。
agent 按 Wave 顺序逐问题处理，每个 question 的处理方式由 agent 据情况灵活决定，
但必须满足以下约束。

## 执行

对每个需要处理的 question Qn（按 Wave 顺序）:

- 读 PLAN.md §Execution Plan 获取 Qn 的 method, tools, falsification test
- 依赖处理: 对每个 dependency Qd，读 `<workdir>execution/Qd_VERIFICATION.md` 获取 conclusion。
  据 conclusion 内容和 Qd 的状态判断当前 question 能否继续——Qd 有可用 conclusion 则用作前提；
  Qd 未解决且是关键依赖则判断是否有替代路径，没有则暂停说明情况
- 处理 Qn 前调 `uv run check_time_budget.py <research_state.md_path> Qn reset`（开始计时，可选 `--min M --max M` 覆盖默认 60/1440 分钟）
- dispatch local-executor，产出 `<workdir>execution/Qn_REASONING.md` + `Qn_EXECUTION.md`

## 文件验证

- 任何 subagent 产出后，验证输出文件存在且非空后再继续
  （check_artifacts 验证 Qn_REASONING.md + Qn_EXECUTION.md + Qn_VERIFICATION.md 存在非空；
  check_verification 在标记 resolved 后验证 ver 路径指向的验证文件有效）
  产出文件不合格 → 重跑对应 subagent（调整 dispatch prompt 指出上次产出问题，不得机械重复）

## 验证

- dispatch research-verifier，产出 `<workdir>execution/Qn_VERIFICATION.md`（含 verdict + evidence + 4 子项判定）
- 每次 subagent 产出后调 `uv run check_time_budget.py <research_state.md_path> Qn check` 获取已用时间

## 时间预算

每个 question 有 min/max 工作时间预算（默认 min=60min, max=1440min，可经 reset --min/--max 覆盖）。
check_time_budget.py 位于 `autoresearch/scripts/`，由 worker 经 bash 在执行期间直接调用（reset/check），不经 research-audit 流程。

- 处理 Qn 前调 `reset` 开始计时
- 每次 subagent 产出后调 `check` 获取已用时间
- 在 min 时间之前，不要因为失败而停止——你还没有充分探索
- 接近 max 时间时，如果仍然没有进展，暂停并告诉人类你尝试了什么
- 之间则据你对问题和失败原因的理解自行判断是否继续

## 据 verdict 决策

- PASS → Qn 标 resolved，更新 `ver` 字段指向 `<workdir>execution/Qn_VERIFICATION.md`，写 conclusion 到 research_state.md
- 不是 PASS → 读 verdict 的失败原因和 evidence，判断：
  - 有未试的方向或可调整的方法 → 重跑 local-executor（调整 prompt 指出问题）
  - 根本性问题（方法不适用 / claim 与已知定律矛盾）→ 暂停（见 §暂停）
  - 依赖结论不可用 → 判断是否影响当前 question，决定继续/跳过/暂停
- 当你停止处理某个 question 且未将其标为 resolved 时，将已试方法和失败原因记入 research_state.md 的 Failed Attempts

## 暂停

当你无法在某个 question 上继续推进时：

1. 已试方法和失败原因记入 Failed Attempts
2. 写问题分析到 Last Phase Result（status=needs_attention）：失败模式 / 已试方法 / verification 关键发现 / 建议方向
3. 回传 needs_attention

## Question Status

- `resolved` = 已验证（必须有 ver 字段指向验证文件，check_verification.py 会检查）
- 其他 status 由你自行选择准确描述问题状态的标签（如 open/partial/failed/infeasible/...）
- 原则：不得将未验证的结果标为 resolved

## 每 Wave 后 audit

- 每个 Wave 完成后，dispatch research-audit agent 检查跨问题一致性
  （同一 Wave 内 question 间的结论是否矛盾、是否基于一致的前提）
  发现矛盾 → 自修或暂停问用户

## 终止

- 无需处理的 question 时自然停止
- 时间预算超时暂停 → 回传 needs_attention

## 硬约束

- MUST: 任何 subagent 产出后验证输出文件存在且非空（check_artifacts）；标记 resolved 后验证 ver 路径有效（check_verification）
- MUST: resolved claim 前确保 check_sources + check_verification 通过（引用有下载文件 + 验证记录含 verdict）
- MUST: 标记 question resolved 时更新 research_state.md 的 `status` 为 resolved **并更新 `ver` 字段**指向 `<workdir>execution/Qn_VERIFICATION.md`（check_verification.py 据此验证）
- MUST: 处理 Qn 前调 `uv run check_time_budget.py ... reset`，每次 subagent 产出后调 `uv run check_time_budget.py ... check`
- MUST: 停止处理某个 question 且未标 resolved 时，记录已试方法到 research_state.md 的 Failed Attempts（method + 失败原因 + 排除方向）
- MUST: 每 Wave 完成后 dispatch research-audit agent 检查跨问题一致性
- MUST: execution 完成后做最终 audit + 写 EXECUTION.md + VERIFICATION.md 汇总
- MUST: 按 PLAN.md 中的 Acceptance Tests 验证，不得简化或降级测试标准（framing 在 PLAN.md 中为每个 question 给出明确的、符合研究要求的 Acceptance Tests，execution 须严格按此验证）
- FORBIDDEN: 跳过验证（任何 question 都必须经 research-verifier 验证后才能标 resolved）
- FORBIDDEN: 修改 PLAN.md（含 claims / method / Acceptance Tests；method 字段修改由 primary agent 在 dispatch 前处理）

## 调度类 Human Directives

Read research_state.md 的 Human Directives 中调度类指示:

- "优先做 Q3" → 若 Q3 依赖已满足，调整 Wave 顺序将 Q3 提前；依赖未满足 → 拒绝并解释
- "Q5 暂缓" → Q5 标 deferred, 不执行
- "Q3 完成后暂停" → Q3 resolved 后写 Last Phase Result (status=needs_attention), 回传 needs_attention

（方法修改类指示如"Q2 方法改为 X"不在此处理——由 primary agent 在 dispatch 前修改 PLAN.md + 记 Failed Attempts）

## Final Output

1. Write `<workdir>EXECUTION.md` — phase 汇总（per-question 结果 + conclusion 摘要）
2. Write `<workdir>VERIFICATION.md` — phase 汇总（per-question 验证 verdict + evidence 摘要）
3. Update research_state.md: 更新各 Qn status + Phase History 追加 execution ✓ + Failed Attempts 追加失败方法
   （标记 resolved 时必须更新 `ver` 字段）

## 质量门与回传（worker 协议）

完成上述 Final Output 1-3 后，质量门与回传由 worker 统一执行，不在本 skill 重复：

- 质量门按 `research-audit` skill §1 runbook（worker 跑 scripts + dispatch research-audit agent 审 `EXECUTION.md` + `VERIFICATION.md`，方向见该 skill §2 execution 汇总行 + 自修）
- 回传按 `research-worker` Worker Return 协议写入 Last Phase Result（phase=execution / status / summary / issues）+ 回传 status 信号 (completed | needs_attention）
- §每 Wave 后 audit 是执行期内部跨问题一致性检查，不替代本节 phase 结束后的 §1 质量门

**时间预算暂停（非正常完成）**：跳过上述 Final Output 1-3 及质量门，直接写问题分析到 Last Phase Result（含：失败模式 / 已试方法 / verification 关键发现 / 建议方向），回传 needs_attention。已 resolved 的 question 结论仍保留在 research_state.md。
