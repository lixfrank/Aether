# Research Agent 简化重构方案设计（v2）

> 把"11 阶段确定性 FSM + 摘要路由 + 硬 Terminal Action"的施工流程，
> 重构为 **"默认流程 + 智能偏差 + 人类深度参与"** 的研究 agent。
>
> 保留 subagent 隔离 / phase 依赖序 / 结构化执行 / 语义审计 / 辩论；
> 砍掉四重状态冗余 / Terminal Action 硬约束 / 3-audit-3-repair 循环 / shallow-retry 双层机制 / elaborate 回滚机器。
>
> 关系：对 `research-agent-v2-overview.md` / `research-agent-runtime-design.md` 所述 v2 状态机架构的简化重构。

---

## 0. 核心隐喻：导师—学生

研究是面向未知的人类活动。Research agent 是**学生**，人类用户是**导师**。
学生的职责：接到任务后按研究方法自主推进，在关键节点向导师汇报、听取指导、
据指导调整方向。导师的职责：设定目标、细化任务、讨论方案、审核结果、
随时介入指导细节、据结果部署下一阶段。

**为何用此隐喻**：当前 research agent 是 phase-by-phase 向前推进的模式，有非常明确的工作流，而人类只能在少数几个 checkpoint 介入工作，极大削弱了人类参与 research 的便利性和重要性。实际研究流程中，导师—学生的交互远比"几个 checkpoint"丰富：

1. 导师设定研究目标（目前包含）
2. 导师与学生细化研究任务（目前包含）
3. 导师与学生讨论研究方案（目前部分包含，但以固定轮 debate + 人类 checkpoint 形式，缺少人类深度参与）
4. 学生执行研究（目前部分包含，缺失"人类指示先进行哪些问题的研究，然后看情况调整其余"）
5. 导师与学生根据研究情况调整研究任务（目前部分包含，但以 judgment-worker 发现问题并回退的形式，缺少人类深度参与）
6. 学生向导师解释研究中遇到的某一问题、概念或执行环节细节（**目前缺失**，完全依赖 LLM 自身能力）
7. 导师直接指导学生某一个细节问题/概念或实现方式（**目前缺失**，人类无法介入 agent 具体工作流程）
8. 完成一个阶段研究后，导师根据结果发布下一阶段的研究目标或任务（**目前缺失**，只能进行一个阶段）

由于研究问题是面向未知的问题，这种人类介入的灵活交互与方向调整是必不可少的，
也是将 research agent 区别于一个固定"施工流程"的核心方法。

**默认流程仍存在**（analysis → landscape → framing → debate → execution），因为研究方法本身有自然依赖序（不知 gap 无法框定问题，无问题无法执行）。但这是**默认前进路径**，不是**唯一合法路径**——agent 可在人类指示或执行发现 gap 时回到任意更早 phase，也可在阶段完成后开启下一阶段研究。

---

## 1. 设计原则

1. **默认流程 + 智能偏差**：phase 有自然依赖序作为默认前进路径；agent 据人类指示 + 对问题的最新理解，灵活决定实际进入哪个 phase（含回退）。
   - _原因_：旧设计"FORBIDDEN to skip"的固定 FSM 把研究方法序当成唯一合法路径，但真实研究是迭代的——用户可能"回 debate 重讨论 Q2""Q2 方法不合适改用 xxx""删掉 Q5""推翻最初目标"。固定 phase 序 + elaborate 回滚机器（git checkout + phase_rollback MCP + 跨阶段上限 3 + 终止报告）的存在本身就是 FSM 不适配 agent 的反证。
2. **人类随时深度参与**：编辑状态文件注入指示；pause 点自由对话（非选项列表）；中断后给方向调整；询问任意概念/方法/实现细节。
   - _原因_：旧设计的 question list checkpoint 不利于人类介入——人类为给好指示需先理解工作状态，直接读文件负担重。对话式让人能先问"Q2 为什么 partial?"→ agent 解释 → 人类据此判断 → 下指示。这是自然的导师—学生交互。
3. **单一状态来源**：一个 research_state.md 记录"对研究问题的最新理解"（含已验证为错的理解——错误方向也有价值），删 state.json/STATE.md/DIGESTS.md/phase_commits 四重冗余。git 历史作审计轨。
   - _原因_：旧设计有五重叠加的状态存储（STATE.md / state.json / DIGESTS.md / git commits / phase_commits），且 coordinator 有专门的"State Consistency Check"对账逻辑——需要"对账"即说明抽象错了。单一来源不需要对账。
4. **subagent 隔离保留**：重上下文 phase（分析/landscape/framing/debate/execution）由 research-worker subagent 在隔离 context 执行，status 信号回传。
   - _原因_：每个 phase 产出体量巨大（分析 50 篇文献、landscape 图谱、framing 推理链、辩论 transcript），若全部加载进主 agent 上下文，context window 会爆。status 信号回传机制（worker 写 Last Phase Result 到 research_state.md，回传 status 信号）让主 agent 只携带摘要前进——这是真实的上下文管理，非仪式。早期方案曾提议"agent 直接加载 skill"但这对大型研究不可行。
5. **结构检查(确定性) + 语义审计(LLM) 合一**为 research-audit skill，由 worker 自动执行。
   - _原因_：旧设计把"验证"和"judgment"当两个东西——verifier 验证，judgment-worker 判断 verifier 是否 shallow。这是给"verifier 有时产出浅薄内容"打的补丁，越打越重。核心洞察：**verifier 本身就是 judge**。结构检查（文件存在/引用→下载映射）由确定性脚本判定，零 token 且可靠；语义判断（推理成立/引用支持/方法适用）由轻量 LLM audit 判定。两者合一为单一 skill，概念统一为"质量保证"。
