# newlayer-10: subagent 更新

> research-worker.md (289行) / local-executor.md (303行)
> research-verifier.md 见 newlayer-8
> 对应设计文档 §4.3（phase 能力包）、§6.2（verifier 即 judge）、§7.5（debate skill 编排）

---

## 修改原因与设计依据

**大方向**：research-worker 是各 phase 的隔离执行器，旧设计有复杂 PhaseResultDigest schema（6 种）+ phase routing 表 + advance_plan 调用规则。新设计简化为 status 信号 + Last Phase Result 回传机制 + 新 routing 表 + debate skill 编排逻辑（debate skill 内容见 newlayer-5）。
**设计依据**：design doc §4.3（phase 能力包）、§7.5（debate skill 编排）、§6.2（verifier 即 judge）、§3.3（统一中断响应）、§13 决策 1/9。
**具体决策理由**：

- 删复杂 digest schema（176行）：旧 6 种 PhaseResultDigest schema 是 FSM 路由的产物，新改为 status 信号 + Last Phase Result 节（design doc §4.4, newlayer-1 §5）
- 新增 debate 编排 skill：critique+rebuttal 作为隔离 sub-subagent（agent 定义），adjudication+repair 由 debate skill 指引 worker 自做（design doc §7.5, §13 决策 1, newlayer-5）
- 删 judgment-worker dispatch：verifier 即 judge 取代（design doc §6.2, §13 决策 9）
- MCP 调用简化：research-state + research-conventions 两个 MCP 整体删除，状态管理改为 worker 直接读写 research_state.md，约定管理改为读写 ## Conventions 节 + check_conventions.py，确定性检查改为 research-audit skill scripts（design doc §3.1, newlayer-1 §2/§2b）
- research-verifier 强化 verdict：verifier 即 judge，须输出 verdict 供 execution worker 决策（design doc §6.2, newlayer-8）
- local-executor 路径改为 <workdir>：配合 slug 机制（design doc §3.6）

## 1. research-worker.md 修改

> 文件：`.aether/agent/research-worker.md` (289行)

### 删除

| 段落                                                                                                | 行(约) | 理由                                          |
| --------------------------------------------------------------------------------------------------- | ------ | --------------------------------------------- |
| system-reminder 中 "MUST NOT call advance_plan"                                                     | 40     | advance_plan 已删                             |
| system-reminder 中 "LAST message MUST be single YAML with phase_result_digest"                      | 42     | 改为 status 信号                              |
| system-reminder 中 "Execution phase MUST NOT call advance_plan. Autoresearch internally manages..." | 40     | 简化                                          |
| Phase Routing 表 (76-93)                                                                            | —      | 改为新路由表                                  |
| PhaseResultDigest Format 节 (95-271)                                                                | —      | 全部复杂 schema 替换为简化格式                |
| "MCP Calls" 节 (280-284)                                                                            | —      | research-state MCP 整体删除, 见 newlayer-1 §2 |

### 保留

- front matter permission / owns — 不变；mcp 字段删除（research-state + research-conventions MCP 均已删除，见 M5）
- system-reminder 中 不编造来源 等硬约束 — 保留（Python 执行策略不在 research-worker 中规定，各 skill/agent 自行指定）
- "Write all research artifacts to .aether/research/" — 保留
- Phase Execution Protocol 总体结构（读 dispatch prompt → 执行 → 回传 status 信号）— 保留
- Subagent Dispatch Rules — 简化（删 allowed 列表，改为"可 dispatch 同 owner 的 subagent"，各 skill 指定实际 dispatch 谁）
- Integrity 节 — 保留

### 修改

#### M1. Phase Routing 表

