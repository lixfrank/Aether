# newlayer-11: primary agent 重写 + 删除 research-coordinator

> `.aether/agent/research.md` (179行) 重写
> `.aether/skills/research-coordinator/` (541 SKILL.md + 3 refs 1110 + backup_repair.sh 68 = 1719行) 删除（已在 newlayer-1 处理）
> 对应设计文档 §2（架构总览）、§4.2（phase 选择器）、§5（人类交互）、§3.6（slug）

---

## 修改原因与设计依据

**大方向**：research.md 是 primary agent 定义，旧设计有 Entry Gate Path 0/1/2/3 分类 FSM + Terminal Action 硬约束 + phase 强制序，这些是把 agent 当状态机解释器。新设计改为 phase 选择器（智能判断下一步）+ 对话式 pause + 统一中断响应 + slug 管理 + 多阶段。research-coordinator skill（1719行）整体删除，有用知识迁移到 research.md 及各 phase skill。
**设计依据**：design doc §2（架构总览）、§4.2（phase 选择器）、§5（人类交互）、§3.6（slug）、§8（多阶段）、§13 决策 4/7/11/12。
**具体决策理由**：

- 删 Entry Gate Path FSM：旧 Path 0/1/2/3 分类是人为割裂——quick lookup 就直接搜，literature review 就做综述，不需先分类。新设计 agent 自然按请求性质响应（design doc §4.2）
- 删 Terminal Action 概念：不再设"终端形态"框架。agent 自然行为：dispatch worker / 暂停等人类 / 呈现结果 / 回应用户消息。无需硬约束或软化——直接描述行为
- phase 选择器取代条件路由表：agent 读 research_state.md 相关字段后自行判断下一步（design doc §4.2）
- 对话式 pause 取代 question list：人类需先理解工作状态才能给好指示，对话式让人能先问再决断（design doc §5.1）
- 统一中断响应：无论 agent 处于暂停等待还是被中断后重启，收到用户消息后响应逻辑一致——读消息 + research_state.md，自然回应，据需要更新状态（design doc §3.3）
- Hard Constraints 分层：primary agent 约束写在 research.md；per-phase / per-verification 约束写在各 skill/agent 中
- 询问类 prompt 为只读：询问类 prompt 只读不写，推进类 prompt 才启动 workflow，自然避免多 session 冲突

## 1. research.md 重写

### 删除（整体替换）

| 段落                                                                  | 理由                         |
| --------------------------------------------------------------------- | ---------------------------- |
| "ENTRY GATE — MANDATORY FIRST STEP" 整节                              | 不再有 Path 0/1/2/3 分类 FSM |
| "Classification Rules" 表                                             | 同上                         |
| "Gate Enforcement"                                                    | 同上                         |
| "Path 0/1/2" 描述                                                     | 同上                         |
| "Path 3 Skill Invocation"                                             | 同上                         |
| "Skill Invocation Mechanism"（compaction detection / re-invoke rule） | 同上                         |
| "Turn Termination" + "Terminal Action" 硬约束                         | Terminal Action 概念删除     |
| "Hard Constraints" 列表                                               | 替换为分层硬约束             |
| "Session Start" 旧流程                                                | 并入 §4 响应用户消息         |

### front matter 修改

```yaml
# 旧 front matter 中需删除的字段:
mcp:
  research-conventions: true # → 删（MCP 已删）
  research-state: true # → 删（MCP 已删）
permission:
  research_conventions_*: allow # → 删（MCP 工具权限，MCP 已删）
  research_state_*: allow # → 删（同上）

# 其余 front matter 不变:
# description / color / mode: primary / owns: research / permission 主体 / bash / webfetch / websearch / knowledge_search / question / todowrite / task / skill / external_directory
```

### 保留

- front matter 主体（description / color / mode / owns / permission 主体 / bash / webfetch 等）— 不变
- system-reminder 中不编造来源约束 — 保留
- "Write all research artifacts to .aether/research/" — 保留

### 新 research.md 内容规格

#### §1 身份

```markdown
你是 research agent（学生），人类用户是导师。

职责: 接到研究任务后按研究方法自主推进（analysis→landscape→framing→debate→execution），
在关键节点暂停听取导师指导，据指导与对问题的最新理解灵活选择下一步。

phase 有默认依赖序（分析→景观→框定→辩论→执行），但可在人类指示或执行发现 gap 时
回退/重入任意 phase。用户可随时介入、询问、调整方向。

你的通信风格简洁专业。
```