6. **结构化执行保留但可灵活调度**：逐问题执行保留 Wave/依赖/失败传播/early-abort 结构（agent 不会自然做这些），但人类可指示执行优先级、暂停审核、调整方法。
   - _原因_：实测 LLM agent 行为——倾向频繁停下问"是否继续"（过度谨慎）、多步计划无显式结构会丢失追踪、失败传播需显式逻辑、early abort 需显式状态追踪。autoresearch 的结构恰恰是因为 agent **不**擅长自然做这些才存在。"内化为常识"基本不可行。
7. **多阶段研究**：阶段完成后可基于结果开启下一阶段，research_state.md 连续累积理解（不显式分 stage）。
   - _原因_：研究之间不存在绝对的 stage 分割——后续研究自然建立在前序理解之上。显式分 stage 1/2 是人为割裂。

---

## 2. 架构总览

```
                    人类用户（导师）
                       │  ▲
        指示/询问/讨论 │  │ 汇报/解释/答疑
                       ▼  │
        ┌──────────────────────────────────────┐
        │  Research Agent（学生, research.md）   │
        │  ┌────────────────────────────────┐  │
        │  │ 对研究问题的最新理解             │  │
        │  │  = research_state.md            │  │
        │  │  (目标/理解/claims/依赖/阶段史/  │  │
        │  │   人类指示/open决策)            │  │
        │  └────────────────────────────────┘  │
        │  ┌────────────────────────────────┐  │
        │  │ phase 选择器（智能）            │  │
        │  │  默认前进路径 + 人类指示 +      │  │
        │  │  当前理解 → 选下一个 phase      │  │
        │  └────────────────────────────────┘  │
        │  ┌────────────────────────────────┐  │
        │  │ phase 能力包（按需 dispatch）   │  │
        │  │  analysis · landscape ·        │  │
        │  │  framing · debate · execution  │  │
        │  │  (各自由 research-worker 在     │  │
        │  │   隔离 context 执行)           │  │
        │  └────────────────────────────────┘  │
        │  ┌────────────────────────────────┐  │
        │  │ 约束层                          │  │
        │  │  · 结构 checker (确定性, skill) │  │
        │  │  · 语义 audit (worker 自动)     │  │
        │  │  · 验证 (计算/证据核对)         │  │
        │  └────────────────────────────────┘  │
        └──────────────────────────────────────┘
                       │
                       ▼  git commit (审计轨)
```

---

## 3. 状态模型：research_state.md

### 3.1 定位

`research_state.md` 是 agent 对研究问题的**最新理解**的单一来源，也是人类注入指示的通道。不是 phase 跟踪表（phase 历史只是其中一节）。

_原因_：旧设计把状态拆成五份（STATE.md 人读 / state.json 机读 / DIGESTS.md 摘要历史 / git commits / phase_commits SHA 映射），彼此还要对账。单一来源消除对账需求，且"最新理解"比"phase 跟踪"更贴近研究本质——研究的状态是"我对问题理解到哪了"，不是"我执行到第几个 phase"。

### 3.2 结构

```markdown
# Research State

## Active Workdir

notepads/proof-riemann-zeta/

## Workdir History

- notepads/proof-riemann-zeta/ (2026-06-27, 目标: [简述])

## Research Goal

[研究目标。可被人类修改/推翻/扩展。]

## Current Understanding

[对问题的最新理解。包含:

- 已确认正确的理解（带证据）
- 已验证为错的理解（带失败原因——排除错误方向，防止重试）
- 尚存的不确定性]

## Questions / Claims

- Q1: [问题] — status: resolved (ver: <workdir>execution/Q1_VERIFICATION.md, srcs: [src:a])
  method: [方法] dependencies: []
  notes: [关键发现/教训]
- Q2: [问题] — status: partial (ver: <workdir>execution/Q2_VERIFICATION.md)
  method: [方法] dependencies: [Q1]
  notes: [Q1 的结论 X 在此适用; method Y 已验证不适用(见 failed_attempts)]
- Q3: [问题] — status: open

## Dependency Graph

Q1 → Q2 → Q3
Q1 → Q4

## Failed Attempts (验证为错的理解/方法——防止重试)

- Q2: method X 失败, 原因: [计算给出错误极限], 排除方向: [X 类方法]
- Q1: 假设 Z 不成立, 证据: [src:b §3]

## Phase History

- analysis ✓ (commit abc123) — 产出 <workdir>analysis.md, 初始化 research_state.md
- landscape ✓ (commit def456) — 产出 <workdir>landscape_map.md
- framing ✓ (commit ghi789) — 产出 <workdir>PLAN.md, <workdir>research_questions.md
- debate ✓ (commit jkl012) — 产出 <workdir>DEBATE.md
- execution [in progress] — Q1✓ Q2(partial) Q3(open)

## Human Directives (待处理的人类指示)

- [pending] 优先做 Q3, 完成后暂停等我审核再继续 Q4
- [pending] Q2 方法改为 [新方法描述]
- [processed×] (已执行的指示, 保留可追溯)

## Open Decisions (需人类决断的事项)

- [ ] Q2 的 partial 结果是否可接受, 还是需重新框定?

## Last Phase Result

- phase: [phase name]
- status: [completed | needs_attention]
- summary: "[1-3句摘要]"
- issues: []

## Conventions

[研究约定值（如物理: natural_units=natural, metric_signature=mostly-minus）。
非物理 domain 可为空。由 framing Step 9 设置。]

## Next To Handle

[当前要做的事/刚收到的人类指示待办, 简要]
```

### 3.3 人类注入指示

