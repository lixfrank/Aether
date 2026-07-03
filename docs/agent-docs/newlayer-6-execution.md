# newlayer-6: autoresearch skill 重构

> 原 `.aether/skills/autoresearch/SKILL.md` (268行) + 3 refs (digest-schemas 315 + edge-cases 408 + worker-prompts 421 = 1144行)
> → skill name 保留 `autoresearch`（不改名），精简
> 对应设计文档 §6（执行：结构化但可灵活调度）

> **后续增强**：per-question 固定轮数终止（cycle max 3 + 文件验证 max 2）已被时间预算机制替换，见 [newlayer-6.1](newlayer-6.1-time-budget.md)（min/max 工作时间 + check_time_budget.py reset/check + 三档 zone 决策）。本文档中涉及 cycle / max 2 的描述以 newlayer-6.1 为准。

---

## 修改原因与设计依据

**大方向**：旧 autoresearch（1412行）有 shallow-retry 双层机制、judgment-worker、多类型计数器、failure-synthesis，这些是给"verifier 有时产出浅薄内容"层层打补丁的产物。新设计精简为：worker 按 PLAN.md 依赖图逐问题执行与验证，verifier 独立判定，worker 据 verdict 决策。
**设计依据**：design doc §6（执行：结构化但可灵活调度）、§6.2（verifier 即 judge）、§6.4（灵活调度+依赖安全）、§13 决策 6/9。
**具体决策理由**：

- skill name 保留 `autoresearch`：改名无功能收益，反增不必要的引用同步负担
- 删 judgment-worker / shallow-retry 双层 / 多类型计数器 / failure-synthesis：verifier 是独立 subagent 天然提供执行者之外的判断，verifier 产出结构化 verdict，结构 checker 验证非空有 verdict 即可（design doc §6.2）
- 保留 Wave/依赖检查/重试/终止：agent 不会自然做这些（实测频繁停下问"是否继续"、丢失多步追踪），结构化执行是工程必需（design doc §6.1）
- M5 从固定 workflow 改为原则+必须做的事：注明 agent 必须做什么（验证产出文件、据 verdict 决策）和以什么方式做（dispatch local-executor/verifier），而非僵化的施工步骤
- ENVIRONMENT.md 由 execution worker 负责：启动时读已有 ENVIRONMENT.md，探测缺失信息，自行安装所需软件，增量更新
- 每 Wave 后 audit：检查跨问题一致性，避免后续 Wave 基于错误前提执行
- 人类指示中的方法修改不属 execution 职责：primary agent 在 dispatch 前处理（修改 PLAN.md + 记 Failed Attempts），execution 只管调度类指示

---

## 删除

### 文件级删除

| 文件                           | 行  | 理由                                                                                                           |
| ------------------------------ | --- | -------------------------------------------------------------------------------------------------------------- |
| `references/digest-schemas.md` | 315 | 复杂 digest schema + persistence 汇总格式，简化为 Last Phase Result + research_state.md                        |
| `references/edge-cases.md`     | 408 | shallow-retry 双层 / 多类型计数器 / failure-synthesis / state.json operations，全部删除                        |
| `references/worker-prompts.md` | 421 | local-executor/verifier prompt 模板 + ENVIRONMENT.md 格式 + judgment-worker prompt 模板，精简后内联到 SKILL.md |

### SKILL.md 内段落删除

| 段落                                                                                                             | 理由                                                 |
| ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| File Structure 节（列出 3 个 ref 文件）                                                                          | refs 删除                                            |
| Lifecycle Contract 中 "domain_mode injected by coordinator" 复杂规则                                             | domain_mode 删除, agent 自行判断                     |
| Step 2 "Read state.json.execution" + "initialize via jq"                                                         | 不再有 state.json                                    |
| Step 5e "Three-Stage Decision" 完整表（execution_produced/execution_shallow/execution_failed + root-cause 分类） | 简化为: 验产出非空 → verifier 验证 → 据 verdict 决策 |
| Step 5e "行数预筛 + judgment-worker(shallow-judgment)"                                                           | 删除                                                 |
| Step 5h0 "verification depth check" + "行数预筛 + judgment-worker(verification-depth-judgment)"                  | 删除                                                 |
| Step 5m "failure-synthesis" + judgment-worker dispatch                                                           | 删除，worker 自行记录 Failed Attempts                |
| Step 5 中所有 `references/edge-cases.md` / `references/worker-prompts.md` / `references/digest-schemas.md` 引用  | refs 删除，内容内联或删除                            |
| domain_mode 确定规则                                                                                             | 删除, agent 自行判断                                 |

