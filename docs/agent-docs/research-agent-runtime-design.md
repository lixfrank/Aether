# Research Agent 运行时设计文档

> 本文档描述 research agent 的运行时行为设计：目的、核心模块、工作流程与防卫性设计。
> 与 `research-agent-v2-overview.md`（6层重构计划与实现路线图）互补，不替代。

---

## 1. 目的

Research agent 是一个**多阶段、多代理协作的深度研究系统**，旨在将"从模糊想法到可验证结论"的完整研究流程系统化。核心目标：

- **系统性**: 通过强制状态机推进，确保研究项目经历分析、方向确认、引用核查、文献扫描、知识验证、问题框定、辩论验证、执行与验证的完整流程，不跳过任何关键步骤
- **可验证性**: 物理领域使用确定性 SymPy 计算脚本（而非 LLM 推理）执行维度分析、极限推导、Ward 恒等式验证；通用领域使用结构化验证程序
- **可追溯性**: 每个阶段的产出写入持久化文件（ROADMAP.md、PLAN.md、DEBATE.md、VERIFICATION.md 等），配合 git commit 记录，可随时回滚到任意阶段
- **鲁棒性**: 通过 Entry Gate 分类、debate loop、checkpoint 确认、health check 等多层防御机制，防止 agent 偏离预期方向

---

## 2. 核心模块

### 2.1 Coordinator（协调者）

即 research agent 自身。职责：

- **Entry Gate 分类**: 判断用户意图属于 Path 0/1/2/3，路由到对应工作流
- **Worker 派遣**: 通过 `task(subagent_type: "research-worker")` 派遣子代理执行各阶段
- **Digest 处理**: 提取 worker 返回的 PhaseResultDigest，追加到 DIGESTS.md，路由到下一阶段
- **审计循环管理**: 管理 audit-repair 循环（max 3 次 repair），路由 audit_1/audit_2/audit_3 digest 到 landscape/repair/framing/debate
- **状态一致性维护**: 读 STATE.md + state.json（MCP）双重确认，不一致时 git rollback 恢复
- **Checkpoint 确认**: 在 phase_checkpoint 直接与用户交互（不派遣 worker），必须获得用户确认才能推进
- **Health check 管理**: 启动时与运行中均可触发健康检查，处理 degradation/failure

### 2.2 Research Worker（子代理）

- 由 coordinator 通过 task tool 派遣
- 每个 worker 负责一个阶段或子阶段的具体执行
- Worker 内部调用 skill（deep-research、literature-landscape-scan、research-question-framing、debate-\*、autoresearch 等）
- Worker 返回 PhaseResultDigest（YAML 格式），coordinator 解析后路由
- Worker 的 delegation_depth 为 0，不可再派遣 task tool（但可派遣 local-executor）

### 2.3 MCP 服务器

| MCP 服务器             | 职责                                                                                                                                                                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `research-state`       | 项目状态管理：advance_plan（推进阶段）、get_state（读取状态）、validate_file_locations（文件布局合规检查）、check_file_updated（验证 worker 是否写了输出文件）、update_debate_state（辩论状态更新）、update_audit_state（审计状态更新） |
| `research-conventions` | 物理约定锁管理：convention_lock_status、subfield_defaults、skill_resolve_path 等                                                                                                                                                        |

### 2.4 Skills（技能系统）

| Skill                             | 触发阶段                                | 核心产出                                                                                                                |
| --------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------- |
| `deep-research`                   | phase_analysis                          | ROADMAP.md + research_analysis.md                                                                                       |
| `research-audit`                  | phase_audit_1 / phase_audit_2           | audits/audit\_[1                                                                                                        | 2]\_round[N].md |
| `research-audit-reasoning`        | phase_audit_3                           | audits/audit_3_round[N].md                                                                                              |
| `research-audit-repair`           | phase_audit_1 / phase_audit_2 (repair)  | 修复 ROADMAP.md + research_analysis.md + landscape_map.md                                                               |
| `research-audit-repair-reasoning` | phase_audit_3 (repair)                  | 修复 framing_reasoning.md + PLAN.md + rq.md + ROADMAP.md + landscape_map.md                                             |
| `literature-landscape-scan`       | phase_landscape                         | landscape_map.md，更新 ROADMAP.md                                                                                       |
| `research-question-framing`       | phase_framing                           | PLAN.md + research_questions.md + framing_reasoning.md                                                                  |
| `debate-advocate`                 | phase_debate (advocacy/rebuttal)        | advocacy brief/rebuttal → DEBATE.md                                                                                     |
| `debate-critic`                   | phase_debate (critique)                 | critique → DEBATE.md                                                                                                    |
| `debate-adjudicator`              | phase_debate (adjudication)             | ruling → DEBATE.md                                                                                                      |
| `debate-repair`                   | phase_debate (repair)                   | 修复 PLAN.md + research_questions.md                                                                                    |
| `autoresearch`                    | phase_execution                         | per-question 推进管理器：Wave 排序 + question 串行 + execution + verification dispatch + decision + 失败传播 + 汇缩写入 |
| `gpd-verifier`                    | phase_execution (autoresearch 内部派遣) | physics domain per-question verification + Qn_VERIFICATION.md (domain-specific part)                                    |
| `research-verifier`               | phase_execution (autoresearch 内部派遣) | general domain per-question verification + Qn_VERIFICATION.md (general part)                                            |
| `health-check`                    | session 启动 / 用户请求                 | global_health.json + network_status.md                                                                                  |