#### §2 状态读取与 phase 选择器

```markdown
## 每轮行为

1. 据当前任务读 persistence/research_state.md 的相关节（不必每轮读全文，据任务需要选读）
2. Read 用户最新消息（若有）

3. Phase 选择器（按优先级）:

   a. 若有 unprocessed Human Directives → 处理指示:
   - 指示要求回到 phase X → dispatch worker for phase X（注入指示上下文）
   - 指示要求调整方法/增删问题 → 修改对应产物文件, 据影响范围决定 phase
   - 其他 → 自然回应用户, 据对话内容判断是否更新 research_state.md
     （不机械分类消息类型，理解意图后自然响应）
     b. 若在 pause 点且人类未说"继续" → 等待人类消息
     c. 否则按默认前进路径推进到下一 phase: analysis → landscape → framing → debate → execution → [呈现结果]
     d. 若 execution 完成 → 呈现结果, 自然停止（不主动问"是否继续"）

这是 agent 判断, 不是条件路由表。判断依据（research_state.md 结构化字段）是确定的, 使判断可靠可追溯。
（各 phase skill 指定该 phase 需读 research_state.md 的哪些节，不在 research.md 中规定）
```

#### §3 Worker 派遣

```markdown
## Worker Dispatch

对 analysis/landscape/framing/debate/execution phase:
dispatch research-worker (subagent_type: "research-worker")
prompt 含: phase 名 + Active Workdir + 人类指示上下文（若有）
worker 在隔离 context 执行, 回传 status 信号 (completed/needs_attention)

worker 返回后:

1. 读 research_state.md 的 Last Phase Result 节 (phase/status/summary/issues)
2. 若 status=completed: git commit, phase 选择器决定下一步
3. 若 status=needs_attention: 呈现 summary + issues 给用户, 等待指示
   （具体情况由 Last Phase Result 的 summary/issues 传达——是部分完成、失败、还是等待决策）
4. git commit: git add .aether/research/ && git commit -m "research: phase_X"
5. phase 选择器决定下一步
```

#### §4 人类交互

```markdown
## 人类交互

### pause 点

agent 在以下节点暂停（输出简短摘要 + 等待人类消息, 不弹 question 选项列表）:

- analysis 完成后
- debate 完成后
- execution 中人类指示的暂停点（如"做完 Q3 暂停"）
- 遇到 open decision 时

pause 行为:

1. 输出简短摘要（目标进展、关键发现、待决事项）
2. 说: "我暂停等待你的审核。你可以询问细节、讨论方向、或指示下一步。"
3. 等待人类消息

### 响应用户消息

无论 agent 处于暂停等待、被中断后重启、还是首次收到用户 prompt，收到用户消息后:

1. 读 persistence/research_state.md（若存在）获取上下文 + 读用户消息
2. 据 prompt 语义判断用户意图，自然响应:
   - 询问研究细节 → 读相关产物文件回答（不启动 workflow, 不修改文件）
   - 推进工作 → 读 Last Phase Result, 按 phase 选择器继续或恢复 workflow
   - 新研究任务 → 若 research_state.md 不存在则初始化(slug + research_state.md), 进入 analysis;
     若存在则按多阶段处理（创建新 slug, 进入新 analysis）
   - 文献调研 → 调用 literature-review skill 直接产出文献报告（不走 analysis→...→execution workflow）
   - 方向指示 → 更新 research_state.md 的 Human Directives, phase 选择器重定向
   - 方法调整 → 修改产物文件 + 记录 Failed Attempts, 重入相应 phase
   - 讨论/其他 → 自然对话, 据需要更新 research_state.md
     （不机械分类——用户消息可能同时包含多种意图，agent 理解后自然响应）
3. 若方向调整影响 phase 选择, phase 选择器决定下一个 phase

agent 不区分 session 类型——据用户 prompt 的语义意图判断如何响应。
这自然避免多 session 冲突：询问类 prompt 只读不写, 推进类 prompt 才启动 workflow。
```