## 保留

- Wave 拓扑排序（从 PLAN.md 依赖图）
- 逐问题执行→验证→决策循环
- executor cycle 计数（max 3）
- 暂停问用户（critical dep 失败 / 需假设）
- 输出文件: Qn_REASONING.md / Qn_EXECUTION.md / Qn_VERIFICATION.md / EXECUTION.md / VERIFICATION.md — 路径改为 `<workdir>execution/` 和 `<workdir>`

## 修改

### M1. front matter

```yaml
# 旧
name: autoresearch
description: |
  Phase 5 (phase_execution) of the Path 3 research state machine.
  Per-question推进管理器 — autoresearch internally manages the complete
  per-question loop (Wave sorting → question serial → execution → verification → decision → failure propagation → retry → early abort).
  Coordinator dispatches once; autoresearch drives all question advancement internally.

# 新
name: autoresearch
description: |
  逐问题执行管理器。按 PLAN.md 依赖图逐问题执行与验证，据验证结果决策。
  由 research-worker 调用。
  产出 <workdir>execution/Qn_*.md + <workdir>EXECUTION.md + <workdir>VERIFICATION.md。
```

### M2. Lifecycle Contract

```markdown
# 旧

**Input**: PLAN.md contract + STATE.md + state.json.execution
**Output**: 6 个文件（含 ENVIRONMENT.md 在 persistence/）
**Precondition**: User must have confirmed execution at phase_checkpoint
**MUST NOT**: Modify PLAN.md. Call advance_plan. Skip verification. Dispatch verification through research-worker.

# 新

**Input**: <workdir>PLAN.md + persistence/research_state.md（Questions/Claims 状态）
**Output** (MUST write all):

1. `<workdir>execution/Qn_REASONING.md` — per-question 推理
2. `<workdir>execution/Qn_EXECUTION.md` — per-question 执行结果
3. `<workdir>execution/Qn_VERIFICATION.md` — per-question 验证报告
4. `<workdir>EXECUTION.md` — phase 汇总
5. `<workdir>VERIFICATION.md` — phase 汇总

**MUST NOT**: Modify PLAN.md. Skip verification for any question.
（人类指示修改 PLAN.md method 由 primary agent 在 dispatch 前处理，execution worker 运行时 PLAN.md 已反映修改）
```

### M3. Step 1: Read Plan & Determine Waves（原 M3+M4 合并）

```markdown
# 旧

Step 1: Read persistence/PLAN.md + state.json.execution → resume
Step 2: Read state.json.execution → resume or fresh start

# 新

Step 1: Read plan & determine waves

1. Read persistence/research_state.md — 获取 Active Workdir、Questions/Claims（status/method/dependencies）、Human Directives（调度类指示）
2. Read <workdir>PLAN.md — extract §Execution Plan（per-Wave, method, tools, falsification test, Dependencies）
3. Determine Waves from PLAN.md §Execution Plan
4. Sort within Wave by tractability confidence (HIGH > MEDIUM > LOW)
5. 若 Human Directives 有调度类指示（优先做/暂缓/完成后暂停）: 调整 Wave 调度（见 M7）
6. 跳过 resolved/failed/blocked 的 question，只处理 open 的
7. 执行状态记录在 research_state.md 的 Questions/Claims status 字段
```

### M4. ENVIRONMENT.md 责任（原 Step 3+4 合并）

```markdown
execution worker 负责 persistence/ENVIRONMENT.md：

1. 启动时读 persistence/ENVIRONMENT.md（若存在）
2. 对照 PLAN.md environment_requirements，探测缺失信息（可用软件、Python 版本、库）
3. 自行安装所需软件（在项目 venv 内，如 uv pip install）
4. 增量更新 ENVIRONMENT.md（不覆盖已有信息，追加新发现）
5. 每个 question 执行前可重读 ENVIRONMENT.md（前一 question 可能更新了环境）
```

### M5. 执行原则（取代固定 workflow）

