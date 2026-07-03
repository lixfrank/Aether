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
- **time budget** = per-question min/max 工作时间预算（默认 min=60min, max=1440min，可经 reset --min/--max 覆盖）
- **zone** = check_time_budget.py 判定的时间状态：`below_min` / `between` / `above_max`
- **Qn** = question identifier from PLAN.md

## Procedure

### Step 1: Read Plan & Determine Waves

1. Read `persistence/research_state.md` — 获取 Active Workdir、Questions/Claims（status/method/dependencies）、Human Directives（调度类指示）
2. Read `<workdir>PLAN.md` — extract §Execution Plan（per-Wave, method, tools, falsification test, Dependencies）
3. Determine Waves from PLAN.md §Execution Plan
4. Sort within Wave by tractability confidence (HIGH > MEDIUM > LOW)
5. 若 Human Directives 有调度类指示（优先做/暂缓/完成后暂停）: 调整 Wave 调度（见 §调度类 Human Directives）
6. 跳过 resolved/failed/blocked 的 question，只处理 open 的
7. 执行状态记录在 research_state.md 的 Questions/Claims status 字段

### Step 2: ENVIRONMENT.md 责任

execution worker 负责 `persistence/ENVIRONMENT.md`：

1. 启动时读 `persistence/ENVIRONMENT.md`（若存在）
2. 对照 PLAN.md environment_requirements，探测缺失信息（可用软件、Python 版本、库）
3. 自行安装所需软件（在项目 venv 内，如 uv pip install）
4. 增量更新 ENVIRONMENT.md（不覆盖已有信息，追加新发现）
5. 每个 question 执行前可重读 ENVIRONMENT.md（前一 question 可能更新了环境）

### Step 3: 执行原则（取代固定 workflow）

以下不是固定施工步骤，而是 agent 必须遵守的原则与必须做的事。
agent 按 Wave 顺序逐问题处理，每个 question 的处理方式由 agent 据情况灵活决定，
但必须满足以下约束。

## 执行

- 对每个 open question Qn（按 Wave 顺序）:
  - 读 PLAN.md §Execution Plan 获取 Qn 的 method, tools, falsification test
  - 依赖处理: 对每个 dependency Qd，读 `<workdir>execution/Qd_VERIFICATION.md` 获取完整 conclusion
    （无论 Qd 的结果来自原定计划还是 fallback，conclusion 都在 VERIFICATION.md 中）
    若 Qd failed + critical → Qn 不执行（在确定处理列表时已排除为 blocked）
  - 处理 Qn 前（首次或 re-examine）调 `check_time_budget.py <research_state.md_path> Qn reset`（开始/重置计时，见 §时间预算机制）
  - dispatch local-executor (delegation_depth: 0)，产出 `<workdir>execution/Qn_REASONING.md` + `Qn_EXECUTION.md`

## 文件验证

- 任何 subagent 产出后，验证输出文件存在且非空后再继续
  （check_artifacts 验证 Qn_REASONING.md + Qn_EXECUTION.md；check_verification 验证 Qn_VERIFICATION.md 非空 + 含 verdict）
  产出文件不合格 → 调 check_time_budget.py check 据 zone 决策（见 §时间预算决策）；
  重跑对应 subagent 时须调整 dispatch prompt（指出上次产出问题、要求实质内容），不得机械重复

## 验证

- dispatch research-verifier (delegation_depth: 0)，产出 `<workdir>execution/Qn_VERIFICATION.md`（含 verdict + evidence + 4 子项判定）

## 时间预算机制

每个 question 有独立的 min/max 工作时间预算，是"该 question 上还能试多久"的单一控制。check_time_budget.py 位于 `autoresearch/scripts/`，由 worker 经 bash 在执行期间直接调用（reset/check），不经 research-audit 流程（research-audit 是 post-phase 质量门 + 语义审计，不含时间检查）。

- **处理 Qn 前（首次或 re-examine）**：`uv run check_time_budget.py <research_state.md_path> Qn reset [--min M --max M]`（归零计时；M 为分钟，默认 60/1440；--min/--max 由脚本内部持久化供 check 读取）
- **每次 subagent 产出验证后（文件验证 或 verdict 验证）**：`uv run check_time_budget.py <research_state.md_path> Qn check`（返回 zone + action + remaining 时间余量）
- 据 zone 决策是否继续 retry（见 §时间预算决策）

## 时间预算决策

适用于**任何失败点**（文件验证不合格 / verdict FAIL/PARTIAL）——失败后调 check_time_budget.py check，据 zone 决策：