（Terminal Action 概念已删除——agent 自然地 dispatch worker / 暂停 / 呈现结果 / 回应用户消息，无需"终端形态"框架。）

#### §5 slug 管理

```markdown
## Slug 与工作目录

创建新研究阶段时:

1. 从 Research Goal 派生 slug 名（关键词连字符化, ≤30 字符）
2. 读 research_state.md 的 Workdir History 确认不冲突, 冲突加 -2/-3
3. 创建 notepads/<slug>/ 目录
4. 更新 research_state.md: Active Workdir + Workdir History
5. 旧 slug 目录保留不删

工作文件路径 = <workdir><filename>（Active Workdir 完整路径 + 文件名拼接）
```

#### §6 多阶段研究

```markdown
## 多阶段研究

execution 完成后: 呈现结果, 自然停止。不主动问"是否开启下一阶段"。
用户若想继续: 发指令或编辑 research_state.md 的 Human Directives 节。
agent 据 Human Directives 创建新 slug, 进入新 analysis（基于 research_state.md 累积理解）。
research_state.md 不显式分 stage, 连续演进。
```

#### §7 硬约束

```markdown
## Hard Constraints — primary agent (research.md)

- FORBIDDEN: 编造来源（与用户交流时不得编造引用或结论）
- FORBIDDEN: 编辑/写入 .aether/research/ 之外的文件（permission rules: edit deny \*, allow .aether/research/\*\*；check_artifacts.py 验证文件位置）
- MUST: worker 返回后读 Last Phase Result 再决定下一步
- MUST: phase 完成后 git commit（审计轨）
- MUST: 在 pause 点暂停等待人类（不跳过审核）
- MUST: 呈现结果前跑全套结构 checker scripts（research-audit skill scripts/，经 bash，仅确定性脚本）
- MUST: 不声称 resolved 而无验证记录（check_verification 确定性判定）
- subagent: dispatch research-worker only（phase 执行）；worker 内部自行 dispatch 其他 subagent

（per-phase / per-verification / per-subagent 约束见各自 newlayer 文档：newlayer-2~6 各 skill 质量门、newlayer-6 autoresearch 的 check_sources/check_verification/Failed Attempts、newlayer-8 research-verifier 的 SymPy 核对等。不在 research.md 中重复。）
```

---

## 2. research-coordinator skill 删除 — 有用知识迁移

coordinator skill（SKILL.md 541行 + 3 refs 1110行 + backup_repair.sh 68行 = 1719行）删除。以下是具体知识迁移：

### 从 coordinator SKILL.md 迁移

| coordinator SKILL.md 段落                  | 迁移到                        | 迁移内容                                                                                                                            |
| ------------------------------------------ | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| §Phase Routing（phase 依赖序说明）         | research.md §2 phase 选择器   | 默认序 analysis→landscape→framing→debate→execution + 可回退/重入                                                                    |
| §Dispatch Protocol（dispatch prompt 模板） | research.md §3 Worker 派遣    | 简化为：prompt = phase名 + Active Workdir + 指示上下文                                                                              |
| §Checkpoint（呈现内容优先级）              | research.md §4 pause 点       | 简化为"简短摘要"（目标进展/关键发现/待决事项）                                                                                      |
| §Git Commit 流程                           | research.md §3 step 5         | git add + commit -m "research: phase_X"                                                                                             |
| §Integrity 约束                            | research.md §7 硬约束（分层） | 拆分为 primary 约束 + per-skill 约束                                                                                                |
| §Convention awareness                      | 各 phase skill                | 读 research_state.md ## Conventions + check_conventions.py（任何 phase 发现需要时可写入，framing Step 9 是主要设置+验证点但非唯一） |
| §Notice Templates（4 类模板）              | 删除                          | 不再有固定模板，agent 自然输出                                                                                                      |
| §Terminal Action 规则                      | 删除                          | Terminal Action 概念删除                                                                                                            |
| §Entry Gate Path 分类                      | 删除                          | 不再有 Path 0/1/2/3                                                                                                                 |

### 从 coordinator references 迁移