```markdown
# 旧 (76-93行)

| phase | sub_phase | Execution method |
| phase_analysis | (none) | Invoke /deep-research skill |
| phase_landscape | (none) | Invoke /literature-landscape-scan skill |
| phase_framing | (none) | Invoke /research-question-framing skill |
| phase_debate | advocacy | Invoke /debate-advocate skill |
| phase_debate | critique | Invoke /debate-critic skill |
| phase_debate | rebuttal | Invoke /debate-advocate skill |
| phase_debate | adjudication | Invoke /debate-adjudicator skill |
| phase_debate | repair | Invoke /debate-repair skill |
| phase_execution | (none) | Invoke /autoresearch skill |
| health_check | (none) | Invoke /health-check skill |

# 新

| phase        | Execution method                                                                              | 产出                                                            |
| ------------ | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| analysis     | Invoke /analysis skill                                                                        | <workdir>analysis.md + 初始化 research_state.md                 |
| landscape    | Invoke /literature-landscape-scan skill                                                       | <workdir>landscape_map.md                                       |
| framing      | Invoke /research-question-framing skill                                                       | <workdir>PLAN.md + research_questions.md + framing_reasoning.md |
| debate       | Invoke /debate skill（编排 critique/rebuttal sub-subagent + worker 自做 adjudication+repair） | <workdir>DEBATE.md + 修订 PLAN.md                               |
| execution    | Invoke /autoresearch skill                                                                    | <workdir>execution/Qn\_\*.md + EXECUTION.md + VERIFICATION.md   |
| health_check | Invoke /health-check skill                                                                    | health 报告                                                     |

各 phase 完成后: worker 跑 research-audit scripts (bash, 确定性), 然后 dispatch research-audit sub-subagent 做语义审计 (fresh context), 据报告自修 (推荐 2 次), 然后更新 research_state.md 的 Last Phase Result 节 + 回传 status 信号。
```

#### M2. worker 回传机制

```markdown
## Worker Return (MANDATORY)

worker 完成 phase 后:

1. 按 phase skill 指引更新 persistence/research_state.md（各 skill 指定更新哪些节）
2. 在 research_state.md 的 **Last Phase Result** 节写入: phase / status / summary / issues
3. 回传消息（LAST message）仅含 status 信号: completed | needs_attention

primary agent 读 research_state.md 的 Last Phase Result 节获取详情。
（各 phase skill 指定具体更新 research_state.md 的哪些内容，research-worker.md 只规定回传机制本身）
```

#### M3. 删除旧 debate 编排节

debate 编排逻辑不再在 research-worker.md 中定义。worker 调用 /debate skill 获取编排指引（与其他 phase 一致：analysis/landscape/framing/execution 都是 skill）。debate skill 内容见 newlayer-5。

#### M4. Subagent Dispatch Rules

```markdown
# 旧

- Allowed: research-explorer, local-executor, gpd-verifier, gpd-reviewer, research-verifier
- FORBIDDEN: explore or general subagents

# 新

worker 可 dispatch 同 owner (research) 的 subagent（task: allow + own/owner 机制兜底）。
无需在 system-reminder 中维护 allowed 列表——新增 research owner 的 agent 自动可被 dispatch。
各 phase skill 指定实际 dispatch 哪些 subagent（如 debate skill dispatch debate-critic/rebuttal，
autoresearch skill dispatch local-executor/research-verifier/research-audit）。
```

#### M5. MCP Calls

```markdown
# 旧 (280-284)

- Phase 1-7: You MAY call advance_plan, get_state, and convention tools.
- Execution phase: You MAY call convention tools and get_state, but MUST NOT call advance_plan.
- Debate sub-phases: You MAY call convention tools and get_state, but MUST NOT call advance_plan.

# 新

- research-state MCP: 已整体删除, 不存在
- research-conventions MCP: 已整体删除, 不存在
- 状态管理: worker 直接读写 persistence/research_state.md (经 edit/write tool), 不经 MCP
- 约定管理: worker 直接读写 research_state.md 的 ## Conventions 节; 约定检查用 research-audit skill 的 check_conventions.py (经 bash)
- 确定性检查: worker 跑 research-audit skill 的 scripts/ (经 bash), 不经 MCP
- health check: worker 或 primary 调用 health-check skill (自带 scripts/run_health_check.py), 不经 MCP
```

## 2. research-verifier.md 修改