### 2.5 持久化层

所有产出写入 `.aether/research/persistence/`：

| 文件/目录                    | 用途                                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------------------- | --- | --------------------------------------- |
| `STATE.md`                   | 人类可读的项目状态（当前阶段、决策、阻塞、下一步）                                                |
| `state.json`                 | 机器可读的项目状态（通过 MCP 管理，与 STATE.md 双重对应）                                         |
| `DIGESTS.md`                 | 各阶段摘要的累积记录（coordinator 在每个阶段完成后追加）                                          |
| `ROADMAP.md`                 | 研究路线图（analysis 阶段产出，landscape 阶段更新）                                               |
| `PLAN.md`                    | 研究计划（framing 阶段产出，debate repair 修改）                                                  |
| `research_questions.md`      | 结构化研究问题（framing 阶段产出，debate repair 修改）                                            |
| `framing_reasoning.md`       | 推理链条（framing 阶段产出，audit_3 repair 修改，debate repair 标注过时）                         |
| `landscape_map.md`           | 文献领域地图（landscape 阶段产出）                                                                |
| `DEBATE.md`                  | 辩论全记录（每轮的 brief、critique、ruling、repair report）                                       |
| `EXECUTION.md`               | 执行汇总（autoresearch 在执行结束时一次性写入，per-question 结果在 notepads/）                    |
| `VERIFICATION.md`            | 验证汇总（autoresearch 在执行结束时一次性写入，per-question 结果在 notepads/）                    |
| `ENVIRONMENT.md`             | 环境状态（autoresearch bash 探测 + 增量更新）                                                     |
| `notepads/[slug]/execution/` | per-question 工作文件（Qn_REASONING.md + Qn_EXECUTION.md + Qn_VERIFICATION.md + \_cycle[N] 备份） |
| `audits/`                    | 审计报告目录（audit\_[1                                                                           | 2   | 3]\_round[N].md，按轮次命名不覆盖历史） |
| `literatures/`               | 已下载文献目录（index.json 元数据索引 + unavailable.md 不可下载列表）                             |

---

## 3. 工作流程

### 3.1 Entry Gate（入口分类）

每个用户 prompt 必须先通过 Entry Gate 分类：

| 条件                                                     | 路径                        | 工作流                                 |
| -------------------------------------------------------- | --------------------------- | -------------------------------------- |
| 单一事实问题（一次搜索可回答）                           | Path 1: Quick lookup        | paper-search skill，无子代理，无状态机 |
| 明确要求综述/文献回顾                                    | Path 2: Literature review   | literature-review skill，自有状态机    |
| 研究意图 + 多阶段描述 / 可行性分析 / 方法比较 / 实验验证 | Path 3: Research project    | 完整状态机（含 3 次审计）              |
| 无研究意图，非事实查询                                   | Path 0: Not a research task | 提示用户切换到 build agent             |

Gate 完成后写入 STATE.md（path chosen + reason + intent 分类），路径锁定后不可越界执行。

### 3.2 Path 3 状态机（完整研究项目）