```markdown
# 设计哲学

以下不是固定施工步骤，而是 agent 必须遵守的原则与必须做的事。
agent 按 Wave 顺序逐问题处理，每个 question 的处理方式由 agent 据情况灵活决定，
但必须满足以下约束。

# 必须做的事

## 执行

- 对每个 open question Qn（按 Wave 顺序）:
  - 读 PLAN.md §Execution Plan 获取 Qn 的 method, tools, falsification test
  - 依赖处理: 对每个 dependency Qd，读 <workdir>execution/Qd_VERIFICATION.md 获取完整 conclusion
    （无论 Qd 的结果来自原定计划还是 fallback，conclusion 都在 VERIFICATION.md 中）
    若 Qd failed + critical → Qn 不执行（在确定处理列表时已排除为 blocked）
  - dispatch local-executor (delegation_depth: 0)，产出 <workdir>execution/Qn_REASONING.md + Qn_EXECUTION.md

## 文件验证

- 任何 subagent 产出后，验证输出文件存在且非空后再继续
  （check_artifacts 验证 Qn_REASONING.md + Qn_EXECUTION.md；check_verification 验证 Qn_VERIFICATION.md 非空 + 含 verdict）
  产出文件不合格 → 重跑对应 subagent（max 2）

## 验证

- dispatch research-verifier (delegation_depth: 0)，产出 <workdir>execution/Qn_VERIFICATION.md（含 verdict + evidence + 4 子项判定）

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
```

### M5 约束（explicit）

```markdown
# autoresearch skill 的硬约束

- MUST: 任何 subagent 产出后验证输出文件存在且非空（check_artifacts + check_verification）
- MUST: resolved claim 前确保 check_sources + check_verification 通过（引用有下载文件 + 验证记录含 verdict）
- MUST: 标记 question resolved 时更新 research_state.md Questions/Claims 的 `status` 为 resolved **并更新 `ver` 字段**指向 `<workdir>execution/Qn_VERIFICATION.md`（check_verification.py 据此验证）
- MUST: question failed 时记录到 research_state.md 的 Failed Attempts（method + 失败原因 + 排除方向）
- MUST: 每 Wave 完成后 dispatch research-audit agent 检查跨问题一致性
- MUST: execution 完成后做最终 audit + 写 EXECUTION.md + VERIFICATION.md 汇总
- MUST: 按 PLAN.md 中的 Acceptance Tests 验证，不得简化或降级测试标准（framing 在 PLAN.md 中为每个 question 给出明确的、符合研究要求的 Acceptance Tests，execution 须严格按此验证）
- FORBIDDEN: 跳过验证（任何 question 都必须经 research-verifier 验证后才能标 resolved）
- FORBIDDEN: 修改 PLAN.md（含 claims / method / Acceptance Tests；method 字段修改由 primary agent 在 dispatch 前处理）
```

### M6. Final Output

```markdown
# 旧

1. Write persistence/EXECUTION.md + VERIFICATION.md (格式见 digest-schemas.md)
2. Output final_execution_digest or paused digest

# 新

1. Write <workdir>EXECUTION.md — phase 汇总（per-question 结果: resolved/failed/blocked, conclusion 摘要）
2. Write <workdir>VERIFICATION.md — phase 汇总（per-question 验证 verdict + evidence 摘要）
3. Update research_state.md: 推荐更新各 Qn status + Phase History 追加 execution ✓ + Failed Attempts 追加失败方法
   （agent 据发现可灵活更新其他节，不限于以上推荐；标记 resolved 时必须更新 `ver` 字段）
4. dispatch research-audit agent 做最终质量门（审汇总质量、跨问题一致性）
5. 更新 research_state.md 的 Last Phase Result 节 (phase=execution / status / summary / issues), 回传 status 信号 (completed | needs_attention)
```

### M7. 调度类 Human Directives

```markdown
Read research_state.md 的 Human Directives 中调度类指示:

- "优先做 Q3" → 若 Q3 依赖已满足，调整 Wave 顺序将 Q3 提前；依赖未满足 → 拒绝并解释
- "Q5 暂缓" → Q5 标 deferred, 不执行
- "Q3 完成后暂停" → Q3 resolved 后写 Last Phase Result (status=needs_attention), 回传 needs_attention

（方法修改类指示如"Q2 方法改为 X"不在此处理——由 primary agent 在 dispatch 前修改 PLAN.md + 记 Failed Attempts）
```

---