| reference 文件                                          | 迁移到                          | 迁移内容                                                    |
| ------------------------------------------------------- | ------------------------------- | ----------------------------------------------------------- |
| phase-routing.md（条件分支决策表）                      | 删除                            | phase 选择器取代（agent 判断，非条件表）                    |
| phase-detail-tables.md（dispatch prompt 模板 + 映射表） | research.md §3 + 各 phase skill | dispatch 简化为 phase名+workdir+指示；各 skill 自含执行指引 |
| session-recovery.md（284行恢复决策树）                  | 删除                            | agent 读 research_state.md 自行判断（design doc §3.3）      |

---

## 3. 预期结果

- research.md: 179行 → ~180行（删 Entry Gate/Terminal Action/旧 Hard Constraints/Session Start，加 phase选择器/人类交互/slug/多阶段/分层约束）
- front matter: 删 mcp（2行）+ research\*\*\* permissions（2行）
- research-coordinator skill: 1719行 → 0（删除）
- 净减: 179 + 1719 → 180 = 净减 1718行

---

## 4. 验收目标

### 语义验收

- [ ] research.md 不含 Entry Gate / Path 0/1/2/3 / Classification Rules / Gate Enforcement / Terminal Action 概念
- [ ] research.md 含 phase 选择器逻辑（§2）：按优先级判断——unprocessed Human Directives → pause 点等待 → 默认前进路径 → execution 完成呈现结果
- [ ] research.md phase 选择器是 agent 判断而非条件路由表；判断依据（research_state.md 结构化字段）是确定的
- [ ] research.md §2 不规定各 phase 读 research_state.md 的哪些节（由各 skill 指定）
- [ ] research.md §2 不机械分类消息类型（理解意图后自然响应）
- [ ] research.md §3 Worker 派遣：dispatch research-worker，prompt 含 phase 名 + Active Workdir + 人类指示上下文
- [ ] research.md §3 worker 返回后：读 Last Phase Result → git commit → phase 选择器决定下一步
- [ ] research.md §4 含统一"响应用户消息"节（基于语义判断意图，含文献调研路径）
- [ ] research.md §4 不区分 session 类型（据语义意图判断响应）
- [ ] research.md §4 pause 点：analysis 完成后 / debate 完成后 / execution 中人类指示的暂停点 / 遇到 open decision 时；pause 行为为输出简短摘要 + 等待人类消息（不弹 question 选项列表）
- [ ] research.md §5 slug 管理：从 Research Goal 派生 slug（≤30 字符）+ 读 Workdir History 防冲突 + 旧 slug 保留不删
- [ ] research.md §6 多阶段研究：execution 完成后呈现结果自然停止，不主动问"是否开启下一阶段"
- [ ] research.md §7 硬约束只含 primary agent 约束 + 一句引用 per-skill 约束（分层）
- [ ] research-coordinator skill 目录已删，有用知识已迁移（§2 迁移表）
- [ ] coordinator references 中 session-recovery.md（284行恢复决策树）删除——agent 读 research_state.md 自行判断

### 脚本强制验收

- [ ] `不得存在` research.md 中的 `Entry Gate` / `Path 0` / `Path 1` / `Path 2` / `Path 3` / `Classification Rules` / `Gate Enforcement`
- [ ] `不得存在` research.md 中的 `Terminal Action` 概念
- [ ] `不得存在` research.md 中的 `Session Start` 独立流程（已并入 §4 响应用户消息）
- [ ] `不得存在` research.md front matter 中的 `mcp` 字段
- [ ] `不得存在` research.md front matter 中的 `research_state_*` / `research_conventions_*` 权限条目
- [ ] `不得存在` `skills/research-coordinator/` 目录（已删除）
- [ ] `不得存在` research.md 中的 `advance_plan` / `phase_rollback` 调用
- [ ] `不得存在` research.md 中的 `PhaseResultDigest` 引用
- [ ] `不得存在` research.md 中的 `file_scope` 引用（§7 硬约束中）
- [ ] `不得存在` research.md 中的 `phase_checkpoint` / `phase_checkpoint_callback` 引用
- [ ] research.md §7 硬约束含：FORBIDDEN 编造来源 / FORBIDDEN 编辑 .aether/research/ 之外文件 / MUST worker 返回后读 Last Phase Result / MUST phase 完成后 git commit / MUST 在 pause 点暂停等待人类 / MUST 呈现结果前跑全套结构 checker scripts / MUST 不声称 resolved 而无验证记录
