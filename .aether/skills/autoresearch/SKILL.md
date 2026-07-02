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
- **cycle** = retry cycle (cycle 1 = first attempt, max 3). Each question has independent cycle counter.
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
  - dispatch local-executor (delegation_depth: 0)，产出 `<workdir>execution/Qn_REASONING.md` + `Qn_EXECUTION.md`

## 文件验证

- 任何 subagent 产出后，验证输出文件存在且非空后再继续
  （check_artifacts 验证 Qn_REASONING.md + Qn_EXECUTION.md；check_verification 验证 Qn_VERIFICATION.md 非空 + 含 verdict）
  产出文件不合格 → 重跑对应 subagent（max 2）

## 验证

- dispatch research-verifier (delegation_depth: 0)，产出 `<workdir>execution/Qn_VERIFICATION.md`（含 verdict + evidence + 4 子项判定）

## 据 verdict 决策

- PASS → Qn status 改 resolved, 更新 `ver` 字段指向 `<workdir>execution/Qn_VERIFICATION.md`, 写 conclusion 到 research_state.md
- FAIL/PARTIAL → 重跑 local-executor (cycle+1)
  - cycle < 3 → 重试
  - cycle = 3 → Qn status 改 failed, 记录到 research_state.md Failed Attempts
    （连续 3 次执行+验证仍未通过，表明当前方法可能存在 agent 自身难以发现和解决的
    深层问题——如方法本身的根本性缺陷、依赖结论的隐含矛盾等——需外部介入：
    人类调整方法或回退到 framing 重新框定问题）
- 需人类决策（如 critical dep 失败无 fallback）→ 写 Last Phase Result (status=needs_attention), 回传 needs_attention

## 每 Wave 后 audit

- 每个 Wave 完成后，dispatch research-audit agent 检查跨问题一致性
  （同一 Wave 内 question 间的结论是否矛盾、是否基于一致的前提）
  发现矛盾 → 自修或 pause 问用户

## 终止

- 无 open question 时自然停止（全部 resolved/failed/blocked）

## 硬约束

- MUST: 任何 subagent 产出后验证输出文件存在且非空（check_artifacts + check_verification）
- MUST: resolved claim 前确保 check_sources + check_verification 通过（引用有下载文件 + 验证记录含 verdict）
- MUST: 标记 question resolved 时更新 research_state.md Questions/Claims 的 `status` 为 resolved **并更新 `ver` 字段**指向 `<workdir>execution/Qn_VERIFICATION.md`（check_verification.py 据此验证）
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