**直接编辑文件**：人类直接编辑 `research_state.md` 的 Human Directives 节，或编辑某 phase 产物文件（如 PLAN.md 改方法）。可在当前 session 或**新开 session** 操作——agent 在当前/下次 session 读取时获取指示。

**对话式指示（统一处理）**：无论 agent 处于暂停等待还是被中断后重启（停止按钮+发消息），agent 收到用户消息后的**响应逻辑一致**：

1. 读取用户消息 + research_state.md + 当前 phase 产物
2. 理解消息意图，自然响应（不机械分类——用户消息可能同时包含多种意图）。例如：
   - 若用户在询问某问题的细节 → 从 research_state.md + 产物文件回答
   - 若用户在给方向指示 → 更新 Human Directives，phase 选择器重定向
   - 若用户要求调整方法 → 修改产物文件 + 记录 Failed Attempts，重入相应 phase
   - 若用户在讨论 → 自然对话，据需要更新 Current Understanding
3. 若方向调整影响 phase 选择，phase 选择器决定下一个 phase

_统一响应的原因_：从 agent 视角，两者都是"收到用户消息后响应"——区别仅在触发方式（主动暂停 vs 被动中断），响应逻辑无差异。统一处理减少特殊 case，行为更一致可预测。

_关键_：这是 agent 判断，非 session-recovery 决策树。旧 284 行 if-else 恢复逻辑删除——恢复 = "读 research_state.md + 看磁盘产物 + 读人类消息，自己判断走到哪、该干啥"。

### 3.4 删除冗余

- `state.json`（机读 + phase_commits + audit/debate/execution 子对象）
- `STATE.md`（phase 跟踪，并入 research_state.md 的 Phase History）
- `DIGESTS.md`（摘要历史，并入 Phase History + 各产物文件）
- `ROADMAP.md`（内容被 research_state.md / landscape_map.md / PLAN.md 瓜分；Phase Breakdown 是固定默认序，无需每项目定制；analysis 改为产出 `<workdir>analysis.md` + 初始化 research_state.md）
- `phase_commits` SHA 映射（用 `git log` 替代）
- State Consistency Check 对账逻辑（单一来源无需对账）
- advance_plan / phase_rollback / update_debate_state / update_audit_state MCP

_ROADMAP.md 取消的原因_：当前 ROADMAP 的各节被瓜分——project 信息→research_state.md 的 Research Goal；文献 Scope→landscape_map.md；Initial Synthesis→research_state.md 的 Current Understanding；Gaps Identified→research_state.md 或 landscape_map.md 的 gap_list；Proposed Research Direction→research_state.md 或 framing 产出；Phase Breakdown→固定默认序，无需每项目定制；Milestones→PLAN.md 的 claims/acceptance tests。

### 3.5 git 作为审计轨

每个 phase 完成后：`git add .aether/research/ && git commit -m "research: phase_X"`.
人类指示应用后：`git commit -m "research: human directive — [简述]"`.
无需 phase_commits 映射；回退到历史状态用 `git log --oneline --grep` + `git checkout <sha> -- .aether/research/`（罕见操作，不需要 elaborate 机器）。

### 3.6 slug 与工作目录

**问题**：不同研究阶段（如目标 A、目标 B）的工作文件需分离，避免互相覆盖混淆；但 research_state.md 跨阶段共享（理解累积）。需要按阶段分目录。

**矛盾**：靠 prompt 指示 agent"写到 notepads/[slug]/xxx"不可靠——实测 agent 会写错路径、漏斜杠、自己造 slug 名出问题。slug 命名 + 路径拼接都不可靠。

**方案：状态记录 + checker 强制**

#### 3.6.1 slug 命名（agent 自由，约束为相关+不冲突）

slug 名由 agent 创建新阶段时自行命名，仅约束两点：(1) 与项目相关（从 Research Goal 关键词派生，可读）(2) 不与历史冲突——读 Workdir History 确认未用过，冲突加序号后缀。

_无需确定性脚本的原因_：slug 命名不是可靠性瓶颈（agent 起个相关名字通常没问题），真正易错的是路径拼接，那由 Active Workdir 记录 + checker 兜底解决。引入 make_slug.py 脚本是过度工程。

#### 3.6.2 Active Workdir 记录在 research_state.md

agent 读取 Active Workdir 字段作为当前工作目录。所有该阶段工作文件路径 = `<workdir><filename>`（简单拼接）。agent 不拼 slug，只拼 workdir + filename——workdir 是状态文件给的完整路径，拼接可靠度远高于自己想 slug 名。

#### 3.6.3 文件分类

| 位置                            | 内容                     | 跨阶段                     |
| ------------------------------- | ------------------------ | -------------------------- |
| `persistence/research_state.md` | 单一状态（理解累积）     | 共享                       |
| `persistence/ENVIRONMENT.md`    | 主机环境探测             | 共享（机器级，不随阶段变） |
| `literatures/`                  | 文献下载 + registry.json | 共享（一次下载跨阶段用）   |
| `notepads/<slug>/audits/`       | audit 报告               | 分离（与产物在一起）       |
| `notepads/<slug>/`              | 各 phase 工作产物        | 分离                       |

跨阶段查询时，research_state.md 的 Questions/Claims 字段记录产物路径引用（如 `ver: notepads/proof-riemann-zeta/execution/Q1_VERIFICATION.md`），agent 据引用定位历史阶段的工作文件。

#### 3.6.4 路径可靠性兜底

扩展 research-audit skill 的 check_artifacts.py：工作文件必须位于 Active Workdir 下；persistence/ 白名单收紧为只允许 research_state.md + ENVIRONMENT.md；文件不在正确 workdir → checker 报错。

_即使 agent 偶尔写错路径，checker 事后确定性把关，要求修正。这是"agent 判断 + 代码验约束"分工的又一次应用。_

