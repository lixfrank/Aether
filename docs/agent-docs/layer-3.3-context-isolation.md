# Layer 3.3: Path 3 Context Isolation — Phase-as-Subagent + Structured Digest Protocol

> 前置依赖: Layer 0-3.2（核心安全 + Agent 基础设施 + Research 配置层 + Research Infrastructure + Gap Analysis）
> 本文档定义 Path 3 (Research Project) 的上下文隔离架构：将 5 个 phase 从 coordinator 内联 skill 调用改为 isolated subagent dispatch + 结构化摘要协议。
> phase_execution (autoresearch) 进一步拆分为 execution_cycle + verification 两类 sub-phase，由 coordinator 管控重试循环。
> 预期效果：coordinator 常驻上下文从 ~100-230K tokens 降至 ~20K tokens，各 phase/sub-phase worker 独立 ~20-50K tokens 但互不累积。

---

## 目录

1. [问题分析](#1-问题分析)
2. [架构设计](#2-架构设计)
3. [文件改动清单](#3-文件改动清单)
4. [research-worker Agent 定义](#4-research-worker-agent-定义)
5. [DIGESTS.md 模板](#5-digestsmd-模板)
6. [research.md Coordinator 改写](#6-researchmd-coordinator-改写)
7. [SKILL.md Digest 输出步骤](#7-skillmd-digest-输出步骤)
8. [PhaseResultDigest Schema 定义](#8-phaseresultdigest-schema-定义)
9. [上下文占用对比](#9-上下文占用对比)
10. [验收清单](#10-验收清单)

---

## 1. 问题分析

### 1.1 当前架构的上下文累积

Path 3 在同一 research agent session 中顺序执行 5 个 phase（gate → analysis → landscape → framing → checkpoint → execution → completed），每一步向上下文窗口添加内容且不再移除：

| 来源                                                                      | 单 phase 增量                  | 到 phase_execution 时累积   |
| ------------------------------------------------------------------------- | ------------------------------ | --------------------------- |
| research.md 基础指令                                                      | ~10K tokens (始终存在)         | 10K                         |
| Skill SKILL.md 加载 (skill 工具注入)                                      | ~3-5K tokens/phase             | **17-20K** (4个 skill 累积) |
| 前序输出文件全文 re-read (STATE.md + ROADMAP.md + landscape_map.md + ...) | 随 phase 递增                  | **15-30K**                  |
| research-explorer subagent 返回 (搜索结果 + 论文摘要)                     | 2-4次 dispatch                 | **30-80K**                  |
| 自身 phase 产出写入工具调用                                               | 各 phase 的产出                | **20-40K**                  |
| sandbox-executor + verifier subagent 返回                                 | EXECUTION.md + VERIFICATION.md | **15-30K**                  |

**估算总占用: ~100-230K tokens** — 对 128K context 模型已明显超限，对 200K 模型逼近上限。

### 1.2 五个核心痛点

**痛点 A：Skill 加载不可撤销**
每次 `skill` 工具调用把完整 SKILL.md 注入上下文（4 个 skill 共 ~615 行）。phase 完成后这些指令不再有用（phase_analysis 的 173 行指令在 phase_execution 时完全冗余），但无法从上下文移除。

**痛点 B：前序输出全文 re-read**
每个 phase 的 Step 1 都要 "Read Current State" — 读 STATE.md、ROADMAP.md、landscape_map.md 等。这些文件逐 phase 增大，而 phase_execution 只需要 PLAN.md 的 contract 部分，却被迫承载了 phase 1-3 所有产出的全文。

**痛点 C：subagent 返回无裁剪**
research-explorer、sandbox-executor、gpd-verifier 返回的自由格式文本全部留在上下文中。论文搜索结果（20+条含摘要）尤其膨胀。

**痛点 D：无上下文压缩机制**
整个 state machine 没有任何 "summary → discard detail" 的设计。ROADMAP.md 被 append-only 更新而非替换，各 notepad 文件独立存在但全文驻留。

**痛点 E：autoresearch 重试循环线性累积**
autoresearch skill 内部有 execute → verify → 可能 retry 的循环。单次循环占用 ~40-90K tokens。若 acceptance tests 部分失败需要重试，Cycle 1 全部内容仍驻留上下文，Cycle 2 再加 ~40-90K → **总计 ~80-180K**。二次重试可达 ~120-270K。这是 phase_execution 中最严重的上下文问题，且当前设计无重试次数硬限制——worker 可能无限循环。

---

## 2. 架构设计

### 2.1 核心思路：Coordinator-Worker 分离 + Execution Sub-Phase 拆分

将 research agent 从 "单 session 内顺序调用 skill" 改为 "轻量 coordinator + isolated worker subagent"。phase_execution 进一步拆分为 execution_cycle + verification 两类 sub-phase，由 coordinator 管控重试循环：

```
Coordinator (research.md, ~20K tokens 常驻)
  │  只做: Entry Gate 分类 + phase routing + digest 管理 + 执行循环管控 + 用户交互
  │  不做: 不调用 phase skill, 不读取全量输出文件, 不 dispatch research-explorer 等
  │
  ├── task(subagent_type="research-worker", phase=analysis)
  │     → worker 在独立 session 中执行
  │     → worker 调用 /deep-research skill
  │     → worker dispatch research-explorer (delegation_depth=0)
  │     → worker 写 ROADMAP.md + research_analysis.md + STATE.md + advance_plan
  │     → worker 返回 PhaseResultDigest (YAML)
  │     → coordinator 解析 digest, 追加到 DIGESTS.md
  │
  ├── task(subagent_type="research-worker", phase=landscape)
  │     → worker 在独立 session 中执行
  │     → worker 调用 /literature-landscape-scan skill
  │     → worker dispatch research-explorer (delegation_depth=0)
  │     → worker 写 landscape_map.md + update ROADMAP.md + STATE.md + advance_plan
  │     → worker 返回 PhaseResultDigest
  │     → coordinator 追加到 DIGESTS.md
  │
  ├── task(subagent_type="research-worker", phase=framing)
  │     → worker 在独立 session 中执行
  │     → worker 调用 /research-question-framing skill
  │     → worker 写 PLAN.md + research_questions.md + STATE.md + advance_plan
  │     → worker 返回 PhaseResultDigest
  │     → coordinator 追加到 DIGESTS.md
  │
  ├── question(user) ─── phase_checkpoint (coordinator 直接处理)
  │     → coordinator 从 DIGESTS.md 读取 framing digest
  │     → coordinator 用 question 工具询问用户
  │     → 用户确认 → 开始 execution 循环
  │     → 用户拒绝 → re-dispatch worker 到对应修正 phase
  │
  │  ┌─── phase_execution 循环 (coordinator 管控) ───┐
  │  │                                                 │
  │  ├── task(subagent_type="research-worker",
  │  │        sub_phase=execution_cycle, cycle=1)
  │  │     → worker 在独立 session 中执行
  │  │     → worker 读 PLAN.md, 准备执行环境
  │  │     → worker dispatch sandbox-executor (delegation_depth=0)
  │  │     → worker 读 EXECUTION.md, 判断 acceptance tests
  │  │     → worker 写 STATE.md (cycle status)
  │  │     → worker 返回 execution_cycle_digest
  │  │     → coordinator 追加到 DIGESTS.md
  │  │
  │  ├── [tests_passed] → coordinator 决策: proceed to verification
  │  │
  │  ├── task(subagent_type="research-worker",
  │  │        sub_phase=verification)
  │  │     → worker 在独立 session 中执行
  │  │     → worker 读 EXECUTION.md + PLAN.md contract
  │  │     → worker dispatch gpd-verifier 或 research-verifier (delegation_depth=0)
  │  │     → worker 读 VERIFICATION.md
  │  │     → worker 写 STATE.md (verification status)
  │  │     → worker 返回 verification_digest
  │  │     → coordinator 追加到 DIGESTS.md
  │  │
  │  ├── [all claims verified] → coordinator 调用 advance_plan(completed)
  │  │                          → 向用户报告完成
  │  │
  │  ├── [some claims failed, retries < 3] → coordinator 决策: retry
  │  │    → 构造修订策略 (基于 verification_digest)
  │  │    → dispatch worker (sub_phase=execution_cycle, cycle=2+1)
  │  │    → 新 session, prompt 含修订策略
  │  │    → 循环回到 verification
  │  │
  │  ├── [max retries reached] → coordinator 向用户报告部分结果
  │  │                            → 询问下一步: abort / revise PLAN / manual intervention
  │  │
  │  └─── 循环结束 ───┘
  │
  └── completed ─── coordinator 读 final digest, 向用户呈现最终结果
```

### 2.2 关键设计决策

| 决策                           | 选择                                                                                           | 原因                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Phase 执行方式                 | 单一 research-worker subagent                                                                  | 权限集相近，避免维护多个 worker 定义                                                                                |
| Execution sub-phase 拆分       | 拆分为 execution_cycle + verification，由 coordinator 管控重试循环                             | 单 worker 内重试循环线性累积 (~80-180K for 2 cycles)；拆分后每 cycle 是新 session，0 累积                           |
| 重试决策者                     | coordinator（基于 digest 判断）                                                                | coordinator 基于 ~300 chars 的 digest 判断，而非在 ~80K tokens 残留上下文中判断                                     |
| 重试次数硬限制                 | max 3 execution cycles                                                                         | 防止无限循环；coordinator 在 dispatch 时检查 cycle count                                                            |
| MCP 调用归属 (phase 1-3)       | worker 在 phase 内调用 advance_plan + convention 检查                                          | 原子性更好（phase 完成 + 状态推进在同一 session），coordinator 不需要 MCP 管理                                      |
| MCP 调用归属 (phase_execution) | sub-phase worker 不调用 advance_plan；coordinator 在全部完成后调用                             | sub-phase 不是完整 phase transition，state 应停留在 phase_execution 直到所有 cycle 完成                             |
| Digest 格式                    | YAML（非 JSON）                                                                                | task tool 返回自由文本，YAML 在文本中更易标记和提取                                                                 |
| Digest 存储                    | 写入 `.aether/research/persistence/DIGESTS.md`                                                 | 不依赖对话历史持久性，支持 session recovery                                                                         |
| phase_checkpoint               | coordinator 直接处理（不 dispatch worker）                                                     | 需要与用户交互（question 工具），必须在 coordinator session                                                         |
| delegation_depth               | coordinator → worker: 不指定（默认允许嵌套）；worker → sub-subagent: depth=0                   | delegation_depth=0 禁止 task 工具（实现层语义）；非零值不控制嵌套层数，仅允许 task 工具使用                         |
| Coordinator 是否调用 skill     | Path 1/2 直接调用 skill，Path 3 只 dispatch worker                                             | Path 1/2 是轻量操作无需隔离，Path 3 是多 phase 重流程需要隔离                                                       |
| Worker 调用 skill 方式         | phase 1-3: worker 通过 skill 工具调用对应 SKILL.md；phase_execution: worker 使用内置 procedure | phase 1-3 的 skill 有完整 SKILL.md 值得加载；execution sub-phase 的 procedure 简短 (~50行)，不值得单独创建 SKILL.md |
| autoresearch SKILL.md          | 保留为参考文档，worker 不再通过 skill 工具调用                                                 | skill 内容已被拆分为 worker 内置的两个 sub-phase procedure，SKILL.md 仅供人类阅读理解整体流程                       |

### 2.3 状态管理职责划分

| 操作                           | 执行者      | 原因                                                                                           |
| ------------------------------ | ----------- | ---------------------------------------------------------------------------------------------- |
| advance_plan (phase 1-3)       | worker      | phase 完成 + 状态推进在同一 session，原子性                                                    |
| advance_plan (phase_execution) | coordinator | sub-phase 不触发 phase transition；coordinator 在全部 cycle 完成后调用 advance_plan(completed) |
| STATE.md 更新 (phase 1-3)      | worker      | phase 内更新更准确                                                                             |
| STATE.md 更新 (sub-phase)      | worker      | sub-phase 内更新 cycle/verification status                                                     |
| convention 检查 (MCP)          | worker      | phase/sub-phase 内需要约定上下文做决策                                                         |
| DIGESTS.md 追加                | coordinator | coordinator 解析 digest 后追加，确保摘要与 routing 一致                                        |
| phase routing 决策             | coordinator | coordinator 根据 digest.next_phase 决定下一步                                                  |
| 执行循环管控                   | coordinator | coordinator 判断 cycle count, 决定 retry/proceed/abort                                         |
| 用户交互 (question)            | coordinator | question 工具必须在 primary agent session                                                      |
| Session recovery               | coordinator | coordinator 读 STATE.md + state.json + DIGESTS.md 恢复上下文                                   |

### 2.4 state.json 一致性监控与恢复

Worker 在 phase 1-3 内调用 `advance_plan` 更新 state.json，但 digest 是在 worker 最终消息中返回。如果 worker 在调用 `advance_plan` 之后、输出 digest 之前崩溃，会导致 state.json 与 DIGESTS.md 不一致。

#### 一致性检查规则

Coordinator 在每次 worker 返回后（或 session recovery 时）执行以下检查：

1. 读取 `state.json` 的 `phase` 字段
2. 读取 `DIGESTS.md` 中最后一个 digest 的 `phase` 字段
3. 若 `state.json.phase` 与 DIGESTS.md 最新 digest 对应的 phase 不一致：
   - **state.json 超前于 DIGESTS.md**（worker 调了 advance_plan 但未返回 digest）：
     coordinator 调用 `advance_plan` 回退 state.json 到 DIGESTS.md 最新 digest 对应的 phase
   - **DIGESTS.md 超前于 state.json**（不可能场景，因 coordinator 先追加 digest 再路由）：
     coordinator 调用 `advance_plan` 推进 state.json 到 DIGESTS.md 最新 digest 对应的 phase
4. 若 state.json 和 DIGESTS.md 均为空，视为无活跃项目，走 Entry Gate

#### phase_checkpoint 拒绝后的 state 回滚

当用户在 checkpoint 拒绝研究计划时：

1. Coordinator 使用 `advance_plan` MCP 回退 state.json 到修正 phase（例如 `phase=phase_framing`）
2. Coordinator 更新 STATE.md 的 Current Phase 为修正 phase
3. Coordinator dispatch worker 到修正 phase，prompt 中包含用户反馈

回滚操作由 coordinator 执行，而非 worker。原因是：回滚是 coordinator 的 routing 决策，不属于任何 phase/sub-phase 的职责范围。

#### execution sub-phase 的 advance_plan 软约束风险

Worker prompt 中声明 "Execution sub-phases MUST NOT call advance_plan"，但这是软约束——MCP 权限系统无法按方法粒度区分 `advance_plan` 和 `get_state`，worker 的 frontmatter 允许整个 `research-state` MCP。

若 worker 无意调用 `advance_plan(phase=completed)`，后果：

- state.json 被错误推进到 "completed"，但 DIGESTS.md 中缺少 verification digest
- Coordinator session recovery 时读到 state.json="completed" 可能跳过未完成工作
- 研究项目被错误标记为已完成，实际可能有未验证的 claims

缓解措施：

- Coordinator 在每次 worker 返回后执行一致性检查（见上方规则），若发现 state.json 超前则回退
- Worker system prompt 中 "MUST NOT call advance_plan" 使用 HARD CONSTRAINT 标记，与 Integrity 规则并列

#### 文件锁机制

为防止 coordinator 与 worker 同时修改 STATE.md、state.json 等文件造成竞态：

- **规则**: Coordinator dispatch worker 后，不再修改 worker 可能写入的文件（STATE.md、state.json），直到收到 worker digest 或超时
- **Worker 崩溃时**: Coordinator 通过 task tool timeout 或错误返回感知 worker 失败，此时 coordinator 恢复文件写入权限，执行一致性检查和恢复
- **并发保护**: 同一时刻只有 coordinator 或 worker 其中一方持有文件写入权。这不是文件系统级别的锁（不需要 flock），而是通过 dispatch-then-wait 的顺序执行协议保证

### 2.5 Task Dispatch 失败处理

当 coordinator 通过 task tool dispatch worker 失败（模型错误、超时等）：

1. **重试**: Coordinator 最多重试 2 次（共 3 次尝试），每次重新构造 prompt 和 dispatch
2. **重试间隔**: 无需等待，立即重试（task tool 内部已有 timeout 机制）
3. **3 次均失败**: Coordinator 向用户报告错误，终止当前 session，提供以下信息：
   - 失败的 phase/sub_phase 名称
   - 失败原因（从 task tool 错误消息提取）
   - 当前已完成的工作（从 DIGESTS.md 总结）
   - 建议：用户可尝试重新启动 session，或手动干预
4. **部分完成**: 如果是 execution 循环中的某个 cycle 失败，coordinator 检查 DIGESTS.md 中已有结果，向用户报告已完成的部分和失败的部分

### 2.6 Digest 解析容错

Coordinator 从 task_result 中提取 digest 时可能遇到格式问题。处理策略：

1. **正常流程**: 从 `<task_result>` 中找到 ```yaml 代码块，提取 `phase_result_digest` key
2. **YAML 格式错误**: 若 YAML 解析失败或缺少必要字段：
   - Coordinator 不依赖 LLM 理论上能解析 YAML，而是从文件系统推断状态
   - 读取 STATE.md 的 Current Phase 确认 worker 是否已写入文件
   - 检查 worker 应写入的文件是否存在（如 ROADMAP.md、PLAN.md、EXECUTION.md）
   - 根据文件存在性 + STATE.md 内容构造一个 fallback digest，追加到 DIGESTS.md
3. **Worker 未输出 digest**: 若 task_result 中完全没有 YAML 代码块：
   - 检查 worker 应写入的文件是否存在
   - 若文件存在：推断 phase 已完成，构造 fallback digest，继续路由
   - 若文件不存在：视为 worker 失败，按 Task Dispatch 失败处理（重试或报告）

Fallback digest 格式：

```yaml
phase_result_digest:
  phase: [从 STATE.md 推断]
  sub_phase: [从 STATE.md 推断, 若 applicable]
  cycle: [从 STATE.md 推断, 若 applicable]
  status: completed # 基于文件存在性推断
  note: "Fallback digest — coordinator inferred from filesystem state"
  output_paths:
    [key]: [确认存在的文件路径]
  next_phase: [从 state machine 规则推断]
```

### 2.7 与现有架构的兼容性

- **Path 1 (Quick Lookup)**: 不受影响。alpha-research skill 在 coordinator session 内直接调用，无需隔离。
- **Path 2 (Literature Review)**: 不受影响。literature-review skill 在 coordinator session 内直接调用，它有自己的内部 state machine。
- **Path 3 (Research Project)**: 架构完全改变。coordinator 不再调用 phase skill，改为 dispatch worker。phase_execution 进一步拆分为 coordinator 管控的循环。
- **Subagent 权限体系**: 无核心源文件改动。task tool 的 `Permission.intersection` + `Discipline.compile` + `delegation_depth` 机制已完整实现（Layer 0）。
- **MCP 服务器**: 无改动。worker 定义声明 `mcp: { research-conventions: true, research-state: true }`，权限交集允许 worker 使用这些 MCP 工具。
- **现有 subagent 定义**: research-explorer、sandbox-executor、gpd-verifier、research-verifier 无改动。它们由 worker 内部 dispatch（delegation_depth: 0），与现有模式一致。
- **autoresearch SKILL.md**: 保留为参考文档。不再通过 skill 工具调用，但内容仍可作为整体流程的参考。

---

## 3. 文件改动清单

| 文件                                                | 操作     | 核心变更                                                                                          |
| --------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------- |
| `.aether/agent/research-worker.md`                  | **新建** | Phase 执行 subagent 定义（frontmatter + system prompt，含 sub-phase procedures）                  |
| `.aether/research/persistence/DIGESTS.md`           | **新建** | 结构化摘要存储模板                                                                                |
| `.aether/agent/research.md`                         | **大改** | Path 3 从 skill 调用改为 worker dispatch + digest 路由 + 执行循环管控                             |
| `.aether/skills/deep-research/SKILL.md`             | **小改** | 加 digest 输出步骤 + 修改 return 指令                                                             |
| `.aether/skills/literature-landscape-scan/SKILL.md` | **小改** | 加 digest 输出步骤 + 修改 return 指令                                                             |
| `.aether/skills/research-question-framing/SKILL.md` | **小改** | 加 digest 输出步骤 + 修改 return 指令                                                             |
| `.aether/skills/autoresearch/SKILL.md`              | **保留** | 不再被 worker 调用，保留为参考文档。加注释说明此 skill 已被拆分为 worker 内置 sub-phase procedure |

核心源文件改动：**零**。全部改动在 `.aether/` 配置层。

---

## 4. research-worker Agent 定义

### 4.1 Frontmatter

```yaml
---
description: Execute a single research phase or execution sub-phase in isolated context and return structured digest
color: "#3B82F6"
mode: subagent
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  edit: allow
  write: allow
  bash: allow
  webfetch: allow
  websearch: allow
  knowledge_search: allow
  question: allow
  todowrite: allow
  task: allow
  skill: allow
  external_directory: ask
  research_conventions_*: allow
  research_state_*: allow
mcp:
  research-conventions: true
  research-state: true
skill_refs:
  - alpha-research
env_scope:
  allowed_commands:
    - alpha
    - uv
    - curl
    - rg
    - grep
    - git
    - docker
output_dir: ".aether/research"
file_scope:
  - ".aether/research/**"
---
```

### 4.2 设计要点

- **mode: subagent**: 只能被 coordinator 通过 task 工具 dispatch，不能作为 primary agent
- **task: allow**: 需要 dispatch research-explorer / sandbox-executor / verifier。coordinator 不指定 delegation_depth（默认允许嵌套），worker dispatch sub-subagent 时指定 delegation_depth=0（禁止进一步嵌套）
- **skill: allow**: phase 1-3 通过 skill 工具调用对应 SKILL.md；phase_execution sub-phase 使用内置 procedure（不调用 skill）
- **MCP 双服务器**: worker 在 phase 1-3 内自行调用 advance_plan 和 convention 检查；sub-phase worker 只调用 convention 检查（不调用 advance_plan）
- **skill_refs 仅含 alpha-research**: 其他 skill 通过 skill 工具按需加载
- **env_scope 与 research.md 一致**: alpha CLI、uv、docker 等命令均需要

### 4.3 System Prompt

````markdown
# Research Worker — Phase & Sub-Phase Executor

You are a subagent that executes ONE research phase or execution sub-phase and returns a structured digest to the coordinator.

## Phase Execution Protocol

1. Read the dispatch prompt to identify: phase name, sub_phase (if applicable), skill to invoke, project context
2. Read `.aether/research/persistence/STATE.md` to confirm current phase
3. Execute the phase/sub-phase according to the routing below
4. After completing, output a PhaseResultDigest as your FINAL message

## Phase Routing

| phase           | sub_phase       | Execution method                        |
| --------------- | --------------- | --------------------------------------- |
| phase_analysis  | (none)          | Invoke /deep-research skill             |
| phase_landscape | (none)          | Invoke /literature-landscape-scan skill |
| phase_framing   | (none)          | Invoke /research-question-framing skill |
| phase_execution | execution_cycle | Follow execution_cycle procedure below  |
| phase_execution | verification    | Follow verification procedure below     |

For phase 1-3 (analysis, landscape, framing): invoke the specified skill via the skill tool, follow all steps in SKILL.md, then output digest.

For phase_execution sub-phases: follow the embedded procedures below (do NOT invoke /autoresearch skill).

## Execution Cycle Procedure (sub_phase=execution_cycle)

1. Read `output_dir/persistence/PLAN.md` — extract contract (claims, acceptance_tests, forbidden_proxies)
2. Read `output_dir/persistence/STATE.md` — confirm phase_execution
3. Read convention_lock_status via research-conventions MCP
4. Prepare execution: identify scripts, environment requirements, copy project files into output_dir
5. Dispatch sandbox-executor via task tool (delegation_depth: 0):
   - Pass PLAN.md contract reference, environment requirements, convention context, file paths
6. Read `output_dir/persistence/EXECUTION.md` produced by sandbox-executor
7. Evaluate acceptance tests:
   - All passed → status: completed, next_sub_phase: verification
   - Some failed → status: partial, revision_needed: brief description of what to revise
   - Inconclusive → status: inconclusive
8. Update STATE.md with cycle status
9. Output execution_cycle_digest (see schema below)

## Verification Procedure (sub_phase=verification)

1. Read `output_dir/persistence/EXECUTION.md` + PLAN.md contract section
2. Read `output_dir/persistence/STATE.md` — confirm execution cycle completed
3. Dispatch verifier — follow the EXPLICIT verifier specification from coordinator's dispatch prompt:
   - If prompt specifies gpd-verifier: dispatch gpd-verifier (uses gpd-verification + gpd-domain-check + gpd-conventions)
   - If prompt specifies research-verifier: dispatch research-verifier (uses research-verification)
   - If prompt specifies both (physics domain): dispatch gpd-verifier first, then research-verifier for domain-agnostic checks
   - Use delegation_depth: 0
4. Read `output_dir/persistence/VERIFICATION.md` produced by verifier
5. Evaluate claims:
   - All verified → status: completed
   - Some failed → status: partial, list failed claims
   - Computational oracle overrides LLM-only judgment → respect oracle results
6. Update STATE.md with verification status
7. Output verification_digest (see schema below)

## PhaseResultDigest Format (MANDATORY)

Your LAST message MUST be a single YAML code block with the `phase_result_digest` key. No other text after this block.

```yaml
phase_result_digest:
  phase: [phase_analysis | phase_landscape | phase_framing | phase_execution]
  sub_phase: null | execution_cycle | verification # null for phase 1-3
  cycle: null | 1 | 2 | 3 # null except for execution_cycle
  status: completed | partial | failed | skipped | inconclusive
  # Phase/sub-phase-specific fields — see schemas below
  output_paths:
    [key]: [relative path from output_dir]
  next_phase: [next phase name per state machine]
  skip_recommendation: null | [justification if next phase can be skipped]
```
````

### Phase-specific schemas

**phase_analysis** (deep-research):

```yaml
research_question: "[core question]"
domain: physics | cs | biomedical | cross-disciplinary
key_findings:
  - "[Finding 1, max 200 chars]"
gaps_identified:
  - "[Gap 1, max 100 chars]"
schools_preview:
  - name: "[School Name]"
    representative_papers: ["arXiv:XXXX.XXXXX"]
```

**phase_landscape** (literature-landscape-scan):

```yaml
schools:
  - name: "[School Name]"
    core_idea: "[1 sentence]"
    representative_papers: ["arXiv:XXXX.XXXXX"]
gap_list:
  - id: gap_N
    description: "[1 sentence]"
    significance: H | M | L
    difficulty: H | M | E
controversies:
  - topic: "[topic]"
    positions: ["School A: X", "School B: Y"]
```

**phase_framing** (research-question-framing):

```yaml
research_questions:
  - question: "[full question]"
    framework: SMED | PICO | General
    falsification_criterion: "[1 sentence]"
claims:
  - claim: "[1 sentence]"
    acceptance_test: "[1 sentence]"
forbidden_proxies: ["[proxy 1]"]
execution_method: "[Python | C++ | Mathematica]"
verification_approach: gpd-verifier | research-verifier
```

**phase_execution — execution_cycle sub-phase**:

```yaml
tests_passed: ["[test 1]", "[test 2]"]
tests_failed: ["[test N]"]
tests_inconclusive: ["[test M]"]
execution_summary: "[brief: what was run, key results]"
revision_needed: null | "[what to revise if tests failed]"
```

**phase_execution — verification sub-phase**:

```yaml
claims_verified: ["[claim 1]", "[claim 2]"]
claims_failed: ["[claim N]"]
claims_inconclusive: ["[claim M]"]
key_numerical_results: ["[brief result 1]", "[brief result 2]"]
```

## Subagent Dispatch Rules

- Allowed: research-explorer, sandbox-executor, gpd-verifier, gpd-reviewer, research-verifier
- FORBIDDEN: explore or general subagents for research work
- When dispatching sub-subagents, set delegation_depth: 0

## MCP Calls

- Phase 1-3: You MAY call advance_plan, get_state, and convention tools. State management is your responsibility.
- Execution sub-phases: You MAY call convention tools and get_state, but MUST NOT call advance_plan. The coordinator manages the phase_execution → completed transition after all cycles finish.

## Integrity

Never fabricate sources. Never claim verification without evidence. Never override computational oracle results with LLM-only reasoning. Never silently adjust acceptance criteria when tests fail.

`````

---

## 5. DIGESTS.md 模板

文件路径: `.aether/research/persistence/DIGESTS.md`

````markdown
# Phase Result Digests

> This file stores structured summaries from each completed phase and execution sub-phase.
> The coordinator reads this file to understand project progress without loading full phase outputs.
> Each digest is appended after a phase or sub-phase completes.
> Full phase outputs remain in their original files — digests are lightweight references only.

---
`````

**追加方式**: coordinator 每次收到 worker digest 后，优先使用 edit 工具在 `---` 分隔线后追加完整 YAML 文本。若 edit 工具匹配失败（如 oldString 不精确匹配），fallback 到 read 整个 DIGESTS.md → 用 write 工具重写整个文件（保留已有内容 + 追加新 digest）。

**Session recovery**: coordinator session 开始时读 STATE.md + state.json + DIGESTS.md，从 digests 中恢复已完成 phase 的摘要信息，无需读取全量输出文件。对于 phase_execution，DIGESTS.md 包含所有 execution_cycle 和 verification digest，coordinator 可判断当前处于哪个 cycle。

---

## 6. research.md Coordinator 改写

### 6.1 Frontmatter — 无变化

现有权限已包含 `task: allow` 和 `skill: allow`，coordinator 需要 dispatch worker 和调用 Path 1/2 的 skill。`research_state_*: allow` 允许 coordinator 调用 advance_plan（phase_execution 完成时需要）。

### 6.2 删除整个 Phase Details 段落

删除范围: 从 `## Phase Details` 标题到 `### Phase: phase_execution → completed` 结束（约第192-257行）。

这些步骤现在由 worker 在 isolated context 中执行。coordinator 只需要知道 phase 名称 → 执行方式 → dispatch 参数 的映射，不需要知道每个 phase 的详细步骤。

### 6.3 替换 State Machine 图

旧图 (第122-146行):

```
phase_analysis     ─── deep-research skill
phase_landscape    ─── literature-landscape-scan skill
phase_framing      ─── research-question-framing skill
phase_checkpoint   ─── Summarize final plan to user
phase_execution    ─── autoresearch skill
```

新图:

```
phase_analysis     ─── dispatch research-worker
                       Worker invokes /deep-research skill
                       Worker writes ROADMAP.md + research_analysis.md
                       Worker calls advance_plan, updates STATE.md
                       Worker returns PhaseResultDigest
                       Coordinator appends digest to DIGESTS.md
  │
  ▼
phase_landscape    ─── dispatch research-worker
                       Worker invokes /literature-landscape-scan skill
                       Worker writes landscape_map.md, updates ROADMAP.md
                       Worker calls advance_plan, updates STATE.md
                       Worker returns PhaseResultDigest
                       Coordinator appends digest to DIGESTS.md
  │
  ▼
phase_framing      ─── dispatch research-worker
                       Worker invokes /research-question-framing skill
                       Worker writes PLAN.md + research_questions.md
                       Worker calls advance_plan, updates STATE.md
                       Worker returns PhaseResultDigest
                       Coordinator appends digest to DIGESTS.md
  │
  ▼
phase_checkpoint   ─── Coordinator reads DIGESTS.md (framing digest)
                       Coordinator composes summary from digest
                       Coordinator uses question tool → ask user
                       MUST NOT proceed without user confirmation
                       If rejected → re-dispatch worker for revised phase
  │
  ▼
phase_execution    ─── Coordinator-managed execution loop:
                       ┌─────────────────────────────────────┐
                       │                                     │
                       │  dispatch worker (sub_phase=         │
                       │    execution_cycle, cycle=1)         │
                       │    → sandbox-executor → EXECUTION.md │
                       │    → execution_cycle_digest          │
                       │                                     │
                       │  [tests_passed] → dispatch worker    │
                       │    (sub_phase=verification)          │
                       │    → gpd-verifier/research-verifier  │
                       │    → VERIFICATION.md                 │
                       │    → verification_digest             │
                       │                                     │
                       │  [all verified] → advance_plan(      │
                       │    completed) → exit loop            │
                       │                                     │
                       │  [some failed, retries<3] →          │
                       │    dispatch worker (sub_phase=       │
                       │    execution_cycle, cycle=N+1)       │
                       │    with revision strategy            │
                       │    → loop back to verification       │
                       │                                     │
                       │  [max retries] → report to user      │
                       │                                     │
                       └─────────────────────────────────────┘
  │
  ▼
completed          ─── Coordinator reads final digest, presents results to user
```

### 6.4 新增 Coordinator Routing Protocol 段落

替代被删除的 Phase Details 段落：

```markdown
## Coordinator Routing Protocol (Path 3)

### Phase Dispatch Table

| Phase           | Execution method                                                    | Worker dispatch 参数                               |
| --------------- | ------------------------------------------------------------------- | -------------------------------------------------- |
| phase_analysis  | Worker invokes /deep-research skill                                 | phase=analysis                                     |
| phase_landscape | Worker invokes /literature-landscape-scan skill                     | phase=landscape                                    |
| phase_framing   | Worker invokes /research-question-framing skill                     | phase=framing                                      |
| phase_execution | Worker uses built-in sub-phase procedures (NOT /autoresearch skill) | sub_phase=execution_cycle or verification, cycle=N |

### Dispatch Procedure (phase 1-3)

For each phase (analysis, landscape, framing):

1. Read STATE.md — confirm current phase matches expected phase
2. Read state.json via research-state MCP (get_state) — confirm machine state
3. Read DIGESTS.md — gather summaries from completed phases for prompt construction
4. Construct worker prompt:
```

Execute [phase_name] of the Path 3 research project.

Project context:

- Research question: [from user prompt or previous digest]
- Previous phase summaries: [relevant sections from DIGESTS.md]
- Output directory: .aether/research
- Skill to invoke: /[skill_name]

After completing all skill steps, output a PhaseResultDigest as your final message.

```

5. Dispatch worker via task tool:

```

task(
description: "[phase_name] research phase",
subagent_type: "research-worker",
max_steps: 25,
timeout_seconds: 300,
prompt: "[constructed prompt]"
)

````

### Digest Processing (after each worker returns)

1. Extract YAML block from `<task_result>` — find ```yaml code block containing `phase_result_digest`
2. Parse key fields: phase, sub_phase, status, next_phase, output_paths
3. If status=completed:
   - Append digest YAML text to `.aether/research/persistence/DIGESTS.md` via edit tool
   - Route to next phase/sub-phase per state machine

**Phase routing rules** (applied by coordinator after each digest):

| Digest next_phase         | Coordinator action                                                      |
| ------------------------- | ----------------------------------------------------------------------- |
| phase_landscape           | Dispatch worker (phase=landscape)                                       |
| phase_framing             | Dispatch worker (phase=framing)                                         |
| phase_checkpoint          | Coordinator handles directly (NO worker dispatch) — see section below   |
| phase_execution           | Start execution loop — dispatch worker (sub_phase=execution_cycle, cycle=1) |
| completed                 | Present final results to user                                           |
| null (sub-phase digest)   | Coordinator decides next sub-phase based on sub_phase + cycle + status   |

Note: `next_phase: phase_checkpoint` in the framing digest signals coordinator to enter checkpoint mode. After user confirms at checkpoint, coordinator routes to phase_execution (this transition is coordinator's routing decision, not derived from a digest).
4. If status=failed:
   - Append digest to DIGESTS.md (record failure)
   - Present error summary to user
   - Ask: retry this phase / revise scope / abort?
5. If status=skipped:
   - Write skip justification to STATE.md
   - Route to next phase per skip rules

### phase_checkpoint (NO subagent dispatch)

1. Read DIGESTS.md — extract framing digest
2. Optionally read PLAN.md Contract section via grep + offset/limit (NOT full file read)
3. Compose concise summary for user from digest + PLAN.md Contract:
   - Research question(s) framed
   - Claims to verify
   - Methodology to use
   - Expected deliverables
   - Verification criteria
4. Use question tool: "Based on the analysis, here is the research plan: [summary]. Shall I proceed with execution?"
5. MUST NOT proceed without user confirmation
6. If user rejects:
   - Coordinator calls advance_plan via MCP to roll back state.json to the correction phase
   - Coordinator updates STATE.md Current Phase to the correction phase
   - Then re-dispatch worker to the correction phase:
     - If research questions wrong → re-dispatch worker with phase=framing + revised scope
     - If entire direction wrong → re-dispatch worker with phase=analysis + revised scope
     - If literature coverage insufficient → re-dispatch worker with phase=landscape + revised scope

### Execution Loop (phase_execution)

phase_execution 使用 coordinator 管控的循环，而非单次 worker dispatch。

#### Cycle 1

1. Dispatch worker (sub_phase=execution_cycle, cycle=1):

````

task(
description: "execution cycle 1",
subagent_type: "research-worker",
max_steps: 20,
timeout_seconds: 300,
prompt: "Execute execution_cycle (cycle 1) of phase_execution.
Read PLAN.md contract, prepare execution, dispatch sandbox-executor.
Domain: [from framing digest verification_approach].
After completing, output execution_cycle_digest as your final message."
)

```

2. Read execution_cycle_digest from task_result
3. Append to DIGESTS.md
4. Decision based on digest.status:
   - completed (all tests_passed) → proceed to verification
   - partial (some tests_failed) → proceed to verification anyway (check what can be verified)
   - failed → ask user: retry / revise / abort?
   - inconclusive → proceed to verification (may get clearer results)

#### Verification (after each execution cycle)

5. Dispatch worker (sub_phase=verification):

```

task(
description: "verification after cycle [N]",
subagent_type: "research-worker",
max_steps: 15,
timeout_seconds: 240,
prompt: "Execute verification sub-phase of phase_execution.
Read EXECUTION.md and PLAN.md contract section.
Domain: [physics or general, from framing digest].
Verifier to dispatch: [EXPLICIT — coordinator specifies one of: gpd-verifier, research-verifier, or both gpd-verifier+research-verifier for physics].
For physics domain: dispatch gpd-verifier first, then research-verifier for domain-agnostic checks.
For non-physics domain: dispatch research-verifier only.
After completing, output verification_digest as your final message."
)

```

6. Read verification_digest from task_result
7. Append to DIGESTS.md
8. Decision based on digest:
   - All claims_verified → call advance_plan(phase=completed) via research-state MCP → present results to user → completed
   - Some claims_failed, cycle < 3 → retry with revised strategy
   - Some claims_failed, cycle = 3 (max retries) → present partial results, ask user for decision

#### Retry (cycle 2-3)

9. Construct revision strategy based on previous cycle's execution_cycle_digest (revision_needed) and verification_digest (claims_failed)
10. Dispatch worker (sub_phase=execution_cycle, cycle=N+1):

```

task(
description: "execution cycle [N+1] (retry)",
subagent_type: "research-worker",
max_steps: 20,
timeout_seconds: 300,
prompt: "Execute execution_cycle (cycle [N+1]) of phase_execution — RETRY.
Previous cycle [N] failed on: [tests_failed from previous execution_cycle_digest].
Suggested revision: [revision_needed from previous execution_cycle_digest].
Apply revision and re-dispatch sandbox-executor.
After completing, output execution_cycle_digest as your final message."
)

```

11. Loop back to step 2 (read digest → proceed to verification)

#### Max retries: 3 execution cycles

Coordinator MUST NOT dispatch more than 3 execution_cycle workers. After 3 failed cycles, present partial results to user and ask for manual intervention.

### phase_execution → completed

When verification shows all claims verified:

1. Call advance_plan(phase=completed, plan_number=6) via research-state MCP
2. Update STATE.md: phase=completed
3. Read final verification digest from DIGESTS.md
4. Optionally read VERIFICATION.md for detail (grep key sections, NOT full read)
5. Present results summary to user based on digest

### Phase Skip Rules (unchanged from original)

- phase_landscape CAN be skipped ONLY if conditions in original research.md are met
- Skip check: coordinator reads DIGESTS.md (analysis digest's skip_recommendation field) or ROADMAP.md
- All other phases: FORBIDDEN to skip
```

### 6.5 修改 Subagent Dispatch Rules

旧 (第292-296行):

```
- FORBIDDEN: Using explore or general subagents for research work. Use research-explorer for evidence gathering, sandbox-executor for execution, gpd-verifier/research-verifier for verification.
- Allowed: research-explorer, sandbox-executor, gpd-verifier, gpd-reviewer, research-verifier
- explore/general: ONLY for non-research auxiliary tasks
```

新:

```
- FORBIDDEN: Dispatching explore, general, research-explorer, sandbox-executor, gpd-verifier, or research-verifier directly for Path 3 phase work. All Path 3 phases and sub-phases are dispatched via research-worker subagent.
- Allowed for Path 3: research-worker only. Worker internally dispatches research-explorer/sandbox-executor/verifiers with delegation_depth: 0.
- Allowed for Path 2: literature-review skill handles its own subagent dispatch internally
- explore/general: ONLY for non-research auxiliary tasks
```

### 6.6 修改 Session Recovery

旧 (第263-274行):

```
1. Read `.aether/research/persistence/STATE.md` and `state.json`
2. If an active project exists:
   - Resume from the current phase
   - Read the current phase's output files to understand context
```

新:

```
1. Read `.aether/research/persistence/STATE.md`, `state.json`, and `DIGESTS.md`
2. If an active project exists:
   - Resume from the current phase
   - Read DIGESTS.md to understand completed phases' summaries (NOT full output files)
   - If current phase is phase_execution: check DIGESTS.md for execution_cycle and verification digests to determine current cycle number and status
   - Dispatch research-worker for the current phase or next execution sub-phase based on STATE.md and digests
3. If no active project:
   - Run the Entry Gate for the first user prompt
```

### 6.7 修改 Turn Termination

旧 (第306-314行):

```
- Calling a skill (to enter a workflow phase)
- Dispatching a subagent (to delegate a task)
- Asking the user (ONLY in phase_checkpoint)
- Updating STATE.md (to record phase completion)
```

新:

```
- Dispatching research-worker subagent (to execute a phase or execution sub-phase)
- Processing a PhaseResultDigest (extracting and appending to DIGESTS.md)
- Managing execution loop (dispatching execution_cycle or verification worker, deciding retry)
- Calling advance_plan via MCP (ONLY when phase_execution completes)
- Asking the user (ONLY in phase_checkpoint or after max retries)
```

删除 "Calling a skill" — coordinator 不再直接调用 phase skills。新增 "Managing execution loop" 和 "Calling advance_plan"。

---

## 7. SKILL.md Digest 输出步骤

Phase 1-3 的 3 个 skill 各需两项修改：修改 return 指令 + 新增 digest 输出步骤。

autoresearch SKILL.md 不再被 worker 调用，改为参考文档。

### 7.1 deep-research/SKILL.md

**修改 Step 7: Update State (第147-155行)**

旧第3点:

```
3. Return to the research agent — the agent will route to the next phase
```

新第3点:

```
3. Output a PhaseResultDigest as your final message (see Step 8). The coordinator will route to the next phase based on the digest.
```

**新增 Step 8: Output PhaseResultDigest (在 Step 7 之后追加)**

````markdown
### Step 8: Output PhaseResultDigest

Output a YAML code block as your FINAL message with this schema:

```yaml
phase_result_digest:
  phase: phase_analysis
  sub_phase: null
  cycle: null
  status: completed
  research_question: "[core question from user prompt]"
  domain: [physics | cs | biomedical | cross-disciplinary]
  key_findings:
    - "[Finding 1, max 200 chars]"
    - "[Finding 2, max 200 chars]"
    - "[Finding 3, max 200 chars]"
  gaps_identified:
    - "[Gap 1, max 100 chars]"
    - "[Gap 2, max 100 chars]"
  schools_preview:
    - name: "[School Name]"
      representative_papers: ["arXiv:XXXX.XXXXX"]
  output_paths:
    roadmap: persistence/ROADMAP.md
    analysis: notepads/[slug]/research_analysis.md
  next_phase: phase_landscape
  skip_recommendation: null | "[justification if landscape phase can be skipped]"
```
````

MUST NOT output any other text after this YAML block. The coordinator parses this digest to route the next phase.

```

### 7.2 literature-landscape-scan/SKILL.md

**修改 Step 8: Update State (第155-161行)**

旧第3点:

```

3. Return to the research agent — the agent will route to phase_framing

```

新第3点:

```

3. Output a PhaseResultDigest as your final message (see Step 9). The coordinator will route to the next phase based on the digest.

````

**新增 Step 9: Output PhaseResultDigest**

```markdown
### Step 9: Output PhaseResultDigest

Output a YAML code block as your FINAL message with this schema:

```yaml
phase_result_digest:
  phase: phase_landscape
  sub_phase: null
  cycle: null
  status: completed
  schools:
    - name: "[School Name]"
      core_idea: "[1 sentence summary]"
      representative_papers: ["arXiv:XXXX.XXXXX"]
  gap_list:
    - id: gap_1
      description: "[1 sentence]"
      significance: [H | M | L]
      difficulty: [H | M | E]
    - id: gap_2
      description: "[1 sentence]"
      significance: [H | M | L]
      difficulty: [H | M | E]
  controversies:
    - topic: "[debate topic]"
      positions: ["School A: position X", "School B: position Y"]
  output_paths:
    landscape_map: notepads/[slug]/landscape_map.md
  next_phase: phase_framing
````

MUST NOT output any other text after this YAML block.

```

### 7.3 research-question-framing/SKILL.md

**修改 Step 8: Update State (第150-154行)**

旧第3点:

```

3. Return to the research agent — the agent will enter phase_checkpoint

```

新第3点:

```

3. Output a PhaseResultDigest as your final message (see Step 9). The coordinator will enter phase_checkpoint based on the digest.

````

**新增 Step 9: Output PhaseResultDigest**

```markdown
### Step 9: Output PhaseResultDigest

Output a YAML code block as your FINAL message with this schema:

```yaml
phase_result_digest:
  phase: phase_framing
  sub_phase: null
  cycle: null
  status: completed
  research_questions:
    - question: "[full formulated question text]"
      framework: [SMED | PICO | General]
      falsification_criterion: "[1 sentence]"
  claims:
    - claim: "[1 sentence assertion]"
      acceptance_test: "[1 sentence verification method]"
  forbidden_proxies:
    - "[proxy 1 description]"
    - "[proxy 2 description]"
  execution_method: "[Python | C++ | Mathematica | theoretical derivation]"
  verification_approach: [gpd-verifier | research-verifier]
  output_paths:
    plan: persistence/PLAN.md
    research_questions: notepads/[slug]/research_questions.md
  next_phase: phase_checkpoint
````

MUST NOT output any other text after this YAML block.

````

### 7.4 autoresearch/SKILL.md — 改为参考文档

autoresearch SKILL.md 不再被 worker 通过 skill 工具调用。phase_execution 的逻辑已被拆分为 worker 内置的 execution_cycle 和 verification 两个 sub-phase procedure。

**改动**：在 SKILL.md 头部添加注释：

```markdown
> **NOTE**: This skill is retained as a reference document describing the overall execution-verification flow.
> In the Layer 3.3 context isolation architecture, the worker does NOT invoke this skill via the skill tool.
> Instead, phase_execution is split into two sub-phases (execution_cycle + verification) with coordinator-managed retry loops.
> The execution_cycle and verification procedures are embedded in the research-worker agent definition (see .aether/agent/research-worker.md).
> This SKILL.md is useful for understanding the intended flow but is NOT invoked at runtime.
````

其余内容保持不变（作为参考）。

---

## 8. PhaseResultDigest Schema 定义

### 8.1 Envelope Schema (所有 phase/sub-phase 共享)

```yaml
phase_result_digest:
  phase: string # phase_analysis | phase_landscape | phase_framing | phase_execution
  sub_phase: string|null # null | execution_cycle | verification
  cycle: integer|null # null | 1 | 2 | 3 (only for execution_cycle)
  status: string # completed | partial | failed | skipped | inconclusive
  output_paths: map # key → relative path from output_dir
  next_phase: string # next phase per state machine (null for sub-phases — coordinator decides)
  skip_recommendation: string|null
```

### 8.2 Phase/Sub-phase-specific Fields

| Phase/Sub-phase                   | 必需字段                                                                                             | 可选字段                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ |
| phase_analysis                    | research_question, domain, key_findings, gaps_identified, output_paths                               | schools_preview, skip_recommendation |
| phase_landscape                   | schools, gap_list, controversies, output_paths                                                       | skip_recommendation                  |
| phase_framing                     | research_questions, claims, forbidden_proxies, execution_method, verification_approach, output_paths | skip_recommendation                  |
| phase_execution → execution_cycle | tests_passed, tests_failed, tests_inconclusive, execution_summary, output_paths                      | revision_needed                      |
| phase_execution → verification    | claims_verified, claims_failed, claims_inconclusive, key_numerical_results, output_paths             | —                                    |

### 8.3 长度约束

| 字段类型                     | 最大长度    | 原因                                           |
| ---------------------------- | ----------- | ---------------------------------------------- |
| research_question            | 500 chars   | 核心问题需精炼                                 |
| key_findings 单条            | 200 chars   | 摘要级别，细节在文件中                         |
| gaps_identified 单条         | 100 chars   | 摘要级别                                       |
| schools.core_idea            | 200 chars   | 一句话概括                                     |
| gap_list.description         | 200 chars   | 一句话概括                                     |
| claims 单条                  | 200 chars   | 摘要级别                                       |
| controversies.positions 单条 | 200 chars   | 摘要级别                                       |
| execution_summary            | 300 chars   | 需包含执行概述                                 |
| revision_needed              | 300 chars   | 需包含修订建议                                 |
| key_numerical_results 单条   | 300 chars   | 需包含数值                                     |
| tests_passed 单条            | 200 chars   | 验收测试名称                                   |
| tests_failed 单条            | 200 chars   | 验收测试名称                                   |
| claims_verified 单条         | 200 chars   | 摘要级别                                       |
| claims_failed 单条           | 200 chars   | 摘要级别                                       |
| schools 列表                 | max 6 items | 防止膨胀                                       |
| gap_list 列表                | max 5 items | 防止膨胀                                       |
| key_findings 列表            | max 5 items | 防止膨胀                                       |
| claims 列表                  | 不限制      | 提供完整信息，coordinator 需全部 claims 做决策 |
| key_numerical_results 列表   | max 5 items | 防止膨胀                                       |
| tests_passed 列表            | max 5 items | 防止膨胀                                       |
| tests_failed 列表            | max 5 items | 防止膨胀                                       |

单个 digest 总 YAML 文本: **max ~3K chars (~750 tokens)**。

- Phase 1-3: 3 个 digest ≈ ~2K tokens
- Phase_execution: 1 次 cycle = 1 execution_cycle_digest + 1 verification_digest ≈ ~1.5K tokens；3 次 cycle max ≈ ~4.5K tokens
- **总 coordinator 常驻**: ~6K tokens (最差情况 3 cycles)

### 8.4 Coordinator 解析方式

task tool 返回格式:

````
task_id: ses_xxxxx (for resuming to continue this subagent session if needed)

<task_result>
... worker 的最终文本，包含 ```yaml phase_result_digest ... ``` 代码块 ...
</task_result>
````

Coordinator 解析步骤:

1. 从 `<task_result>` 中找到 ```yaml 代码块
2. 检查代码块是否包含 `phase_result_digest:` key
3. 提取完整 YAML 文本
4. 追加到 DIGESTS.md
5. 提取 phase, sub_phase, cycle, status, next_phase 字段决定路由

无需 YAML parser — coordinator (LLM) 自然理解 YAML 内容。

---

## 9. 上下文占用对比

### 9.1 Coordinator 上下文

| 内容                                 | 旧架构                   | 新架构 (含执行循环)                                     |
| ------------------------------------ | ------------------------ | ------------------------------------------------------- |
| research.md 基础指令                 | ~10K tokens              | ~10K tokens (精简版)                                    |
| Skill SKILL.md 加载                  | ~17-20K (4个 skill 累积) | **0** (coordinator 不调用 phase skill)                  |
| 前序输出文件全文                     | ~15-30K                  | **0** (只读 DIGESTS.md + selective grep)                |
| Subagent 返回 (research-explorer 等) | ~30-80K                  | **0** (worker 内部 dispatch)                            |
| Phase 产出写入工具调用               | ~20-40K                  | **0** (worker 写文件)                                   |
| sandbox-executor + verifier 返回     | ~15-30K                  | **0** (worker 内部 dispatch)                            |
| PhaseResultDigest 存储               | N/A                      | **~6K** (3 phases + max 3 cycles × 2 sub-phase digests) |
| DIGESTS.md 文件读取                  | N/A                      | **~6K**                                                 |
| Worker dispatch 工具调用             | N/A                      | **~3K** (phase 1-3 × 1 + max 3 cycles × 2)              |
| advance_plan MCP 调用                | N/A                      | **~0.5K** (1 次 at phase_execution completion)          |
| **总计**                             | **~100-230K**            | **~22K**                                                |

### 9.2 Worker 上下文

| Worker 类型            | 估算    | 说明                                        |
| ---------------------- | ------- | ------------------------------------------- |
| phase_analysis worker  | ~35-76K | 含 skill 加载 + research-explorer dispatch  |
| phase_landscape worker | ~35-76K | 含 skill 加载 + research-explorer dispatch  |
| phase_framing worker   | ~15-30K | 含 skill 加载，无 subagent dispatch         |
| execution_cycle worker | ~20-45K | 含 PLAN.md read + sandbox-executor dispatch |
| verification worker    | ~20-40K | 含 EXECUTION.md read + verifier dispatch    |

**关键**: 每个 worker 是独立 session。重试循环不累积 — cycle 2 的 execution_cycle worker 是全新 session，不承载 cycle 1 的 sandbox-executor 结果。

### 9.3 autoresearch 重试对比

| 方面           | 旧架构 (单 session)                    | 新架构 (sub-phase 拆分)                 |
| -------------- | -------------------------------------- | --------------------------------------- |
| 单次循环占用   | ~40-90K (在同一 session 内)            | execution_cycle: ~20-45K (独立 session) |
|                |                                        | verification: ~20-40K (独立 session)    |
| 2次循环总占用  | ~80-180K (累积)                        | **0 累积** — 每次是新 session           |
| 3次循环总占用  | ~120-270K (累积)                       | **0 累积** — 每次是新 session           |
| 重试决策上下文 | ~80-180K tokens 残留 (worker 自行判断) | ~300 chars digest (coordinator 判断)    |
| 最大循环限制   | 无硬限制                               | max 3 cycles (coordinator 管控)         |

### 9.4 总体对比

| 方面                     | 旧架构                             | 新架构                               |
| ------------------------ | ---------------------------------- | ------------------------------------ |
| 累积方式                 | 所有 phase 在同一 session 线性累积 | 每个 phase/sub-phase 在独立 session  |
| phase_execution 时总占用 | ~100-230K                          | coordinator: ~22K + 任意 worker ≤45K |
| 最差情况 (3次重试)       | ~120-270K                          | coordinator: ~22K + 单 worker ≤45K   |
| 128K 模型可行性          | 完全超限                           | 可运行（worker 独立 session）        |
| phase 间信息传递         | 全文驻留上下文                     | ~6K digest 摘要                      |
| Session recovery 依赖    | 对话历史 + 全量文件                | DIGESTS.md + STATE.md                |

**总减少: ~80-90% 累积占用**。Coordinator 从 ~100-230K 降至 ~22K，每个 worker 独立 ≤45K。

---

## 10. 验收清单

### 10.1 Coordinator 路由

1. Entry Gate 分类正确（Path 0/1/2/3 不受影响）
2. Path 1 仍使用 alpha-research skill 直接调用（无 subagent）
3. Path 2 仍使用 literature-review skill 直接调用（无 subagent）
4. Path 3 coordinator 不调用任何 phase skill（只 dispatch worker）
5. Coordinator 正确解析 task_result 中的 ```yaml phase_result_digest 代码块
6. Coordinator 正确追加 digest 到 DIGESTS.md（优先 edit 工具，失败时 fallback 到 write）
7. Coordinator 根据 digest.next_phase 正确路由到下一 phase
   7a. Coordinator 正确处理 phase_checkpoint 路由：framing digest next_phase=phase_checkpoint → coordinator 直接处理 → 用户确认后路由到 phase_execution
8. phase_checkpoint 由 coordinator 直接处理（使用 question 工具）
9. 用户拒绝 checkpoint 后 coordinator 先回退 state.json (advance_plan) + 更新 STATE.md + re-dispatch worker 到修正 phase

### 10.2 执行循环管控

10. Coordinator 在 phase_execution 时 dispatch execution_cycle worker (cycle=1)
11. Coordinator 正确判断 execution_cycle_digest.status 决定是否 proceed to verification
12. Coordinator dispatch verification worker — prompt 中明确指定 verifier（gpd-verifier / research-verifier / both）
13. Coordinator 正确判断 verification_digest 决定: completed / retry / abort
14. Coordinator 在 all claims verified 时调用 advance_plan(phase=completed)
15. Coordinator 在 some claims failed 且 cycle < 3 时 dispatch execution_cycle worker (cycle=N+1) with revision strategy
16. Coordinator 在 cycle = 3 (max retries) 时停止循环，向用户报告部分结果
17. Coordinator 不 dispatch 超过 3 个 execution_cycle worker
18. Retry prompt 包含前次 cycle 的 tests_failed 和 revision_needed 信息

### 10.3 Worker 执行

19. research-worker subagent 可通过 task 工具 dispatch（mode=subagent 正确）
20. Worker 正确处理 phase routing（phase 1-3 调用 skill，sub-phase 使用内置 procedure）
21. Worker 可 dispatch research-explorer (delegation_depth: 0)
22. Worker 可 dispatch sandbox-executor (delegation_depth: 0)
23. Worker 可 dispatch gpd-verifier 或 research-verifier (delegation_depth: 0)
24. Worker 正确调用 advance_plan MCP (phase 1-3 only)
25. Worker 在 execution sub-phase 不调用 advance_plan
26. Worker 正确调用 convention_lock_status MCP
27. Worker 输出 PhaseResultDigest YAML 作为最终消息
28. Worker 不输出其他文本在 digest 之后
29. Worker 遵守长度约束（claims 列表不截断，提供完整信息）

### 10.4 Digest 存储

30. DIGESTS.md 文件存在于 `.aether/research/persistence/`
31. Phase 1-3 完成后 DIGESTS.md 包含对应的 digest YAML
32. Execution sub-phase 完成后 DIGESTS.md 包含 execution_cycle_digest 和 verification_digest
33. Digest YAML 包含正确的 phase/sub_phase/cycle 字段
34. Digest output_paths 指向正确的相对路径
35. 多次 session recovery 后 DIGESTS.md 仍包含全部已完成 phase/sub-phase 的 digest

### 10.5 状态一致性

36. Coordinator 每次 worker 返回后检查 state.json 与 DIGESTS.md 一致性
37. 若 state.json 超前于 DIGESTS.md（worker crash 后），coordinator 回退 state.json 到 DIGESTS.md 最新 digest 对应的 phase
38. 若 digest 解析失败，coordinator 从文件系统推断状态（STATE.md + 文件存在性）构造 fallback digest
39. 若 worker 未输出 digest 且文件未写入，coordinator 按 Task Dispatch 失败处理（重试或报告）

### 10.6 Task Dispatch 容错

40. Coordinator dispatch worker 失败时最多重试 2 次（共 3 次尝试）
41. 3 次均失败时向用户报告错误并终止 session
42. Execution 循环中某 cycle 失败时，coordinator 向用户报告已完成部分和失败部分

### 10.7 Session Recovery

43. Coordinator session 开始时读 STATE.md + state.json + DIGESTS.md
44. Recovery 后 coordinator 执行一致性检查（state.json vs DIGESTS.md）
45. Recovery 后 coordinator 正确路由到当前 phase（不 re-run gate）
46. Recovery 后 coordinator 从 DIGESTS.md 恢复已完成 phase 的摘要（不读全量输出文件）
47. Recovery 后 coordinator 判断 execution 循环状态（当前 cycle number, 上次 verification 结果）

### 10.8 上下文占用

48. Coordinator 上下文不超过 ~25K tokens（含 3 cycles 的 digests）
49. 单个 worker 上下文不超过 ~50K tokens
50. Worker 上下文不跨 phase/sub-phase 累积（每个是独立 session）
51. Execution cycle 2-3 的 worker 上下文与 cycle 1 无累积关系

### 10.9 autoresearch SKILL.md 参考

52. autoresearch SKILL.md 保留为参考文档，头部包含注释说明不再被 worker 调用
53. autoresearch SKILL.md 内容与 worker 内置 sub-phase procedure 语义一致（整体流程相同，只是拆分为两个 sub-phase + coordinator 管控重试）

### 10.10 回退安全

54. 删除 research-worker.md + DIGESTS.md 后，恢复旧版 research.md 即可回退到旧架构
55. SKILL.md 的 digest 步骤不影响 skill 的核心功能（skill 的 procedure 步骤不变）
56. autoresearch SKILL.md 可恢复为被 worker 调用（回退到单 worker 模式）
57. Layer 0-3.2 的改动不受本层影响
58. 核心源文件零改动
59. fallback_models 字段已从 research.md 和 research-worker.md 中移除（用户应在 UI 界面指定模型）