- **PASS**（仅 verdict 场景）→ Qn status 改 resolved, 更新 `ver` 字段指向 `<workdir>execution/Qn_VERIFICATION.md`, 写 conclusion 到 research_state.md（PASS 无论 zone 即完成）
- **失败**（文件验证不合格 / verdict FAIL/PARTIAL）→ 据 zone：
  - **below_min (must_continue)** — 不得停止。调整方法或 dispatch prompt 后重跑对应 subagent。
    即使 agent 自感无解，仍须探索至 min_time（最小时间控制必要探索时间）。不得机械重复相同尝试。
  - **between (self_judge)** — agent 自主判断能否找到正确道路（见 §自判）：
    - 有可行路径 → 重跑对应 subagent（修订方法 / 调整 prompt）
    - 无法找到正确道路 → 停止该问题，写问题分析，回传 needs_attention
  - **above_max (hard_stop)** — 无需自判，直接停止该问题，写问题分析，回传 needs_attention（最大时间控制工作成本）
- 需人类决策（如 critical dep 失败无 fallback）→ 写 Last Phase Result (status=needs_attention), 回传 needs_attention

"重跑对应 subagent"：check_artifacts 失败→重跑 local-executor；check_verification 失败→重跑 research-verifier；verdict FAIL/PARTIAL→重跑 local-executor。

## 自判（between 区失败时）

agent 在 between 区失败后**自主判断**能否找到正确道路解决该问题——主动寻找是否还有未试的尝试方向（不限于 PLAN.md 预设方法，可在工作过程中自主发现新方向）。

以下情形倾向停止（非 rigid 规则，agent 据情况权衡）：

- verification 指出根本性问题（claim 与物理/数学定律矛盾 / method 根本不适用）
- agent 自身判断没有额外的尝试方向

否则继续 retry（修订方法或尝试新方向）。

## 每 Wave 后 audit

- 每个 Wave 完成后，dispatch research-audit agent 检查跨问题一致性
  （同一 Wave 内 question 间的结论是否矛盾、是否基于一致的前提）
  发现矛盾 → 自修或 pause 问用户

## 终止

- 无 open question 时自然停止（全部 resolved/blocked）
- 时间预算超时（between 自判停止 / above_max 硬停）→ 立即暂停整阶段，写问题分析到 Last Phase Result（status=needs_attention），回传 needs_attention，不处理其他 question

## 硬约束

- MUST: 任何 subagent 产出后验证输出文件存在且非空（check_artifacts + check_verification）
- MUST: resolved claim 前确保 check_sources + check_verification 通过（引用有下载文件 + 验证记录含 verdict）
- MUST: 标记 question resolved 时更新 research_state.md Questions/Claims 的 `status` 为 resolved **并更新 `ver` 字段**指向 `<workdir>execution/Qn_VERIFICATION.md`（check_verification.py 据此验证）
- MUST: 处理 Qn 前（首次或 re-examine）调 `check_time_budget.py ... reset`，每次 subagent 产出验证后（文件验证或 verdict）调 `check_time_budget.py ... check`，据 zone 决策
- MUST: below_min 区任何失败时不得停止（须 retry 至 min_time，除非 PASS）；每次 retry 须调整方法或 dispatch prompt，不得机械重复
- MUST: between 自判停止 / above_max 硬停时，记录已试方法到 research_state.md 的 Failed Attempts（method + 失败原因 + 排除方向），写问题分析到 Last Phase Result（status=needs_attention），立即回传 needs_attention
- MUST: question failed 时记录到 research_state.md 的 Failed Attempts（method + 失败原因 + 排除方向）
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

1. Write `<workdir>EXECUTION.md` — phase 汇总（per-question 结果: resolved/failed/blocked, conclusion 摘要）
2. Write `<workdir>VERIFICATION.md` — phase 汇总（per-question 验证 verdict + evidence 摘要）
3. Update research_state.md: 推荐更新各 Qn status + Phase History 追加 execution ✓ + Failed Attempts 追加失败方法
   （agent 据发现可灵活更新其他节，不限于以上推荐；标记 resolved 时必须更新 `ver` 字段）
4. dispatch research-audit agent 做最终质量门（审汇总质量、跨问题一致性）
5. 更新 research_state.md 的 Last Phase Result 节 (phase=execution / status / summary / issues), 回传 status 信号 (completed | needs_attention)

**时间预算暂停（非正常完成）**：between 自判停止 / above_max 硬停时，跳过上述 1-4，直接写问题分析到 Last Phase Result（含：失败模式 / 已试方法 / verification 关键发现 / 建议方向），回传 needs_attention。已 resolved 的 question 结论仍保留在 research_state.md。