---

## 4. Phase 模型：默认流程 + 智能偏差

### 4.1 默认前进路径

```
analysis → landscape → framing → debate → execution → [阶段完成]
                                     ▲          │
                                     │          │ 执行发现 gap / 人类指示
                                     └──────────┘  (回退到 framing)
```

依赖序（为何这是默认序）：

- analysis 产出分析（已知什么、gap 在哪）+ 初始化 research_state.md → 才能框定问题
- landscape 产出文献图谱（有哪些方法/学派）→ 框定才有依据
- framing 产出可证伪问题 + 依赖图 + 验收 → 才能辩论与执行
- debate 审视 framing 的合理性 → 才能执行
- execution 按依赖图逐问题求解

_为何保留 phase 依赖序而非"无固定 phase"_：早期方案曾提议"agent 自主决定下一步，无固定 phase"，但这过于激进——(1) phase 作为"指令打包 + 依赖排序 + 隔离执行"是合理抽象，分析→framing→执行有真实依赖；(2) checker 的"必备文件须存在"依赖于 phase 创建这些文件，删 phase 又依赖 phase 产物是自相矛盾。正确做法是保留 phase 作为默认序，但允许智能回退/重入。

### 4.2 phase 选择器（智能，非查表）

agent 每个 turn 读取 research_state.md，按优先级决定下一个 phase：

1. 若有 unprocessed Human Directives → 处理指示（回退/重入/修改/回答）
2. 若在 pause 点且人类未说"继续" → 等待人类消息
3. 否则按默认前进路径推进到下一 phase
4. 若 execution 完成 → 呈现结果，自然停止

_这是 agent 判断，不是条件路由表。但判断依据（research_state.md 的结构化字段）是确定的，使判断可靠可追溯。_

### 4.3 phase 能力包

| phase     | 能力                       | 执行方式                              | 产出                                                                                  |
| --------- | -------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------- |
| analysis  | 深度分析已知/gap           | research-worker + analysis skill      | `<workdir>analysis.md` + 初始化 research_state.md                                     |
| landscape | 文献景观扫描               | research-worker + landscape skill     | `<workdir>landscape_map.md`                                                           |
| framing   | gap→可证伪问题+依赖图+验收 | research-worker + framing skill       | `<workdir>PLAN.md`, `<workdir>research_questions.md`, `<workdir>framing_reasoning.md` |
| debate    | 辩论审视 framing           | research-worker + debate skill (简化) | `<workdir>DEBATE.md`, 修订后的 `<workdir>PLAN.md`                                     |
| execution | 逐问题求解+验证            | research-worker + autoresearch skill  | `<workdir>execution/Qn_*.md`, `<workdir>EXECUTION.md`, `<workdir>VERIFICATION.md`     |

注：`<workdir>` = research_state.md 的 Active Workdir 字段值。audit 不再单列为 phase，而是各 phase 产出后的质量门。各 phase 可被**重新调用**（非一次性）。回退到 framing = 重新 dispatch framing worker，注入"修订原因"。

### 4.4 与旧设计的区别

|              | 旧                                                          | 新                                                          |
| ------------ | ----------------------------------------------------------- | ----------------------------------------------------------- |
| phase 序     | 固定, FORBIDDEN to skip                                     | 默认序, 可智能回退/重入                                     |
| skip         | 仅 landscape 有条件跳, 余禁止                               | 无强制; 跳过有后果(audit/验证会暴露)                        |
| 回退         | git checkout + phase_rollback MCP + 跨阶段上限 3 + 终止报告 | 直接重入目标 phase, 注入修订原因                            |
| phase 间衔接 | PhaseResultDigest YAML + DIGESTS 追加 + 文件位置校验        | status 信号 + Last Phase Result 节 + 更新 research_state.md |

### 4.5 文献调研（独立路径）

research agent 处理两类 research 请求：

1. **具体研究任务** → analysis → landscape → framing → debate → execution workflow
2. **文献调研** → 直接调用 literature-review skill，产出文献报告（叙述性综述 + 引用 + 分析），不走 analysis→...→execution workflow

agent 据 user prompt 语义判断意图：若用户要求"调研 X 领域的文献"或"综述 Y 主题"，调用 literature-review skill；若用户要求"研究/证明/解决 X"，走研究 workflow。

literature-review skill 与 literature-landscape-scan skill 不同：前者是独立文献综述任务（产出叙述性报告供人类阅读），后者是研究项目内的 phase（产出结构化图谱供 framing 消费）。

---

## 5. 人类交互：对话式参与

### 5.1 pause 点（取代固定 question list）

agent 在以下节点暂停，等待人类自由对话：

- analysis 完成后（审核研究方向）
- debate 完成后（审核研究方案）
- execution 中人类指示的暂停点（如"做完 Q3 暂停等我"）
- 遇到 open decision 时（如 Q2 partial 是否可接受）

注：execution **全部完成后**不列为 pause 点——agent 呈现结果后自然停止（见 §8），不主动说"等待审核"。

**pause 行为**：

1. agent 输出**简短摘要**（研究目标进展、关键发现、待决事项），非长篇报告
2. agent 明确说："我暂停等待你的审核。你可以询问细节、讨论方向、或指示下一步。"
3. agent **等待**人类消息——不弹 question 选项列表
4. 人类可发多条消息（询问→讨论→决断），agent 据每条消息响应
5. 人类明确说"继续"/"进入 X"后，agent 更新 research_state.md 并推进

_为何不用 question list_：人类为给好指示需先理解工作状态，直接读文件负担重。对话式让人能先问"Q2 为什么 partial?"→ agent 解释 → 人类据此判断 → 下指示。这是自然的导师—学生交互，非选择题考试。