> 详细规格见 newlayer-8（research-verifier agent 完整设计）。
> newlayer-10 不重复 research-verifier 的修改内容。

## 3. local-executor.md 重构

> 文件：`.aether/agent/local-executor.md` (303行) → ~100行
> 从固定 Step 0-10 workflow 重构为原则+约束

### Part 1: 新设计（原则+约束）

```yaml
---
description: 执行单个 question [Qn] 的研究任务（计算/编译/运行），产出推理与结果
color: "#F59E0B"
mode: subagent
owner: research
owns:
  - research
permission:
  "*": deny
  grep: allow
  glob: allow
  list: allow
  read: allow
  edit:
    "*": deny
    ".aether/research/**": allow
  bash: allow
  webfetch: allow
  external_directory: ask
fallback_models: []
---
```

```markdown
# Local Executor

执行单个 question [Qn] 的研究任务，产出推理与结果。

## 硬约束

- 叶子执行者，不 dispatch 进一步 subagent
- 只写 .aether/research/ 下文件（bash 也须自约束不写外部目录）
- 不在 host 系统安装 Python 包（所有 pip/uv install 限 .aether/research/.venv 内）
- FORBIDDEN: 编造来源（执行结果中引用的文献须有下载文件，不虚构引用）

## 必须

- 读 dispatch prompt 获取：Qn 的 method / tools / falsification test / dependency context
- 读 persistence/ENVIRONMENT.md（若存在）了解可用环境
- 执行 Qn 的研究任务（据 method 和环境选择执行方式）
- 产出 <workdir>execution/Qn_REASONING.md（推理过程）+ Qn_EXECUTION.md（执行结果）
- 记录完整失败上下文（不 bare "FAILED"，须含命令/错误输出/部分成果）

## 执行方式

据 ENVIRONMENT.md 和 PLAN.md method 选择：

- uv_venv: 用 .aether/research/.venv/bin/python 或 uv run 执行
- local: 用 host 已装软件（如 wolframscript）直接执行
- local_compile: 用 PLAN.md 指定的 build_command 编译，产出在 .aether/research/ 内

## 环境

- 读 persistence/ENVIRONMENT.md（若存在）了解已装软件/Python 版本/库
- 可自行安装所需软件（限 .aether/research/.venv 内，如 uv pip install）
- 可增量更新 ENVIRONMENT.md（追加新发现的环境信息）
- 若 ENVIRONMENT.md 不存在（首次执行），探测环境并创建

## 失败处理

记录完整失败上下文到 Qn_EXECUTION.md：

- 尝试了什么（命令/操作）
- 错误输出（exact stderr）
- 部分成果（如果有）
- 阻碍完成的 specific gap（不是 bare "tool missing"）
```

### Part 2: 从当前版本到新版本的删除/修改