```
gate → classify → lock path (Path 3)
   │
   ▼
phase_analysis      ── worker + /deep-research skill
   │                    → ROADMAP.md + research_analysis.md
   ▼
phase_analysis_checkpoint ── coordinator 直接与用户确认（不派遣 worker）
   │                         → 用户确认方向 → phase_audit_1
   │                         → 用户请求修正 → rollback analysis + 重做
   ▼
phase_audit_1      ── worker + /research-audit skill (light mode)
   │                    → audits/audit_1_round[N].md
   │                    [audit_1 验证驱动的路径分支]
   ├─ has_citation_gaps=true → landscape 必须执行
   │    ▼
   │  phase_landscape   ── worker + /literature-landscape-scan skill
   │    │                    → landscape_map.md，更新 ROADMAP.md
   │    │                    [含 audit_1 补缺任务]
   │    ▼
   │  phase_audit_2    ── worker + /research-audit skill (full mode)
   │    │                    → audits/audit_2_round[N].md
   │    │                    [audit-repair 循环，max 3 次 repair]
   │    ▼
   ├─ has_citation_gaps=false + issues_found>0
   │    → landscape 跳过 + audit-repair 循环（phase_audit_1 内）
   │    ▼
   └─ has_citation_gaps=false + issues_found=0
      → landscape 跳过 → 直接进入 phase_framing
   ▼
phase_framing       ── worker + /research-question-framing skill
   │                    → PLAN.md + research_questions.md + framing_reasoning.md
   ▼
phase_audit_3      ── worker + /research-audit-reasoning skill
   │                    → audits/audit_3_round[N].md
   │                    [audit_3 推理链审计路径分支]
   ├─ has_structural_incompleteness=true → re-dispatch framing worker (max 1 retry)
   ├─ has_structural_incompleteness=false + issues_found=0 → phase_debate
   ├─ has_structural_incompleteness=false + issues_found>0 + repair_count<3 → repair 循环
   ├─ has_structural_incompleteness=false + issues_found>0 + repair_count=3 + LOW confidence
   │    → coordinator 向用户确认（landscape 补缺 / infeasible / 继续）
   ├─ has_structural_incompleteness=false + issues_found>0 + repair_count=3 + no LOW
   │    → unresolved_reasoning_gaps → phase_debate
   ▼
phase_debate        ── 多代理辩论循环（coordinator 管理）
   │                    5步/轮: advocacy → critique → rebuttal → adjudication → repair
   │                    最多 3 轮，ESCALATE 话题跨轮聚焦
   ▼
phase_checkpoint    ── coordinator 直接与用户确认（不派遣 worker）
   │                    必须用户确认才能推进
   ▼
phase_execution     ── 方案 D：coordinator 一次 dispatch autoresearch
   │                    autoresearch 内部管理 per-question 推进
   │                    Wave 排序 → question 串行 → execution → verification → decision → 失败传播 → retry
   ▼
completed           ── 向用户呈现最终结果
```

### 3.3 辩论循环详情

每轮辩论固定 5 步：

1. **Advocacy**: defender 为 PLAN.md 所有话题构建辩护（DEFEND/CONCEDE）
2. **Critique**: critic 评估辩护（SOUND/CONCERN/CRITICAL）
3. **Rebuttal**: defender 回应 critique（REBUT/CONCEDE），未回应 = CONCEDE
4. **Adjudication**: adjudicator 对所有话题裁决（UPHELD/REVISE/ESCALATE/CONCEDED）
5. **Repair**: repair worker 修改 PLAN.md + research_questions.md

轮次终止条件：

- ALL_RESOLVED → 进入 checkpoint
- FURTHER_ROUNDS_NEEDED + round < 3 → 下一轮聚焦 ESCALATE + re_verification 话题
- round = 3 仍未解决 → 带 Blockers 进入 checkpoint

前 4 步返回 minimal digest（4 字段），仅 repair 写完整 digest 到 DIGESTS.md。

### 3.4 执行阶段详情（方案 D：per-question 推进）

```
coordinator dispatches research-worker → autoresearch (一次派遣):
  autoresearch 内部管理 per-question 推进循环:
    │
    ├─ Wave 1: [Q1, Q3] (sorted by tractability confidence)
    │   ├─ Q1: local-executor → Q1_REASONING.md + Q1_EXECUTION.md
    │   │   verification subagent(s) → Q1_VERIFICATION.md
    │   │   decision → resolved / failed / retry / blocked
    │   ├─ Q3: [same structure]
    │
    ├─ Wave 2: [Q2] (depends on Q1)
    │   Q1 resolved → Q2 uses Q1 conclusion
    │   Q1 failed + fallback → Q2 uses fallback assumption
    │   Q1 failed + critical → Q2 blocked
    │
    ├─ All questions processed → write persistence/EXECUTION.md + VERIFICATION.md
    │   → output final_execution_digest → coordinator → advance_plan(completed)
    │
    └─ Early abort: no pending questions → write partial 汇缩 → output digest
```

### 3.5 Session Recovery（会话恢复）

启动时：