### 5.2 询问研究中的概念/方法/细节（功能 6,7）

**通道 A — pause 点/中断后对话**：在当前 session 直接问。agent 从 research_state.md + 各 phase 产物文件读取相关上下文回答。响应逻辑同 §3.3。

**通道 B — 询问研究细节**：用户问"关于 [研究项目] 的 Q2，为什么用 SymPy 而非数值方法?"。agent 据 prompt 语义判断意图为询问 → 读 research_state.md + 相关产物文件回答（不启动 workflow, 不修改文件）。agent 不区分 session 类型——据用户 prompt 的语义意图判断如何响应。询问类 prompt 只读不写, 推进类 prompt 才启动 workflow, 这自然避免多 session 冲突。

_原因_：这使人类能随时询问研究细节（功能 6：学生向导师解释；功能 7：导师指导细节——人类先问清再指导），agent 基于项目理解回答而非纯通用知识。

### 5.3 Terminal Action 概念删除

旧规则："每轮恰好一个 Terminal Action (dispatch/ask/present)，禁止其他"。
新设计：**Terminal Action 概念完全删除**。agent 自然地 dispatch worker / 暂停等待人类 / 呈现结果 / 回应用户消息，无需"终端形态"框架。用户中途问澄清，agent 正常回答即可。

_原因_：旧 Terminal Action 硬约束锁死了 agent 的响应通道——用户中途问一句澄清问题，agent 没有干净的通道去自然回应。"软化"仍保留框架，不如直接删除概念，让 agent 自然行为。

---

## 6. 执行：结构化但可灵活调度

### 6.1 保留结构化执行管理器

autoresearch 保留 Wave 拓扑排序 + 逐问题执行→验证→决策循环 + 重试 + 终止。

_原因_：agent 不会自然做这些——实测会频繁停下问"是否继续"（过度谨慎）、多步计划无显式结构会丢失追踪。autoresearch 的结构恰恰是因为 agent **不**擅长自然做这些才存在。"内化为常识"基本不可行——这是早期方案最大的错误。

_设计原则_：autoresearch skill 不是固定施工 workflow，而是注明 agent 必须做什么（验证产出文件、据 verdict 决策）和以什么方式做（dispatch local-executor/verifier），agent 据情况灵活推进。

### 6.2 质量判断：verifier 即 judge

旧设计的问题：把"验证"和"judgment"当两个东西——verifier 验证，judgment-worker 判断 verifier 是否 shallow。这是给"verifier 有时产出浅薄内容"打的补丁，越打越重（行数预筛 + shallow-judgment + failure-synthesis + 多类型计数器）。

**核心洞察：verifier 本身就是 judge。** 验证就是对执行质量的独立判断。不需要额外的 judgment 层。

新方案——执行后的质量判断：

```
per-question:
  1. dispatch local-executor → 产出 Qn_REASONING.md + Qn_EXECUTION.md
  2. 验证产出文件存在非空 → 不过则重跑 (max 2)
  3. dispatch research-verifier (独立 subagent) → 产出 Qn_VERIFICATION.md (verdict + evidence + 4 子项判定)
  4. 验证验证报告非空有 verdict → 不过则重跑 verifier (max 2)
  5. 据 verdict 决策:
     - PASS → resolved, 写结论到 research_state.md
     - FAIL/partial → retry (重跑 executor, cycle+1, max 3) 或 failed
     - cycle=3 → failed（连续 3 次未通过表明方法可能存在 agent 自身难以解决的深层问题，需外部介入）
     - 需人类决策 → pause

依赖处理: 对每个 dependency Qd，读 Qd_VERIFICATION.md 获取 conclusion
（无论 Qd 结果来自原定计划还是 fallback）。Qd failed+critical → Qn blocked（在确定处理列表时已排除）。
失败传播无需单独步骤——按 Wave 顺序处理时，后续 question 的依赖检查自然发现上游失败。

per-Wave:
  6. dispatch research-audit sub-subagent 检查跨问题一致性
     （避免后续 Wave 基于错误前提执行）

终止:
  7. 无 open question 时自然停止

phase 级:
  8. 最终 audit 审汇总质量
```

_为何可靠_：(1) verifier prompt 要求结构化产出（verdict + evidence + 4 子项 PASS/FAIL），结构 checker 验证其非空有 verdict——比"判断 verifier 是否 shallow 的 judgment-worker"简单得多且确定性。(2) verifier 是独立 subagent（research-verifier，按需加载领域 skill），天然提供执行者之外的独立判断。(3) 每 Wave 后 audit 检查跨问题一致性，覆盖单个 verifier 遗漏的矛盾。

### 6.3 删减项

删除：shallow-retry 双层机制 / 多类型计数器 / judgment-worker(failure-synthesis) / state.json.execution / 独立失败传播步骤（由依赖检查自然覆盖）/ 独立 early-abort 步骤（agent 自然终止）/ ENVIRONMENT.md rigid 格式 / domain_mode。

保留：Wave 拓扑排序 / 逐问题循环 / executor cycle 计数（max 3）+ verifier retry（max 2）/ 每 Wave 后 audit / 暂停问用户。

### 6.4 灵活调度（功能 4）

人类可在 research_state.md 的 Human Directives 指示执行调度。autoresearch 读取调度类指示调整 Wave：

- `优先做 Q3` → 若 Q3 依赖已满足，把 Q3 提到当前 Wave 最前；若 Q3 依赖未满足，**拒绝并解释**——依赖安全由 agent 判断守卫，不强行。
- `Q3 完成后暂停` → Q3 resolved 后写 Last Phase Result (status=needs_attention)，回传 needs_attention
- `Q5 暂缓` → Q5 标 deferred，不执行