| 当前段落                                                     | 行(约)  | 处理                                         | 理由                                                         |
| ------------------------------------------------------------ | ------- | -------------------------------------------- | ------------------------------------------------------------ |
| front matter `mcp: research-conventions: true`               | 22      | 删                                           | MCP 已删                                                     |
| front matter `research_conventions_*: allow`                 | 20      | 删                                           | 同上                                                         |
| "MUST NOT call advance_plan"                                 | 33      | 删                                           | advance_plan 已删                                            |
| "MUST NOT use bare python/pip" (uv-first 硬约束)             | 37      | 改为"用 uv run 执行 Python 脚本"             | 保留 uv 策略但从 rigid 约束改为执行方式说明                  |
| "MUST NOT install any Python package on host"                | 39      | 保留                                         | 安全约束不变                                                 |
| "Convention Awareness" 节（读 MCP）                          | 59-61   | 删                                           | 改为读 research_state.md ## Conventions                      |
| Step 0: Confirm Strategy                                     | 65-67   | 删                                           | 改为原则"据 ENVIRONMENT.md 和 PLAN.md 选择执行方式"          |
| Step 1: Read Dispatch Prompt                                 | 69-71   | 改为"必须：读 dispatch prompt"               | 保留但简化                                                   |
| Step 2: Read ENVIRONMENT.md                                  | 73-75   | 改为"读 ENVIRONMENT.md（若存在）"            | 保留但允许不存在                                             |
| Step 3: Setup Environment（"不安装，报告给 autoresearch"）   | 77-98   | 改为"可自行安装（venv 内）"                  | 与 newlayer-6 M4 一致                                        |
| Step 3.5: Verify GPU                                         | 100-113 | 删                                           | 过度规定，agent 自然处理 GPU 需求                            |
| Step 4: Execute Commands                                     | 115-122 | 改为原则"执行 Qn 的研究任务"                 | 保留但简化                                                   |
| Step 5: Handle Errors                                        | 124-127 | 改为原则"记录完整失败上下文"                 | 保留精神但简化                                               |
| Step 6: Report Environment State（"不写 ENVIRONMENT.md"）    | 129-131 | 改为"可增量更新 ENVIRONMENT.md"              | 与新设计一致                                                 |
| Step 7: Collect Results                                      | 133-135 | 删                                           | 自然行为，不需规定                                           |
| Step 8: Verify Against Acceptance Tests                      | 137-145 | 删                                           | 验证是 research-verifier 的职责，不是 local-executor 的      |
| Step 8.5: Partial Execution Documentation（5 条 NEVER/MUST） | 147-161 | 改为原则"记录完整失败上下文"                 | 精神保留但去 rigid 规则                                      |
| Step 9: Write Execution Report（固定格式模板）               | 163-188 | 改为"产出 Qn_REASONING.md + Qn_EXECUTION.md" | 格式由 agent 灵活组织                                        |
| Step 10: Cleanup                                             | 190-193 | 删                                           | 自然行为                                                     |
| "Integrity" 节                                               | 195-200 | 简化                                         | 保留核心约束，删冗余                                         |
| "local_compile Security Constraints"（6 条 HARD）            | 202-209 | 简化为核心安全约束                           | 保留"不写系统目录""不执行未声明命令"等核心，删过度细节       |
| "Procedure — local_compile" Step CL-1~CL-6                   | 211-301 | 删                                           | 改为原则"用 build_command 编译，产出在 .aether/research/ 内" |

## 4. 其他保留 agent 轻微更新

以下 agent 标记为"保留"，但需轻微更新以移除对已删除概念的引用：

### research-explorer.md

- front matter `mcp: research-state: true` + `mcp: research-conventions: true` → 删除（两个 MCP 均已整体删除）
- system-reminder 中 "MCP (research-state)" / "MCP (research-conventions)" → 删除
- 无引用 coordinator/advance_plan/autoresearch，无需改 prompt

### gpd-verifier.md → 删除

gpd-verifier agent 定义整体删除。不再有独立 gpd-verifier agent。
research-verifier 是唯一 verifier agent，按需加载领域特定 skill（agent 自行判断是否需要，不硬编码 skill 名称）。
gpd-\* skill 本身保留不变。

### gpd-reviewer.md → 删除

gpd-reviewer agent 定义整体删除。其功能（convention 检查 / 物理错误筛查 / domain review）被 research-audit sub-subagent（加载 `gpd-*` skill）+ check_conventions.py 覆盖。
`gpd-*` skill（gpd-verification / gpd-errors / gpd-conventions / gpd-domain-check）保留不变，research-audit / research-verifier 按需加载。

## 预期结果

- research-worker.md: 289行 → ~160行（删复杂 digest schema 176行，加简化回传机制 + MCP 更新 ~50行；debate 编排不在 research-worker 中，在 debate skill 中）
- research-verifier.md: 61行 → ~100行（见 newlayer-8）
- local-executor.md: 303行 → ~100行（从固定 workflow 重构为原则+约束）
- gpd-verifier.md: 74行 → 0（删除，合并入 research-verifier）
- gpd-reviewer.md: 37行 → 0（删除，功能被 research-audit + gpd-\* skill 覆盖）
- research-explorer.md: 不变（删 mcp 引用）