1. Health Check Bootstrap（Tier 0 → 0.5 → 1-3 worker 派遣 → 迁移全局文件）
2. 读 STATE.md + state.json → 判断是否有活跃项目
3. 有活跃项目 → 从当前阶段恢复（不重新走 Gate）
4. analysis_checkpoint 恢复：重新向用户呈现 analysis 摘要 → 用户确认或修正
5. audit phase 恢复：读取 state.json.audit（repair_count, current_audit_phase, audit_round）→ 从中断点继续；repair 中断时恢复备份文件
6. 辩论阶段恢复：检查 current_sub_phase → 从中断点继续；repair 中断时恢复 PLAN.md 备份
7. 执行阶段恢复：检查 state.json.execution + persistence 汇缩文件 → 汇缩已存在则 advance_plan(completed)；未存在则检查 question_status → re-dispatch autoresearch 从中断点继续
8. Git 一致性检查：验证 state.json.phase_commits 与 git log 匹配

---

## 4. 防卫性设计

Research agent 的防卫性设计是多层的，核心原则是**宁可阻塞也不偏航**。

### 4.1 分类锁定（Entry Gate）

- **强制分类**: 每个 prompt 必须先分类，禁止跳过 Gate 直接执行
- **路径锁定**: 分类后只允许执行该路径的动作，禁止跨路径越界
  - Path 1 不可执行 Path 3 动作
  - Path 3 不可直接派遣 explore/general/research-explorer/verifiers（只能通过 research-worker）
- **分类写入 STATE.md**: 决策有迹可循，不可事后修改

### 4.2 状态机强制推进

- **阶段顺序强制**: 每个阶段必须按顺序执行，禁止跳过（landscape 有条件跳过，其他禁止）
- **双重状态确认**: 进入阶段前读 STATE.md + state.json（MCP），两者必须一致
- **完成后 git commit**: 每阶段完成后 git add + commit，附带阶段名 + plan_number
- **SHA 延迟记录**: commit SHA 写入 state.json.phase_commits，下次阶段 commit 时一并提交
- **Clean check**: commit 后 git status 必须干净，不干净则 amend 重试

### 4.3 辩论防卫

- **多视角对抗**: 5 步辩论结构确保 PLAN.md 经过辩护、批判、裁决、修复的完整考验
- **最小 digest**: 前 4 步只返回 4 字段摘要，防止中间步骤注入过多信息干扰 coordinator
- **Repair 预备份**: 每轮 repair 前备份 PLAN.md（PLAN.md.pre_repair_round{N}），repair 崩溃时可恢复
- **ESCALATE 话题跨轮追踪**: 未解决的 ESCALATE 话题自动进入下一轮聚焦，不会丢失
- **轮次上限**: 最多 3 轮，防止辩论无限循环
- **Re-opening 规则**: checkpoint 用户拒绝后可重新辩论，轮次计数器继续（不重置），每次 reopening 最多 3 轮

### 4.3.1 审计防卫

- **角色分离**: audit ≠ repair — 审计与修复角色分离，防止确认偏见
- **三次审计验证三座桥梁**: audit_1 验证引用支撑（analysis→landscape），audit_2 验证知识完整（landscape→framing），audit_3 验证推导可靠（framing→debate）
- **audit_1 引用核查驱动 landscape**: landscape 是否跳过由 audit_1 的 has_citation_gaps 决定，而非 ROADMAP 表面内容
- **audit-repair 循环上限**: 最多 3 次 repair，防止审计循环无限
- **audit_3 结构性缺失 → framing 重试**: framing_reasoning.md 整体推理链缺失时重新派遣 framing worker（不 git rollback，覆盖旧产出），最多重试 1 次
- **audit_3 LOW confidence → 用户确认**: coordinator 使用 question tool 向用户提供 3 个选项（landscape 补缺 / infeasible / 继续执行）
- **Repair 预备份**: audit repair 前备份所有修复对象文件，repair 崩溃时可恢复
- **unresolved_gap 传递**: 达到 repair 上限后未解决问题标注为 unresolved_gap / unresolved_reasoning_gap → 写入 STATE.md Blockers → 注入 downstream worker 提示词作为硬约束
- **跨 verify 独立来源**: audit 的每个 FATAL/CONCERN finding 至少 2 种独立来源 cross-verify
- **本地文献优先**: audit 核实引用时优先使用 .aether/research/literatures/ 本地副本，减少 web search 随机性
- **audit_3 repair 回溯限制**: 回溯 ROADMAP/landscape 最多 1 次，仅补充引用和论证，不修改核心声明内容

### 4.4 Checkpoint 用户确认

- **强制确认**: phase_checkpoint 不派遣 worker，coordinator 直接向用户呈现摘要，必须获得确认
- **拒绝选项**: 用户拒绝后可选：重新辩论、回滚到 framing、回滚到更早阶段
- **回滚机制**: 读 state.json.phase_commits → 获取目标阶段 commit SHA → git checkout + clean → re-dispatch