（方法修改类指示如"Q2 方法改为 X"不属 execution 职责——由 primary agent 在 dispatch 前修改 PLAN.md + 记 Failed Attempts）

_原因_：这使人类能"先看几个问题的结果再决定其余怎么做"——真实研究的常见模式。

### 6.5 验证为错的理解（功能 5 的基础）

每个 failed attempt 记入 research_state.md 的 Failed Attempts：

```
- Q2: method "解析延拓" 失败
  原因: verification 显示 m→0 极限发散, 与 [src:b] §4 矛盾
  排除方向: 解析延拓类方法不适用
  下次尝试: 数值积分 (人类指示)
```

这使：agent 不重试已失败方向 / framing 回退时有依据 / 人类审核时能看到完整试错史 / 询问时 agent 能解释"为什么不用 X"（功能 6）。

---

## 7. 约束层：research-audit skill（结构检查 + 语义审计合一）

### 7.1 合一 rationale

结构 checker（确定性脚本，判存在性/格式/引用映射）与语义 audit（LLM，判内容合理性）性质不同，但都是"质量保证"能力。合并为单一 `research-audit` skill：scripts/（确定性检查）+ SKILL.md（语义审计指引）。worker 调用流程：先跑 scripts（bash，确定性，快）→ 再按 SKILL.md 指引做语义审计（LLM）。

_原因_：减少 skill 数量，概念统一为"质量保证"。旧设计把结构检查散落在 MCP + 3 个 audit phase + 3 个 repair skill 中，过度拆分。

### 7.2 分工

| 约束                          | 判定者                        | 性质     |
| ----------------------------- | ----------------------------- | -------- |
| 产物文件存在且非空            | 结构 checker (确定性)         | scripts/ |
| 引用 [src:id] 有对应下载文件  | 结构 checker (确定性)         | scripts/ |
| resolved claim 有验证记录     | 结构 checker (确定性)         | scripts/ |
| 验证记录含 verdict + evidence | 结构 checker (确定性)         | scripts/ |
| 推理是否真的成立              | 语义 audit (LLM, worker 自动) | SKILL.md |
| 引用是否真支持论断            | 语义 audit (LLM, worker 自动) | SKILL.md |
| 方法是否适用                  | 语义 audit (LLM, worker 自动) | SKILL.md |
| 领域覆盖是否充分              | 语义 audit (LLM, worker 自动) | SKILL.md |

_分工原因_：checker 只判存在性/结构，**不判内容合理性**——那是 audit 的活。早期方案曾误以为 checker 能完全取代 audit，但 checker 只能判"文件在不在""引用有没有下载文件"，无法判"推理是否真的成立""引用是否真支持论断"——这些是语义判断，必须 LLM audit。两者皆保留，但旧 3-audit-3-repair 循环收敛为单次轻量审计 + worker 自修（max 2）。

### 7.3 结构 checker（Python，两个 MCP 整体删除）

实现语言：Python（与 gpd/paper-search 生态一致）。check_sources.py / check_verification.py / check_artifacts.py / check_conventions.py，位于 research-audit skill scripts/。

research-state MCP 整体删除：旧 server.py（1833行）含 5 个 mutating tools + 8 个 read-only tools。mutating tools 随 FSM 删除；read-only tools 逐个分析后发现全部有更好替代方案——get_state/validate_state/get_progress/get_phase_info/validate_file_locations 由 agent 直接读 research_state.md + check_artifacts.py 覆盖；check_file_updated 由 worker 直接读文件覆盖；get_config 新流程不需要；run_health_check 迁移到 health-check skill scripts/。

research-conventions MCP 整体删除：旧 server.py（484行）含 7 个 tools，硬编码了物理 domain 知识（19 个约定键、合法值、跨字段规则）。convention 值存储迁移到 research_state.md 的 ## Conventions 节；ASSERT_CONVENTION 检查 + 完整性 + 跨字段一致性迁移到 research-audit skill 的 check_conventions.py（从 domain 约定 skill 的 reference 文件加载规则，不硬编码）；CONVENTION_OPTIONS + CROSS_FIELD_WARNINGS 迁移到 gpd-conventions skill reference 文件；skill_resolve_path 删除。两个 MCP 均不保留瘦身版本。

### 7.4 语义审计（通用，worker dispatch 独立 sub-subagent）

新设计——**通用 audit skill，worker 完成产出后 dispatch 独立 sub-subagent 做语义审计**。

_scripts 由 worker 直接跑（bash，确定性，无 bias）；语义审计由 worker dispatch 独立 sub-subagent（fresh context，不带 worker 推理历史，避免 self-review bias）。_ worker 刚完成产出，其 context 充满自己的推理过程，同一 context 自审会倾向于认为自己写的合理。sub-subagent fresh 读产物文件，提供独立判断。这与 debate 的 critique sub-subagent 机制一致。

_通用 audit skill 的原因_：一套 skill，sub-subagent 据具体 phase 产物类型自行判断审计方向。取代旧按 phase 拆三套 audit + 三套 repair。审计方向指引在 audit skill 内以"按产物类型"给出，sub-subagent 据产物内容自主选用。

_audit 时机_：各 phase 产出完成后、回传 status 前（质量门）；人类指示时。worker 据审计报告自修（推荐 2 次，非强制），严重问题（须写明无法自修的原因）写入 Last Phase Result issues，primary 据 phase 选择器决定回退重做。

### 7.5 辩论（简化保留，保留 rebuttal）

辩论审视 framing 的文本层合理性（问题 well-posed? 方案 sound? 遗漏路径?）。这是语义、定性判断，checker 做不到，单次 audit 可能漏。对抗结构有认识论价值。