## 预期结果

- SKILL.md 从 268行 → ~150行（refs 删除 1144行，删 shallow-retry/judgment-worker/复杂决策表/failure-synthesis，M5 从固定 workflow 改为原则）
- 3 个 ref 文件 (1144行) → 删除
- 合计: 1412行 → ~150行

---

## 验收目标

### 语义验收

- [ ] skill name 保留 `autoresearch`（不改名）
- [ ] 3 个 ref 文件全部删除：digest-schemas.md / edge-cases.md / worker-prompts.md
- [ ] 删 shallow-retry 双层机制 / judgment-worker dispatch / 多类型计数器 / failure-synthesis / domain_mode
- [ ] 保留 Wave 拓扑排序（从 PLAN.md 依赖图）+ 逐问题执行→验证→决策循环 + executor cycle 计数（max 3）+ 暂停问用户
- [ ] M5 从固定 workflow 改为原则+必须做的事：agent 按 Wave 顺序逐问题处理，每个 question 的处理方式由 agent 灵活决定但满足约束
- [ ] ENVIRONMENT.md 由 execution worker 负责：启动时读取、探测缺失信息、自行安装（venv 内）、增量更新
- [ ] 每 Wave 后 dispatch research-audit agent 检查跨问题一致性
- [ ] execution worker 标记 question resolved 时，必须同时更新 research_state.md 的 Questions/Claims 中该 question 的 `status` 字段为 resolved **并更新 `ver` 字段**指向 `<workdir>execution/Qn_VERIFICATION.md`，否则 check_verification.py 会报 unverified_claims
- [ ] 执行产出文件路径：`<workdir>execution/Qn_REASONING.md` + `Qn_EXECUTION.md` + `Qn_VERIFICATION.md`（per-question，在 execution/ 子目录内）；`<workdir>EXECUTION.md` + `<workdir>VERIFICATION.md`（phase 汇总，在 workdir 根目录，**与 newlayer-1 §6 一致**）
- [ ] 调度类 Human Directives 处理：优先做/暂缓/完成后暂停（方法修改类指示由 primary agent 在 dispatch 前处理）
- [ ] 据 verdict 决策：PASS→resolved / FAIL/PARTIAL→retry(cycle+1) / cycle=3→failed（记 Failed Attempts）/ 需人类决策→pause
- [ ] **Acceptance Tests 约束**：execution 须按 PLAN.md 中的 Acceptance Tests 严格验证，不得简化或降级测试标准；FORBIDDEN 修改 PLAN.md（含 Acceptance Tests）
- [ ] 回传格式：Last Phase Result 节写入 `phase=execution / status / summary / issues`

### 脚本强制验收

- [ ] `不得存在` `references/digest-schemas.md` 文件（已删除）
- [ ] `不得存在` `references/edge-cases.md` 文件（已删除）
- [ ] `不得存在` `references/worker-prompts.md` 文件（已删除）
- [ ] `不得存在` SKILL.md 中的 `judgment-worker` dispatch 引用
- [ ] `不得存在` SKILL.md 中的 `shallow-retry` / `shallow-judgment` / `verification-depth-judgment` 引用
- [ ] `不得存在` SKILL.md 中的 `failure-synthesis` 引用
- [ ] `不得存在` SKILL.md 中的 `domain_mode` 参数及相关描述
- [ ] `不得存在` SKILL.md 中的 `state.json` / `state.json.execution` 引用
- [ ] `不得存在` SKILL.md 中的 `advance_plan` 调用
- [ ] `不得存在` SKILL.md 中的 `PhaseResultDigest` / `final_execution_digest` 引用
- [ ] `不得存在` SKILL.md 中的 `Three-Stage Decision` 完整表（execution_produced/execution_shallow/execution_failed）
- [ ] `check_artifacts.py` 验证 per-question 产出文件（Qn_REASONING.md + Qn_EXECUTION.md）存在非空
- [ ] `check_verification.py` 验证每个 resolved claim 的 `ver` 路径指向的验证文件存在 + 非空（≥30行）+ 含 verdict（PASS/FAIL/PARTIAL）
- [ ] `check_sources.py` 验证 execution 产出文件中所有 `[src:id]` 引用都有下载文件
- [ ] research_state.md 的 Failed Attempts 节记录所有 failed question 的 method + 失败原因 + 排除方向