### 4.5 输出文件验证

- **check_file_updated**: 每个 worker 返回后，MCP 检查输出文件（DEBATE.md 等）是否被更新
- **未更新 = 拒绝**: worker 返回 digest 但未实际写入文件 → 拒绝 digest，重试（最多 2 次）
- **validate_file_locations**: phase 完成后 MCP 检查文件是否在 .aether/research 内合规位置，违规文件需迁移

### 4.6 状态一致性检查

- **每阶段完成后**: 读 state.json.phase 与 DIGESTS.md 最后阶段比对
- **不一致 → rollback**: 回滚到 DIGESTS.md 对应阶段的 commit SHA，原子恢复 state.json + STATE.md
- **Re-dispatch**: rollback 后重新派遣 worker 执行恢复的阶段

### 4.7 Digest 解析容错

- **YAML 解析失败**: 检查 STATE.md + 产出文件存在性 → 三个等级（INCOMPLETE/COMPLETED_FALLBACK/MISSING）
- **COMPLETED_FALLBACK**: 从文件证据构造回退 digest，标记 `status: completed_fallback`，谨慎继续
- **Repair incomplete risk**: repair 崩溃 + PLAN.md 备份已恢复 → 标记 `status: repair_incomplete_risk`，请求用户手动审查

### 4.8 重试上限

| 场景                 | 最大重试次数                      | 失败后处理                      |
| -------------------- | --------------------------------- | ------------------------------- |
| Worker 派遣失败      | 3 次（2 重试）                    | 向用户报告，终止                |
| Debate 子阶段失败    | 3 次（2 重试）                    | 同上                            |
| DEBATE.md 未更新     | 3 次（计入子阶段上限）            | 同上                            |
| Audit repair 循环    | 3 次 repair（所有 audit phase）   | 带 unresolved 进入下一 phase    |
| Audit_3 framing 重试 | 1 次（structural incompleteness） | 带 unresolved 进入 debate       |
| Landscape 补缺       | 1 次（LOW confidence）            | 确认 Type B → PoC question 增添 |
| Audit repair 崩溃    | 2 重试                            | Digest Parsing Fallback         |
| Execution cycle      | 3 个 cycle                        | 向用户呈现部分结果              |
| Repair 崩溃          | 2 重试                            | Digest Parsing Fallback         |

### 4.9 文件范围限制

- **file_scope**: `.aether/research/**` — write/edit 工具只能在此范围内操作
- **bash 自约束**: file_scope 只限制 write/edit 工具，bash 不受限，agent 必须**自我约束**不在 bash 中写 .aether/research 外的文件
- **工作流替代**: 需要修改项目文件时，先 cp 到 .aether/research，再修改副本

### 4.10 禁止命令

env_scope.denied_commands 阻止危险 git 操作：

- `git push --force*`、`git push -f*`
- `git reset --hard*`
- `git rebase -i*`
- `git clean -fd`
- `git checkout * -- .`

### 4.11 Integrity 规则

- 不伪造来源
- 不在无证据时声称验证通过
- 不用 LLM 推理覆盖确定性计算 oracle 结果
- Turn 必须以派遣/处理/确认/推进结束，禁止以裸分析输出结束 turn

### 4.12 Health Check 防卫

- **启动时强制**: session 开始必须走 Health Check Bootstrap（Tier 0 → 0.5 → 1-3）
- **uv 不可用**: 降级为 LLM-only 模式（无 MCP、无 Python、无 SymPy），STATE.md 标记 `infrastructure: degraded`
- **degradation 处理**: 逐项询问用户是否自动安装（env-setup skill，per-item 授权）
- **运行中健康检查**: 用户请求时不改变 Next Action（仅信息性），不主动触发 env-setup
- **用户补充后**: 重新检查，pass → 恢复原始 Next Action；仍 degraded → 更新为剩余降级摘要

---

## 与 v2-overview 的关系

| 文档                                        | 视角       | 内容                                                                                            |
| ------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `research-agent-v2-overview.md`             | 实现架构   | 6层重构计划、核心源文件改动、验收清单、关键设计决策（命名、skill_refs 替换、base_agent 取消等） |
| 本文档 (`research-agent-runtime-design.md`) | 运行时行为 | Entry Gate 分类、状态机流转、辩论循环、执行循环、Session Recovery、防卫性设计机制               |

两份文档互补：v2-overview 告诉你"怎么建"，本文档告诉你"建好后怎么跑、怎么防偏航"。