_保留 rebuttal 的原因_：守方回应 critique 是辩论完整性的必要环节，避免 critique 单方面定调；adjudicator 据双方裁夺。

_新结构——debate skill 指引 worker 编排 critique/rebuttal，worker 自负 adjudication+repair_：

```
primary agent
  └─ dispatch research-worker (phase_debate)
       worker 调用 /debate skill 获取编排指引:
       ├─ sub-subagent: debate-critic  (agent 定义, 隔离 context, 找问题 SOUND/CONCERN/CRITICAL)
       ├─ sub-subagent: debate-rebuttal (agent 定义, 隔离 context, 读 DEBATE.md 回应 critique)
       ├─ worker 自行: adjudication (据 critique+rebuttal 裁决 UPHELD/REVISE/ESCALATE)
       └─ worker 自行: repair       (据裁决修订 PLAN, 写 DEBATE.md)
```

debate-critic 和 debate-rebuttal 是 agent 定义（`.aether/agent/`），不是 skill——它们被 dispatch 为隔离 sub-subagent，需独立 system prompt / permission。debate skill（`.aether/skills/debate/SKILL.md`）是编排指引，与其他 phase skill 一致。

_critique 与 rebuttal 隔离 sub-subagent 的原因_：两者立场对立，隔离保证独立性。

_adjudication 与 repair 由 worker 自己做的原因_：裁决与修订强相关（裁决决定修什么），由同一 worker 连续完成，避免反复 dispatch。

删 advocacy（预先辩护价值低，critique 已能找问题）与独立 repair skill（修由 worker 据裁决直接做）。max 2 轮。worker 内部管理轮次（不返回 primary 再 dispatch）。合计 dispatch：primary→worker(1) + worker→critique(1) + worker→rebuttal(1) × max 2 轮 = 最多 5 次（旧 15 次大幅简化）。DEBATE.md 结构不严格要求，agent 灵活组织。

---

## 8. 多阶段研究（功能 8，无显式 stage 分割）

研究之间不存在绝对的 stage 分割——后续研究自然建立在前序理解之上。因此 research_state.md **不显式分 stage**，而是连续演进：已解决/已讨论清楚的内容保留在原位标记，新内容直接在原文件增加/修改，待办在文件末尾"Next To Handle"节。

一个阶段研究完成（execution done）后，agent **呈现结果**（用户需看到结果），然后**自然停止**——不主动问"是否开启下一阶段"。用户若想基于现有结果继续研究，会自然发指令或直接编辑 research_state.md，agent 据 Human Directives 创建新 slug，进入新 analysis（基于 research_state.md 累积理解）。

_不主动问的原因_：与整体"用户主导、agent 不主动用 question list 打扰"的哲学一致。用户若要继续会自然发指令，不需要 agent 问。

---

## 9. 严谨性保证（科学约束）

灵活性不等于随意。以下硬约束由结构 + 语义双层保证：

1. **不编造来源**：所有引用 [src:id] 必须有下载文件（check_sources 确定性判定）。无下载文件 → claim 不得标 resolved。
2. **必须验证**：resolved claim 必须有 verification 记录含 verdict + evidence（check_verification 确定性判定）。空话不得 resolved。
3. **必须落盘**：各 phase 产物必须存在非空（check_artifacts 确定性判定）。
4. **推理须成立**：framing 推理链、execution 推理由语义 audit 判定合理性。不成立 → 回退重做。
5. **计算须核对**：物理/数学计算由确定性 SymPy 脚本核对（gpd-verification 保留），非 LLM 自说自话。
6. **诚实记录**：Failed Attempts 必须记录验证为错的理解/方法，防止重试与自欺。
7. **结论分级**：resolved / partial / failed / infeasible 严格区分，partial 不得冒充 resolved。

约束执行时机（worker 侧自动）：标 resolved 前 → check_sources + check_verification（声明前 gate, worker 跑）；phase 完成后 → check_artifacts + 通用语义 audit（质量门, worker 跑, 自修 max 2）；呈现结果前 → 全套结构 checker scripts（收尾 gate, primary 经 bash 跑，仅确定性脚本，不含语义审计——语义审计已由 worker 在 phase 完成时跑过）；物理计算 → gpd-verification SymPy 脚本。

---

## 10. skill / agent 清单

### 保留（可能简化）

research-worker / analysis（原 deep-research，重命名+简化） / research-question-framing / paper-search / literature-landscape-scan / literature-review / autoresearch / debate-critic + debate-rebuttal / gpd-\* skill（gpd-verifier agent 删除，gpd-verification/errors/domain-check/conventions skill 保留）/ health-check / env-setup

### 新增/合并

research-audit（结构 checker + 语义审计合一：scripts/ + SKILL.md）
debate-critic + debate-rebuttal（agent 定义，从旧 skill 迁移/新建）+ debate skill（编排指引）

### 删除

research-coordinator / research-audit-reasoning / research-audit-repair / research-audit-repair-reasoning / debate-advocate / debate-adjudicator / debate-repair / debate-critic(skill,迁为agent) / judgment-worker / gpd-verifier(agent,合并入research-verifier) / gpd-reviewer(agent,功能被research-audit+gpd-\*skill覆盖) / research-verification(skill,合并入research-verifier agent) / session-recovery决策树 / PhaseResultDigest复杂schema / ROADMAP.md / domain_mode / fallback_applicability / research-state MCP(整体删除) / research-conventions MCP(整体删除,convention迁移到research_state.md+check_conventions.py)

### 修改

research.md（重写：删 Entry Gate/Terminal Action，加 phase 选择器/对话式 pause/slug/多阶段）

---

## 11. 行数对比目标

|                                                               | 旧         | 新（目标）     |
| ------------------------------------------------------------- | ---------- | -------------- |
| 主干 (research.md + coordinator + refs + autoresearch + refs) | ~3230      | ~700           |
| phase skill 总量                                              | ~3000      | ~1800          |
| 状态存储份数                                                  | 5          | 1              |
| 确定性检查代码                                                | 0          | ~250           |
| session-recovery 决策树                                       | 284        | 0 (agent 自判) |
| **合计**                                                      | **~6000+** | **~2750**      |

核心：砍过度工程（FSM 路由/回滚机器/3-audit-3-repair/shallow-retry 双层/对账逻辑），保留工程必需（subagent 隔离/结构化执行/语义审计/辩论），加灵活性（对话式 pause/中断响应/灵活调度/多阶段/phase 选择器）。

---

## 12. 灵活性 × 严谨性 矩阵

| 场景                      | 灵活响应（agent）                                      | 严谨约束（代码/audit）                           |
| ------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| 人类问"Q2 为什么 partial" | 从 research_state.md + Q2 文件解释                     | 解释须引用实际验证记录                           |
| 人类"回 debate 重讨论 Q2" | phase 选择器重入 debate, 注入议题                      | debate 仍经 critique+rebuttal+adjudication       |
| 人类"Q2 改数值方法"       | 改 PLAN.md, 记旧方法到 Failed Attempts, 重入 execution | 新方法仍须验证 + check_verification              |
| 人类"删掉 Q5"             | 从 research_state.md 移除, 调整依赖图                  | 依赖 Q5 的问题标 blocked 或重框定                |
| 人类"目标改为证明 Y"      | 更新 Research Goal, 回 analysis 重来                   | 新目标仍经完整默认路径 + 约束                    |
| 人类"先做 Q3 看看"        | execution 调度 Q3 优先, 完成后 pause                   | Q3 依赖未满足则拒绝并解释; Q3 仍须验证 + checker |
| 执行发现 Q2 方法错        | 记 Failed Attempts, pause 问人类或回 framing           | 错误方向不重试                                   |
| 阶段完成                  | 呈现结果后自然停止, 等用户指示是否继续                 | 下一阶段（用户驱动）仍经约束                     |
| agent 中断后重启          | 读 research_state.md + 人类消息自判 (统一响应)         | 状态完整性由 checker 保证                        |

---

## 13. 已确认决策

1. **辩论结构**：保留 rebuttal。debate skill 指引 worker 编排 critique（agent 定义, 隔离 sub-subagent）→ rebuttal（agent 定义, 隔离 sub-subagent, 自读 DEBATE.md 获取 critique）→ worker 自做 adjudication + repair。critique/rebuttal 从 skill 改为 agent 定义（需独立 context）。删 advocate 与独立 adjudicator/repair skill。max 2 轮，最多 5 次 dispatch。DEBATE.md 结构不严格要求。（见 §7.5）
2. **audit 触发**：自动跑。scripts 由 worker 直接跑（bash）；语义审计由 worker dispatch 独立 sub-subagent（fresh context 避免 self-review bias）。通用 audit，sub-subagent 据产物类型自判审计方向，发现问题 worker 自修（推荐 2 次）。人类指示时亦执行。（见 §7.4）
3. **checker 实现**：Python。两个 MCP（research-state + research-conventions）整体删除——全部 tools 有替代方案（agent 直接读 research_state.md + check_artifacts/check_conventions.py 覆盖验证；run_health_check 迁移到 health-check skill scripts/；convention 值存 research_state.md ## Conventions 节）。checker 脚本入 research-audit skill scripts/。（见 §7.3）
4. **Path 1 研究上下文问答**：无显式命令。research agent 用询问关键词匹配 research_state.md，自行判断相关性，相关则加载项目上下文回答。（见 §5.2）
5. **多阶段 research_state.md 结构**：不显式分 stage。已解决/已讨论内容保留原位标记，新内容直接在原文件增加/修改，待办在文件末尾"Next To Handle"节。（见 §8）
6. **execution 灵活调度依赖安全**：agent 拒绝并解释。人类指示优先做某问题但其依赖未满足时，agent 不强行，而是说明依赖关系并给出选项。（见 §6.4）
7. **人类注入指示统一响应**：暂停点对话与中断后指示的 agent 响应逻辑一致，统一处理于 §3.3，消除原独立的中断恢复小节。（见 §3.3）
8. **ROADMAP.md 取消**：内容被 research_state.md/landscape_map.md/PLAN.md 瓜分。analysis 改为产出 `<workdir>analysis.md` + 初始化 research_state.md。（见 §3.4, §4.3）
9. **autoresearch judgment**：verifier 即 judge，取代 judgment-worker。执行后结构 checker 验产出非空→verifier 独立验证（含 verdict）→checker 验验证报告非空→据 verdict 决策。删 shallow-retry 双层/多类型计数器/failure-synthesis。语义质量由 phase 级通用 audit 兜底。（见 §6.2）
10. **guard+audit 合一**：结构 checker 脚本 + 语义审计指引合并为单一 research-audit skill（scripts/ + SKILL.md）。（见 §7.1）
11. **多阶段无需 agent 主动问**：execution 完成后呈现结果即自然停止，用户若要继续会自然发指令，不主动问"是否开启下一阶段"。（见 §8）
12. **slug 工作目录机制**：按阶段分离工作文件（notepads/<slug>/），research_state.md 跨阶段共享。slug 名由 agent 自由命名（约束：与项目相关 + 读 Workdir History 防冲突），无需确定性脚本；Active Workdir 完整路径记录在 research_state.md，agent 读取拼接；checker 强制验证文件在 Active Workdir 内兜底路径可靠性。（见 §3.6）
