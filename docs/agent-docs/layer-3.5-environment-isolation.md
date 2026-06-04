# Layer 3.5: Environment-Aware Execution — Tiered Isolation Strategy + Multi-Executor Architecture

> **SUPERSEDED BY**: [Layer 3.9](layer-3.9-remove-sandbox-add-local-compile.md) — sandbox-executor 和 Docker 隔离已移除，双 executor 架构（sandbox-executor + local-executor）已合并为单 local-executor 架构。本文档中以下章节已过时：§8 sandbox-executor.md 修改、策略分类表中的 docker 行、dispatch 逻辑中的 sandbox-executor 派发。以 Layer 3.9 为准。

> 前置依赖: Layer 0-3.4（核心安全 + Agent 基础设施 + Research 配置层 + Research Infrastructure + Gap Analysis + Context Isolation + Subagent Runtime Limits）
> 本文档解决 phase_execution 中环境隔离的核心问题：当前设计假设 Docker 总是可用且足够轻量，但实际上 (1) Mac 上 Docker 需要 Docker Desktop 较重；(2) sandbox-executor 可能绕过 Docker 直接在宿主机安装包；(3) 商业软件（如 Mathematica）不适合容器化。
> 改进方案：引入环境审核机制 + 分级隔离策略 + 多 Executor 架构 + 统一 skill 调用模式。

---

## 目录

1. [问题分析](#1-问题分析)
2. [设计决策汇总](#2-设计决策汇总)
3. [架构设计](#3-架构设计)
4. [ENVIRONMENT.md 规范](#4-environmentmd-规范)
5. [local-executor Agent 定义](#5-local-executor-agent-定义)
6. [autoresearch SKILL.md 重写](#6-autoresearch-skillmd-重写)
7. [research-worker.md 修改](#7-research-workermd-修改)
8. [sandbox-executor.md 修改](#8-sandbox-executormd-修改)
9. [research.md Coordinator 修改](#9-researchmd-coordinator-修改)
10. [research-question-framing SKILL.md 修改](#10-research-question-framing-skillmd-修改)
11. [MCP server 修改](#11-mcp-server-修改)
12. [文件改动清单](#12-文件改动清单)
13. [验收清单](#13-验收清单)

---

## 1. 问题分析

### 1.1 当前架构的 5 个环境问题

**问题 A：phase_framing 不声明具体环境需求**

PLAN.md 的 Execution Plan 部分只写 "Method: Python" 或 "Environment: Docker/local"，没有列出具体依赖包、版本要求、是否需要 GPU 等信息。下游 executor 无法据此做出隔离决策。

**问题 B：phase_execution 不探测宿主机环境**

research-worker 的 execution_cycle procedure（`research-worker.md:75-89`）步骤 4 只写 "identify scripts, environment requirements, copy project files"，但没有"探测宿主机实际有哪些软件"这一步。worker 不知道宿主机是否有 Docker、wolframscript、uv、GPU 等，就盲目 dispatch sandbox-executor。

**问题 C：sandbox-executor 可能绕过 Docker 直接在宿主机操作**

sandbox-executor.md 的 Execution Protocol 明确要求使用 Docker（Step 2-4），但在实际测试中，LLM 会自行添加 "Phase A: Environment Setup" 并直接在宿主机 `pip install`。原因：

- `env_scope` 已被移除（commit 13c8d3c7），sandbox-executor 现有 `bash: allow`（full access）
- 系统级的硬约束只限制 write/edit 工具的 file_scope，不限制 bash 的安装操作
- 当 Docker 不可用或 LLM 认为太慢时，会自行"优化"为宿主机直接执行

**问题 D：Docker 在 Mac 上不够轻量**

macOS 无法原生运行 Linux 容器，必须通过 Docker Desktop 启动一个 Linux VM。这意味着：

- Docker Desktop 本身占 2-4GB 内存
- 首次 `docker run` 有几十秒延迟
- 不是轻量命令行工具，而是常驻后台 GUI 应用
- 对纯 Python 实验来说，`uv venv` 比 Docker 快 10 倍以上

**问题 E：商业软件不适合容器化**

Mathematica、MATLAB 等商业软件：

- 许可证绑定硬件/MAC 地址，容器 MAC 地址每次变化
- 安装包 4-5GB，镜像膨胀
- 用户本地已有安装，重复安装浪费许可证和磁盘
- Mathematica Kernel 不污染系统环境（不安装额外包），隔离收益极低

### 1.2 核心洞察

**隔离是为了防风险，不是为了隔离一切。** 不同软件的风险等级不同：

| 软件类型                           | 系统风险               | 合理隔离级别        |
| ---------------------------------- | ---------------------- | ------------------- |
| Mathematica / MATLAB               | 无（自包含、不安装包） | local（不隔离）     |
| Python + numpy/scipy（wheel 安装） | 低（可卸载）           | uv venv（轻量隔离） |
| Python + pybind11 / C++ 编译       | 中（编译产物散落）     | Docker（重隔离）    |
| 外部 repo 不可信代码               | 高（可能恶意）         | Docker（重隔离）    |

一刀切用 Docker 对低风险任务是不必要的开销，对商业软件是不可行的。

---

## 2. 设计决策汇总

以下决策经过与用户讨论确认：

| #   | 问题                | 决策                                                                                     | 原因                                                                                 |
| --- | ------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | 环境审核时机        | **两段式**：声明在 phase_framing → PLAN.md；验证在 execution_cycle 开头 → ENVIRONMENT.md | 不增加新 phase（5 phase 不变）；声明是规划的一部分，验证必须实时探测                 |
| 2   | 环境审核内容位置    | **独立文件 ENVIRONMENT.md** 在 `.aether/research/persistence/`                           | PLAN.md 不应在执行阶段被修改；环境信息是动态元数据而非静态合同                       |
| 3   | 分类策略            | local → 商业软件；uv_venv → 纯 Python（wheel 安装）；docker → C 编译/GPU/不可信代码      | 按是否需要手动编译区分；numpy/scipy 有预编译 wheel → uv_venv                         |
| 4   | 下游使用方式        | worker 读 ENVIRONMENT.md 的 isolation_strategy → 按策略 dispatch 不同 executor           | worker 作为调度中枢，不直接执行任何任务                                              |
| 5   | 执行模块            | **sandbox-executor (docker) + local-executor (uv_venv/local)**                           | local-executor 独立处理非 Docker 任务；避免轻量任务中间信息挤占 worker 上下文        |
| 6   | worker 模式统一     | **统一 invoke skill**：phase_execution 也通过 skill 工具调用 /autoresearch               | research-worker 成为纯路由/调度器，不含嵌入 procedure；旧 autoresearch 备份为 legacy |
| 7   | 关键软件缺失        | **报告用户并等待**                                                                       | 由 coordinator 向用户报告，用户决定安装/修改计划/放弃                                |
| 8   | local-executor 命名 | **local-executor**                                                                       | 与 sandbox-executor 对称                                                             |
| 9   | venv 清理策略       | **保留 reuse**，phase completed 后清理                                                   | 避免每次 cycle 重装依赖；ENVIRONMENT.md 记录 venv 路径和已安装包                     |
| 10  | 并行执行            | **允许并行**：不同 strategy 的 task 可同时 dispatch                                      | 加快总执行时间；worker 用多个 task 调用并行 dispatch                                 |

---

## 3. 架构设计

### 3.1 整体流程

```
phase_framing (research-question-framing skill)
  │  新增: PLAN.md Contract 增加 environment_requirements 字段
  │
  ▼
phase_checkpoint (coordinator 直接处理)
  │  展示: 研究计划 + 环境需求声明（"需要 Python + Mathematica"）
  │
  ▼
phase_execution (autoresearch skill, coordinator 管控循环)
  │
  ├── execution_cycle (worker invoke /autoresearch skill)
  │    │
  │    ├── Step 1-2: 读 PLAN.md + STATE.md (不变)
  │    ├── Step 3: 环境探测 (新增) → bash 探测宿主机软件 → 写 ENVIRONMENT.md
  │    ├── Step 4: 分类决策 (新增) → 根据 ENVIRONMENT.md + PLAN.md → 确定每个 task 的 isolation_strategy
  │    ├── Step 4.5: 缺失检查 (新增) → 若关键软件缺失 → digest 标记 failed + reason
  │    ├── Step 5: 分派执行 (修改) → 按 isolation_strategy dispatch 不同 executor
  │    │    ├── strategy=docker   → dispatch sandbox-executor (delegation_depth: 0)
  │    │    ├── strategy=uv_venv  → dispatch local-executor (delegation_depth: 0)
  │    │    ├── strategy=local    → dispatch local-executor (delegation_depth: 0)
  │    │    ├── strategy=mixed    → 拆分为多个 task，并行 dispatch
  │    │    └── 缺失关键软件 → 不 dispatch，直接在 digest 中标记 failed
  │    ├── Step 6: 收集合并结果 (修改) → 读各 executor 写入的 EXECUTION.md sections
  │    ├── Step 7: 评估 acceptance_tests (不变)
  │    └── Step 8: 输出 digest (不变)
  │
  └── verification (worker invoke /autoresearch skill)
       │  流程不变，但 dispatch prompt 需明确指定 verifier
       │
```

### 3.2 关键设计决策

| 决策                    | 选择                                                                            | 原因                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 增加新 phase            | **否**                                                                          | 环境验证与执行紧密耦合，拆成两个 phase 增加路由复杂度和延迟；5 phase 不变                                                                            |
| worker 直接执行轻量任务 | **否**                                                                          | 任务可能长时间运行、产生大量中间文件、中途报错；这些中间信息不应挤占 worker 上下文                                                                   |
| 多个专用 executor       | **两个**（sandbox-executor + local-executor）                                   | sandbox-executor 已有 Docker 生命周期管理逻辑；local-executor 处理 uv venv + 本地工具；不需要 python-executor/mathematica-executor 等细粒度 subagent |
| autoresearch skill 备份 | 保留旧版为 `autoresearch_legacy.md`                                             | 旧版是参考文档，新版是可执行 skill；两者语义不同                                                                                                     |
| cycle 计数              | coordinator 在 dispatch prompt 传入 `cycle=N`，skill 读取并在 digest 中回传     | 与 phase 1-3 调用模式完全一致，skill 不自行计算 cycle                                                                                                |
| ENVIRONMENT.md 写入时机 | execution_cycle 的 Step 3（环境探测后）                                         | 探测结果和策略决策在同一 session 内原子写入                                                                                                          |
| ENVIRONMENT.md 更新时机 | 每个 execution_cycle 开头重新探测并更新                                         | 宿主机环境可能变化（如用户在 cycle 1 后安装了缺失软件）                                                                                              |
| venv 路径               | `.aether/research/.venv/`                                                       | 在 output_dir 内，受 file_scope 保护                                                                                                                 |
| phase completed 后清理  | coordinator 在 advance_plan(completed) 后提示用户清理 `.aether/research/.venv/` | 不自动删除，用户可能需要保留                                                                                                                         |

### 3.3 Executor 分工

| Executor         | 负责策略           | 调用方式                        | skill_refs | 特殊能力                              |
| ---------------- | ------------------ | ------------------------------- | ---------- | ------------------------------------- |
| sandbox-executor | `docker`           | task tool (delegation_depth: 0) | docker     | Docker 容器生命周期管理               |
| local-executor   | `uv_venv`, `local` | task tool (delegation_depth: 0) | 无         | uv venv 创建/管理；wolframscript 调用 |

**sandbox-executor 缩窄职责**：

- 删除 skill_refs 中的 `research-verification`（验证由 verification sub-phase 处理）
- system prompt 明确限定：只处理 `isolation_strategy=docker` 的任务
- 不允许在没有 Docker 时降级为宿主机执行

**local-executor 新建**：

- 处理 `uv_venv` 和 `local` 两种策略
- uv_venv：创建 `.aether/research/.venv/`，安装依赖，运行脚本
- local：直接运行宿主机工具（如 `wolframscript`）
- 不允许使用 Docker（避免降级到 Docker）
- 不允许 dispatch 进一步 subagent（delegation_depth: 0 语义）

### 3.4 状态管理职责划分

| 操作                              | 执行者                               | 原因                                                   |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------ |
| ENVIRONMENT.md 写入               | worker（execution_cycle）            | 探测和决策在同一 session 内                            |
| ENVIRONMENT.md 更新               | worker（后续 cycle）                 | 重新探测后更新                                         |
| ENVIRONMENT.md 读取               | local-executor, sandbox-executor     | executor 根据策略决定具体执行方式                      |
| venv 创建/管理                    | local-executor                       | executor 在独立 session 中操作                         |
| venv reuse 检查                   | local-executor                       | 检查 ENVIRONMENT.md 中记录的已安装包是否满足需求       |
| 缺失软件报告                      | worker → digest → coordinator → 用户 | worker 在 digest 中标记 failed，coordinator 向用户报告 |
| phase completed 后 .venv 清理提示 | coordinator                          | advance_plan(completed) 后提示用户                     |

---

## 4. ENVIRONMENT.md 规范

文件路径: `.aether/research/persistence/ENVIRONMENT.md`

> 注意: ENVIRONMENT.md 需加入 `PERSISTENCE_WHITELIST`（见第 11 节 MCP server 修改）。

### 4.1 模板

```yaml
# Environment Profile — written by research-worker at execution_cycle start
# Updated at each cycle to reflect current host state

probe_timestamp: "2026-05-19T10:30:00Z"
cycle: 1 # updated per cycle

host_system:
  os: "macOS 15.5 (Apple Silicon aarch64)"
  python: { available: true, versions: ["3.11 (uv)"], default: "3.11" }
  docker: { available: true, desktop: true, version: "27.x" }
  wolframscript: { available: true, version: "13.3.1" }
  uv: { available: true, version: "0.6.x" }
  gpu: { available: false }

plan_requirements: # extracted from PLAN.md contract environment_requirements
  - software: "Python 3.11 + numpy + scipy + sympy"
    purpose: "numerical simulation"
    critical: true # true = cannot proceed without this
  - software: "Mathematica 13+"
    purpose: "symbolic verification"
    critical: true

isolation_strategy: # per-task strategy decisions
  - task: "numerical_simulation"
    strategy: uv_venv
    software: ["Python", "numpy", "scipy", "sympy"]
    rationale: "Pure Python numerical work, wheel-installable packages"
    setup_commands: ["uv venv .aether/research/.venv", "uv pip install numpy scipy sympy"]
    run_prefix: ".aether/research/.venv/bin/python"

  - task: "symbolic_verification"
    strategy: local
    software: ["Mathematica"]
    rationale: "Licensed, self-contained, no environment pollution"
    command: "wolframscript -c"

venv_state: # venv reuse tracking
  path: ".aether/research/.venv"
  installed_packages: [] # populated after first local-executor run
  last_cycle: null # cycle number when venv was last updated

gaps: [] # critical software that is unavailable # empty if all critical requirements met
  # example gap entry:
  # - software: "Docker"
  #   impact: "C++ compilation tasks cannot be isolated; may proceed with local-executor if acceptable"
  #   critical: true
```

### 4.2 字段说明

| 字段                 | 类型    | 说明                      | 写入者                       |
| -------------------- | ------- | ------------------------- | ---------------------------- |
| `probe_timestamp`    | string  | ISO 8601 时间戳           | worker                       |
| `cycle`              | integer | 当前 cycle 编号           | worker                       |
| `host_system`        | map     | 宿主机软件探测结果        | worker                       |
| `plan_requirements`  | list    | 从 PLAN.md 提取的需求对照 | worker                       |
| `isolation_strategy` | list    | 每个 task 的策略决策      | worker                       |
| `venv_state`         | map     | venv 路径和已安装包       | local-executor（执行后更新） |
| `gaps`               | list    | 缺失的关键软件            | worker                       |

### 4.3 环境探测命令

worker 在 execution_cycle Step 3 中应执行以下探测命令：

```bash
# OS info
uname -s && uname -m
# Python
python3 --version 2>/dev/null || echo "python: not available"
# uv
uv --version 2>/dev/null || echo "uv: not available"
# Docker
docker --version 2>/dev/null || echo "docker: not available"
# WolframScript
wolframscript --version 2>/dev/null || echo "wolframscript: not available"
# GPU
nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "gpu: not available"
# Conda (optional)
conda --version 2>/dev/null || echo "conda: not available"
```

### 4.4 分类决策矩阵

worker 在 Step 4 中根据探测结果 + PLAN.md 需求，对每个 task 应用以下规则：

| 条件                                                                     | strategy        | 降级路径                                                     |
| ------------------------------------------------------------------------ | --------------- | ------------------------------------------------------------ |
| 商业/自包含软件（Mathematica, MATLAB, Stata），宿主机可用                | `local`         | 不可用 → gap（critical=true）                                |
| 纯 Python + wheel-installable 包（numpy, scipy, sympy, pandas），uv 可用 | `uv_venv`       | uv 不可用 → 尝试 python -m venv；python 也不可用 → gap       |
| 需要 C/C++ 编译（pybind11, Cython C extension 开发），Docker 可用        | `docker`        | Docker 不可用 → gap（critical=true，除非用户接受宿主机编译） |
| GPU 工作负载（PyTorch/TensorFlow 训练），Docker + GPU 可用               | `docker`        | GPU 不可用 → gap；Docker 不可用 → gap                        |
| 外部 repo 不可信代码，Docker 可用                                        | `docker`        | Docker 不可用 → gap（critical=true）                         |
| 混合场景（Python + Mathematica）                                         | 拆分为多个 task | 每个 task 独立策略                                           |

**灰色地带处理**：numpy/scipy 等有预编译 wheel 但包含 C 扩展的包 → 用户只用 wheel 安装（不手动编译 C）→ 归类为 `uv_venv`。只有用户需要手动编译 C 代码（如 pybind11 module 开发）才归类为 `docker`。

---

## 5. local-executor Agent 定义

### 5.1 Frontmatter

```yaml
---
description: Execute research tasks in local environment (uv venv or direct execution) and return results
color: "#F59E0B"
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
  external_directory: ask
  research_conventions_*: allow
skill_refs: []
mcp:
  research-conventions: true

output_dir: ".aether/research"
file_scope:
  - ".aether/research/**"
---
```

### 5.2 System Prompt

````markdown
<system-reminder>
# Local Executor — HARD CONSTRAINTS

PERMITTED: read/glob/grep any file; edit/write within .aether/research (enforced by file_scope); bash (full access for local execution); MCP (research-conventions, read-only).

FORBIDDEN: edit/write outside .aether/research (enforced by file_scope). HARD CONSTRAINT: MUST NOT use bash commands to write files outside .aether/research. The file_scope permission system only restricts write/edit tools — bash is not restricted. You MUST self-enforce this constraint.

HARD CONSTRAINT: MUST NOT use Docker. This executor handles non-Docker tasks only. Docker tasks belong to sandbox-executor.

HARD CONSTRAINT: MUST NOT call advance_plan. The coordinator manages state transitions.

HARD CONSTRAINT: MUST NOT dispatch further subagents. You are the leaf executor; delegation_depth=0 context.

HARD CONSTRAINT: MUST NOT install packages on the host system outside venv. All pip/uv installs MUST target .aether/research/.venv only.

# ═══════════════════════════════════════════════════════════

# LOCAL EXECUTOR — uv venv + Host Tool Execution

# ═══════════════════════════════════════════════════════════

Execute research tasks in local environment and write results to EXECUTION.md.

## Convention Awareness

Read convention state via research-conventions MCP before execution. Convention values affect numerical expectations. You **read** convention locks but **never write** them — convention lock mutations belong to gpd-verifier.

## Execution Protocol

### Step 0: Confirm Strategy

Read dispatch prompt and ENVIRONMENT.md. Confirm this task's isolation_strategy is `uv_venv` or `local`. If strategy is `docker`, report error — this executor only handles non-Docker tasks.

### Step 1: Read Dispatch Prompt

Identify: task name, isolation strategy (uv_venv or local), commands to execute, acceptance tests, convention context.

### Step 2: Read ENVIRONMENT.md

Confirm strategy details: setup_commands, run_prefix, installed_packages (for reuse), venv path.

### Step 3: Setup Environment

**For uv_venv strategy:**

1. Check if `.aether/research/.venv` exists and ENVIRONMENT.md venv_state.installed_packages covers required dependencies
2. If venv exists and packages match → reuse (skip install)
3. If venv exists but needs additional packages → `uv pip install <missing_packages>` into existing venv
4. If venv does not exist → create: `uv venv .aether/research/.venv` then `uv pip install <all_dependencies>`
5. Verify setup: `.aether/research/.venv/bin/python --version` and import check

**For local strategy:**

1. Verify tool is available (e.g., `wolframscript --version`)
2. No setup needed — tool is already installed on host

### Step 4: Execute Commands

Run each command from the dispatch prompt:

- **uv_venv**: prefix with `.aether/research/.venv/bin/python` or run via `.aether/research/.venv/bin/<tool>`
- **local**: run directly (e.g., `wolframscript -c '<code>'`)

Capture stdout/stderr. Record execution time.

### Step 5: Handle Errors

- Transient errors (network timeout, file lock): retry once
- Persistent errors: report failure with error message
- Do NOT fall back to Docker or host system install

### Step 6: Update ENVIRONMENT.md

After successful venv setup or package install, update `venv_state` section:

- `installed_packages`: list all currently installed packages
- `last_cycle`: current cycle number

### Step 7: Collect Results

Ensure all output files are in `.aether/research/` (within file_scope).

### Step 8: Verify Against Acceptance Tests

For each acceptance_test from the dispatch prompt:

- Script command: run it
- Numerical comparison: compare actual vs expected
- File existence: verify file exists and is non-empty

Record verdict: PASS / FAIL / INCONCLUSIVE.

### Step 9: Write Execution Report

Append section to `.aether/research/persistence/EXECUTION.md`:

```markdown
## Task: [task_name] (strategy: [uv_venv|local])

**Executor**: local-executor
**Strategy**: [uv_venv|local]
**Conventions**: <current convention lock summary>
**Duration**: [execution time]

| Command | Status | Duration | Output |
| ------- | ------ | -------- | ------ |

| Test | Expected | Actual | Verdict |
| ---- | -------- | ------ | ------- |

[pass_count]/[total_count] tests passed.
```
````

### Step 10: Cleanup Temporary Files

Remove temporary files created during execution (but keep .venv for reuse).
Remove any files outside .aether/research that were accidentally created.

## Integrity

- Do NOT skip acceptance test verification
- Do NOT fall back to Docker when strategy is uv_venv/local
- Do NOT install packages outside venv on host system
- Do NOT leave temporary files outside .aether/research
- Do NOT write to convention lock (only read)
  </system-reminder>

````

### 5.3 设计要点

- **无 skill_refs**：local-executor 不需要加载任何 skill。uv venv 管理和 wolframscript 调用通过 bash 直接执行，逻辑足够简单，不值得独立 skill。
- **无 research-state MCP**：local-executor 不需要 advance_plan / get_state。它只读 convention locks（research-conventions MCP），不写任何状态文件。
- **无 task 权限**：local-executor 是 leaf executor，不允许 dispatch 进一步 subagent。
- **bash: allow (full access)**：需要执行 uv, python, wolframscript 等命令。受 HARD CONSTRAINT 自约束：不写文件到 .aether/research 外。
- **venv reuse**：local-executor 检查 ENVIRONMENT.md 的 venv_state，如已满足依赖则跳过安装。

---

## 6. autoresearch SKILL.md 重写

### 6.1 备份旧版

将当前 `.aether/skills/autoresearch/SKILL.md` 复制为 `.aether/skills/autoresearch/autoresearch_legacy.md`，保留为参考文档。

### 6.2 新版 SKILL.md

```markdown
---
name: autoresearch
description: |
  Phase 5 (phase_execution) of the Path 3 research state machine.
  Environment-aware execution — probe host, classify isolation strategy,
  dispatch multi-executor (sandbox-executor for Docker, local-executor for uv venv/local),
  collect results, evaluate acceptance tests, output digest.
  Invoked by research-worker via skill tool (unified invocation pattern).
---

# AutoResearch — phase_execution (Environment-Aware)

This skill implements phase_execution of the Path 3 research state machine. It is invoked by the research-worker via the skill tool, receiving cycle number and sub_phase from the dispatch prompt.

## Lifecycle Contract

**Input**: PLAN.md contract + STATE.md + ENVIRONMENT.md (may not exist on cycle 1) + cycle number + sub_phase from dispatch prompt

**Output** (MUST write all of these):

1. `.aether/research/persistence/ENVIRONMENT.md` — Host probe results + isolation strategy decisions
2. `.aether/research/persistence/EXECUTION.md` — Execution results (appended sections from executors)
3. `.aether/research/persistence/STATE.md` — Updated with cycle status

**State transition**: phase_execution → completed (managed by coordinator, NOT by this skill)

**Precondition**: User must have confirmed execution at phase_checkpoint. MUST NOT invoke this skill without user confirmation.

**MUST NOT**: Modify PLAN.md claims/deliverables. Call advance_plan (coordinator manages state transitions). Skip environment verification. Fall back to host execution when Docker isolation is required.

## Procedure — Execution Cycle (sub_phase=execution_cycle)

### Step 1: Read Current State

1. Read `.aether/research/persistence/STATE.md` — confirm phase_execution
2. Read `.aether/research/persistence/PLAN.md` — extract contract (claims, acceptance_tests, forbidden_proxies, **environment_requirements**)
3. Read convention_lock_status via research-conventions MCP
4. Read cycle number from dispatch prompt (e.g., "cycle=1", "cycle=2 (retry)")

### Step 2: Environment Probe

Probe the host system for available software:

```bash
python3 --version 2>/dev/null || echo "python: not available"
uv --version 2>/dev/null || echo "uv: not available"
docker --version 2>/dev/null || echo "docker: not available"
wolframscript --version 2>/dev/null || echo "wolframscript: not available"
nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "gpu: not available"
````

Record results for ENVIRONMENT.md host_system section.

### Step 3: Classify Isolation Strategy

For each task derived from PLAN.md contract:

1. Extract software requirements from PLAN.md `environment_requirements` field
2. Apply classification rules:

| Condition                                                              | Strategy                  |
| ---------------------------------------------------------------------- | ------------------------- |
| Licensed/self-contained software (Mathematica, MATLAB), host available | `local`                   |
| Pure Python + wheel-installable packages, uv available                 | `uv_venv`                 |
| C/C++ compilation needed (pybind11 development), Docker available      | `docker`                  |
| GPU workloads, Docker + GPU available                                  | `docker`                  |
| Untrusted external repo code, Docker available                         | `docker`                  |
| Mixed (Python + Mathematica)                                           | Split into separate tasks |

3. For each task, write `isolation_strategy` entry in ENVIRONMENT.md
4. Identify gaps: critical software that is unavailable on host

### Step 4: Write ENVIRONMENT.md

Write `.aether/research/persistence/ENVIRONMENT.md` with:

- probe_timestamp, cycle number
- host_system (probe results)
- plan_requirements (from PLAN.md)
- isolation_strategy (classification decisions)
- venv_state (reuse check from previous cycle if exists)
- gaps (missing critical software)

### Step 5: Gap Check

If any gap has `critical: true`:

- Do NOT dispatch any executor for tasks that depend on the missing software
- Set `status: failed` in digest with `reason: "Critical software unavailable: [gap description]"`
- The coordinator will report to the user and wait for decision

If gaps exist but are non-critical:

- Proceed with available tasks
- Mark affected acceptance tests as `inconclusive` in digest

### Step 6: Dispatch Executors

For each task in isolation_strategy:

**strategy=docker → dispatch sandbox-executor**:

```
task(
  description: "[task_name] (docker)",
  subagent_type: "sandbox-executor",
  prompt: "Execute [task_name] in Docker sandbox.
  Task: [description from PLAN.md]
  Isolation strategy: docker
  Base image: [from ENVIRONMENT.md]
  Commands: [from PLAN.md]
  Acceptance tests: [relevant tests from PLAN.md]
  Convention context: [summary]
  Read ENVIRONMENT.md for strategy details.
  Write results to .aether/research/persistence/EXECUTION.md (append section)."
)
```

**strategy=uv_venv or strategy=local → dispatch local-executor**:

```
task(
  description: "[task_name] ([strategy])",
  subagent_type: "local-executor",
  prompt: "Execute [task_name] in local environment.
  Task: [description from PLAN.md]
  Isolation strategy: [uv_venv|local]
  Commands: [from PLAN.md]
  Setup commands: [from ENVIRONMENT.md]
  Run prefix: [from ENVIRONMENT.md]
  Acceptance tests: [relevant tests from PLAN.md]
  Convention context: [summary]
  Read ENVIRONMENT.md for venv state and strategy details.
  Write results to .aether/research/persistence/EXECUTION.md (append section)."
)
```

**Parallel dispatch**: When multiple tasks have different strategies, dispatch them in parallel using multiple task tool calls in a single message.

**Sequential dispatch**: When tasks depend on each other's output, dispatch sequentially.

### Step 7: Collect Results

1. Read `.aether/research/persistence/EXECUTION.md` — collect sections written by each executor
2. For each task, check:
   - Did the executor write its section? If missing → that task failed
   - Are all output files present? Check deliverables from PLAN.md
3. Aggregate results across all tasks

### Step 8: Evaluate Acceptance Tests

Evaluate each acceptance_test from PLAN.md against aggregated execution results:

- All passed → status: completed
- Some failed → status: partial, revision_needed: brief description
- Inconclusive → status: inconclusive
- If gap prevented a test → mark as skipped with reason

### Step 9: Update STATE.md

Update `.aether/research/persistence/STATE.md` with cycle status:

- current_phase: phase_execution (cycle N status)
- key decisions: [execution results summary]
- blockers: [any gaps or failures]
- next_action: [verification or retry]

### Step 10: Output PhaseResultDigest

Output execution_cycle_digest as FINAL message:

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: execution_cycle
  cycle: [N from dispatch prompt]
  status: completed | partial | failed | inconclusive
  tests_passed: ["[test 1]", "[test 2]"]
  tests_failed: ["[test N]"]
  tests_inconclusive: ["[test M]"]
  execution_summary: "[brief: what was run, which executors used, key results]"
  revision_needed: null | "[what to revise if tests failed]"
  environment_strategy_used:
    - task: "[task_name]"
      strategy: "[docker|uv_venv|local]"
      executor: "[sandbox-executor|local-executor]"
  gaps_reported: [] | ["[gap description]"]
  output_paths:
    environment: persistence/ENVIRONMENT.md
    execution: persistence/EXECUTION.md
  next_phase: null  # coordinator decides based on sub_phase + cycle + status
```

MUST NOT output any other text after this YAML block.

## Procedure — Verification (sub_phase=verification)

When invoked with sub_phase=verification:

1. Read `.aether/research/persistence/EXECUTION.md` + PLAN.md contract section
2. Read `.aether/research/persistence/STATE.md` — confirm execution cycle completed
3. Dispatch verifier — follow EXPLICIT specification from coordinator dispatch prompt:
   - If prompt specifies gpd-verifier: dispatch gpd-verifier (uses gpd-verification + gpd-domain-check + gpd-conventions)
   - If prompt specifies research-verifier: dispatch research-verifier (uses research-verification)
   - If prompt specifies both (physics domain): dispatch gpd-verifier first, then research-verifier for domain-agnostic checks
   - Use delegation_depth: 0
4. Read `.aether/research/persistence/VERIFICATION.md` produced by verifier
5. Evaluate claims:
   - All verified → status: completed
   - Some failed → status: partial, list failed claims
   - Computational oracle overrides LLM-only judgment → respect oracle results
6. Update STATE.md with verification status
7. Output verification_digest:

```yaml
phase_result_digest:
  phase: phase_execution
  sub_phase: verification
  cycle: [N from dispatch prompt]
  status: completed | partial | failed
  claims_verified: ["[claim 1]", "[claim 2]"]
  claims_failed: ["[claim N]"]
  claims_inconclusive: ["[claim M]"]
  key_numerical_results: ["[brief result 1]", "[brief result 2]"]
  output_paths:
    verification: persistence/VERIFICATION.md
  next_phase: null
```

MUST NOT output any other text after this YAML block.

## Subagent Dispatch

- sandbox-executor: For Docker-isolated tasks (strategy=docker)
- local-executor: For uv venv and host tool tasks (strategy=uv_venv or local)
- gpd-verifier / research-verifier: For verification of results
- FORBIDDEN: Dispatching explore or general subagents for execution or verification work

## Integrity

Never fabricate sources. Never claim verification without evidence. Never override computational oracle results with LLM-only reasoning. Never silently adjust acceptance criteria when tests fail. Never skip environment verification. Never fall back to host execution when Docker isolation is required.

```

### 6.3 与旧版的对比

| 方面 | 旧版 (autoresearch_legacy.md) | 新版 |
|------|------|------|
| 调用方式 | 不被 worker 调用（参考文档） | worker 通过 skill 工具调用 |
| 执行器 | 只 dispatch sandbox-executor | dispatch sandbox-executor 或 local-executor（按策略） |
| 环境审核 | 无 | Step 2-4（探测 → 分类 → ENVIRONMENT.md） |
| 缺失检查 | 无 | Step 5（gap check → failed digest） |
| 并行执行 | 顺序 dispatch | 允许并行 dispatch 多个 executor |
| cycle 参数 | 无（worker 内嵌 procedure 自行管理） | 从 dispatch prompt 读取 cycle=N |
| venv 管理 | 无 | ENVIRONMENT.md venv_state + local-executor 管理 |

---

## 7. research-worker.md 修改

### 7.1 删除嵌入 procedure

删除 `research-worker.md` 中从 `## Execution Cycle Procedure` 到 `## Verification Procedure` 的所有嵌入 procedure（约第 75-106 行）。

### 7.2 修改 Phase Routing 表

旧版：

```

| phase_execution | execution_cycle | Follow execution_cycle procedure below |
| phase_execution | verification | Follow verification procedure below |

```

新版：

```

| phase_execution | execution_cycle | Invoke /autoresearch skill |
| phase_execution | verification | Invoke /autoresearch skill |

````

### 7.3 修改路由说明

旧版第 73 行：

> "For phase_execution sub-phases: follow the embedded procedures below (do NOT invoke /autoresearch skill)."

新版：

> "For phase_execution sub-phases: invoke /autoresearch skill via the skill tool, passing cycle number from the dispatch prompt. Follow all steps in SKILL.md."

### 7.4 修改 Subagent Dispatch Rules

旧版第 194 行：

> "Allowed: research-explorer, sandbox-executor, gpd-verifier, gpd-reviewer, research-verifier"

新版：

> "Allowed: research-explorer, sandbox-executor, local-executor, gpd-verifier, gpd-reviewer, research-verifier"

### 7.5 保持不变的部分

- PhaseResultDigest Format（第 108-123 行）：不变，cycle 仍从 dispatch prompt 读取
- Phase-specific schemas（第 125-190 行）：不变（execution_cycle digest 新增 environment_strategy_used 和 gaps_reported 字段，见 autoresearch SKILL.md Step 10）
- MCP Calls 规则（第 198-201 行）：不变（execution sub-phase 仍不调用 advance_plan）
- Integrity（第 203-205 行）：不变

---

## 8. sandbox-executor.md 修改

### 8.1 缩窄职责

修改 description：

旧版：`Execute research plans in isolated sandbox environments and verify results against acceptance tests`

新版：`Execute research tasks requiring Docker isolation (C/C++ compilation, GPU, untrusted code) and return results`

### 8.2 删除 research-verification skill_ref

旧版 skill_refs：

```yaml
skill_refs:
  - docker
  - research-verification
````

新版：

```yaml
skill_refs:
  - docker
```

原因：验证由 verification sub-phase 处理，sandbox-executor 不应自行验证。

### 8.3 修改 Execution Protocol

在 Step 1 之前增加：

```markdown
### Step 0: Confirm Strategy

Read dispatch prompt and ENVIRONMENT.md. Confirm this task's isolation_strategy is `docker`. If strategy is NOT docker, report error — this executor only handles Docker tasks.
```

修改 Step 2-8 的开头说明：

```markdown
> All steps below MUST be performed inside Docker containers. MUST NOT install packages or run commands on the host system. MUST NOT fall back to host execution when Docker is unavailable — instead, report failure in EXECUTION.md.
```

修改 Step 7 (Report) 的格式，增加 strategy 标记：

```markdown
## Task: [task_name] (strategy: docker)

**Container**: <image>, <mode (--rm or persistent)>
**Executor**: sandbox-executor
**Strategy**: docker
**Plan**: PLAN.md contract reference
**Conventions**: <current convention lock summary>
**Duration**: <execution time>
```

在 Integrity 部分增加：

```markdown
- HARD CONSTRAINT: MUST NOT install packages on the host system. All installation happens inside the container.
- HARD CONSTRAINT: MUST NOT fall back to host execution. If Docker is unavailable, report failure.
- HARD CONSTRAINT: MUST NOT use bash to write files outside .aether/research.
```

### 8.4 删除 env_scope（已完成）

commit 13c8d3c7 已删除 sandbox-executor 的 `env_scope`。当前 frontmatter 中已无 env_scope 字段。

### 8.5 移除 research-state MCP

sandbox-executor 是 leaf executor（delegation_depth: 0），与 local-executor 对称。所有必要信息已在 dispatch prompt 和 ENVIRONMENT.md 中提供，不需要 advance_plan / get_state。

旧版 frontmatter：

```yaml
permission:
  research_state_*: allow
mcp:
  research-conventions: true
  research-state: true
```

新版：

```yaml
mcp:
  research-conventions: true
```

移除 `research_state_*: allow` 和 `research-state: true`。仅保留 research-conventions MCP（读 convention locks）。

同时修改 HARD CONSTRAINTS 说明：

旧版：`PERMITTED: ... MCP (research-conventions, research-state, read-only for conventions).`

新版：`PERMITTED: ... MCP (research-conventions, read-only).`

原因：与 local-executor（Section 5.3 "无 research-state MCP"）保持对称。leaf executor 不需要状态管理工具。保留 MCP 访问增加误用 advance_plan 的风险，即使有 HARD CONSTRAINT 约束。

### 8.6 增加 fallback_models

sandbox-executor frontmatter 增加 fallback_models 配置，确保主模型不可用时执行不中断：

```yaml
fallback_models:
  - alibaba-cn/glm-5.1
  - alibaba-cn/kimi-k2.6
  - alibaba-cn/qwen3.6-max-preview
```

原因：Docker 容器操作可能耗时较长，模型 fallback 保证执行连续性。

---

## 9. research.md Coordinator 修改

### 9.1 修改 Phase Dispatch Table

旧版第 232 行：

```
| phase_execution | Worker uses built-in sub-phase procedures (NOT /autoresearch skill) | sub_phase=execution_cycle or verification, cycle=N |
```

新版：

```
| phase_execution | Worker invokes /autoresearch skill                                  | sub_phase=execution_cycle or verification, cycle=N |
```

### 9.2 修改 Execution Loop dispatch prompt

Cycle 1 dispatch prompt（第 318-326 行）：

旧版：

```
"Execute execution_cycle (cycle 1) of phase_execution.
Read PLAN.md contract, prepare execution, dispatch sandbox-executor.
Domain: [from framing digest verification_approach].
After completing, output execution_cycle_digest as your final message."
```

新版：

```
"Execute execution_cycle (cycle 1) of phase_execution.
Invoke /autoresearch skill. Read PLAN.md contract, probe environment, classify isolation strategy, dispatch executors.
Domain: [from framing digest verification_approach].
Cycle: 1.
After completing, output execution_cycle_digest as your final message."
```

Retry dispatch prompt 类似更新，增加 cycle number。

### 9.3 增加 ENVIRONMENT.md 到 checkpoint 展示

phase_checkpoint（第 290-308 行）步骤 3，在给用户的摘要中增加：

> - Environment requirements: [from PLAN.md environment_requirements or framing digest]

用户可以在确认前看到"需要 Mathematica 和 Python"，知道大致需要什么软件。

### 9.4 修改 Subagent Dispatch Rules

旧版第 455 行：

```
- Allowed for Path 3: research-worker only. Worker internally dispatches research-explorer/sandbox-executor/verifiers with delegation_depth: 0.
```

新版：

```
- Allowed for Path 3: research-worker only. Worker internally dispatches research-explorer/sandbox-executor/local-executor/verifiers with delegation_depth: 0.
```

### 9.5 增加 ENVIRONMENT.md 到 state.json 阶段 → completed 后清理提示

phase_execution → completed（第 385-393 行）增加步骤 6：

> 6. Inform user: "Research project completed. You may clean up .aether/research/.venv/ if no longer needed."

### 9.6 Session Recovery 增加 ENVIRONMENT.md

Session Recovery（第 424-435 行）步骤 1，增加读取 ENVIRONMENT.md：

> 1. Read `.aether/research/persistence/STATE.md`, `state.json`, `DIGESTS.md`, and `ENVIRONMENT.md` (if exists)

步骤 2，增加环境状态恢复：

> - If ENVIRONMENT.md exists: note venv_state for reuse in next cycle

---

## 10. research-question-framing SKILL.md 修改

### 10.1 PLAN.md Contract 增加 environment_requirements 字段

在 Step 6 的 PLAN.md 模板中（第 103-136 行），Execution Plan 部分增加：

旧版：

```markdown
### Execution Plan

- Method: [Python/C++/Mathematica/etc.]
- Tools: [Specific software packages — e.g., amflow, dct_nis_python]
- Environment: [Docker/local/remote]
- Verification approach: [gpd-verifier / research-verifier]
```

新版：

```markdown
### Execution Plan

- Method: [Python/C++/Mathematica/etc.]
- Tools: [Specific software packages — e.g., amflow, dct_nis_python]
- Verification approach: [gpd-verifier / research-verifier]

### Environment Requirements

- requirement_1:
  software: "[e.g., Python 3.11]"
  packages: ["numpy", "scipy", "sympy"]
  purpose: "[e.g., numerical simulation]"
  critical: true # true = cannot proceed without this
- requirement_2:
  software: "[e.g., Mathematica 13+]"
  packages: []
  purpose: "[e.g., symbolic verification]"
  critical: true
- requirement_3:
  software: "[e.g., Docker]"
  purpose: "[e.g., C++ compilation isolation — only if needed]"
  critical: false # false = can fall back to local execution if acceptable
```

### 10.2 修改 framing digest schema

Step 9 的 PhaseResultDigest（第 160-182 行），增加 environment_requirements 字段：

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
  execution_method: "[Python | C++ | Mathematica | mixed]"
  environment_requirements:
    - software: "[Python 3.11]"
      packages: ["numpy", "scipy"]
      purpose: "[numerical simulation]"
      critical: true
    - software: "[Mathematica 13+]"
      purpose: "[symbolic verification]"
      critical: true
  verification_approach: [gpd-verifier | research-verifier]
  output_paths:
    plan: persistence/PLAN.md
    research_questions: notepads/[slug]/research_questions.md
  next_phase: phase_checkpoint
```

---

## 11. MCP Server 修改

### 11.1 PERSISTENCE_WHITELIST 增加 ENVIRONMENT.md

`.aether/mcp/research-state/server.py` 第 449-452 行：

旧版：

```python
PERSISTENCE_WHITELIST = {
    "STATE.md", "ROADMAP.md", "PLAN.md", "DIGESTS.md", "state.json",
    "EXECUTION.md", "VERIFICATION.md",
}
```

新版：

```python
PERSISTENCE_WHITELIST = {
    "STATE.md", "ROADMAP.md", "PLAN.md", "DIGESTS.md", "state.json",
    "EXECUTION.md", "VERIFICATION.md", "ENVIRONMENT.md",
}
```

原因：ENVIRONMENT.md 在 persistence/ 目录中，需要加入白名单以避免 validate_file_locations 报 violation。

---

## 12. 文件改动清单

| 文件                                                 | 操作         | 核心变更                                                                                                                                                               |
| ---------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.aether/agent/local-executor.md`                    | **新建**     | 本地执行 subagent（uv venv + wolframscript 等）                                                                                                                        |
| `.aether/skills/autoresearch/autoresearch_legacy.md` | **新建**     | 旧版 SKILL.md 备份                                                                                                                                                     |
| `.aether/skills/autoresearch/SKILL.md`               | **大改**     | 环境审核 + 分类 + 多 executor 分派 + 结果合并                                                                                                                          |
| `.aether/agent/research-worker.md`                   | **修改**     | 删除嵌入 procedure；Phase Routing 改为 invoke /autoresearch；增加 local-executor 到 dispatch rules                                                                     |
| `.aether/agent/sandbox-executor.md`                  | **修改**     | 缩窄为 docker-only；删除 research-verification skill_ref；增加 strategy 确认步骤和硬约束                                                                               |
| `.aether/agent/research.md`                          | **修改**     | Phase Dispatch Table 更新；dispatch prompt 增加 cycle 和环境信息；checkpoint 展示环境需求；增加 local-executor 到 dispatch rules；session recovery 增加 ENVIRONMENT.md |
| `.aether/skills/research-question-framing/SKILL.md`  | **修改**     | PLAN.md 增加 environment_requirements；framing digest 增加环境字段                                                                                                     |
| `.aether/mcp/research-state/server.py`               | **修改**     | PERSISTENCE_WHITELIST 增加 ENVIRONMENT.md                                                                                                                              |
| `.aether/research/persistence/ENVIRONMENT.md`        | **新建模板** | 环境审核内容模板                                                                                                                                                       |
| `docs/agent-docs/layer-3.5-environment-isolation.md` | **新建**     | 本设计文档                                                                                                                                                             |

核心源文件改动：**零**（仅 `.aether/mcp/research-state/server.py` 的白名单常量变更）。全部改动在 `.aether/` 配置层和 `docs/` 文档层。

---

## 13. 验收清单

### 13.1 环境审核

1. phase_framing 在 PLAN.md Contract 中写入 environment_requirements 字段
2. framing digest 包含 environment_requirements 字段
3. phase_checkpoint 展示环境需求给用户

### 13.2 环境验证

4. execution_cycle worker（通过 /autoresearch skill）执行环境探测（Step 2）
5. ENVIRONMENT.md 写入 `.aether/research/persistence/`，包含 host_system + plan_requirements + isolation_strategy + gaps
6. ENVIRONMENT.md 在每个 cycle 开头更新（重新探测）
7. 关键软件缺失时 digest 标记 status=failed + reason

### 13.3 分级隔离

8. Mathematica 等商业软件 → strategy=local
9. 纯 Python + wheel 包 → strategy=uv_venv
10. C++ 编译 / GPU / 不可信代码 → strategy=docker
11. 混合场景正确拆分为多个 task

### 13.4 Executor 分派

12. strategy=docker 的 task dispatch 到 sandbox-executor
13. strategy=uv_venv 的 task dispatch 到 local-executor
14. strategy=local 的 task dispatch 到 local-executor
15. 不同 strategy 的 task 可并行 dispatch
16. 同 strategy 的依赖 task 顺序 dispatch

### 13.5 local-executor

17. local-executor 正确创建 .aether/research/.venv
18. local-executor reuse 已有 venv（检查 ENVIRONMENT.md venv_state）
19. local-executor 补充安装缺失依赖到已有 venv
20. local-executor 正确运行 wolframscript（local strategy）
21. local-executor 不使用 Docker（HARD CONSTRAINT）
22. local-executor 不在宿主机系统级安装包（HARD CONSTRAINT）
23. local-executor 不 dispatch 进一步 subagent（HARD CONSTRAINT）
24. local-executor 更新 ENVIRONMENT.md venv_state
25. local-executor 写结果到 EXECUTION.md（append section）

### 13.6 sandbox-executor

26. sandbox-executor 只处理 strategy=docker 的任务（Step 0 确认）
27. sandbox-executor 不在宿主机安装包（HARD CONSTRAINT）
28. sandbox-executor Docker 不可用时报告失败，不降级到宿主机（HARD CONSTRAINT）
29. sandbox-executor 不自行执行 research-verification（skill_ref 已删除）

### 13.7 Worker 调用模式统一

30. phase_execution 通过 skill 工具调用 /autoresearch（不再嵌入 procedure）
31. research-worker Phase Routing 表全部为 "Invoke /xxx skill"
32. cycle 参数从 dispatch prompt 传入，skill 读取并在 digest 中回传
33. research-worker 的 system prompt 不含 execution/verification procedure

### 13.8 Coordinator

34. Phase Dispatch Table 更新为 "Worker invokes /autoresearch skill"
35. Execution dispatch prompt 包含 cycle=N 和环境信息
36. phase_checkpoint 展示环境需求
37. Coordinator 在 worker digest 中检测 gaps_reported → 向用户报告缺失软件
38. Coordinator 在 phase_execution → completed 后提示清理 .venv
39. Session recovery 读取 ENVIRONMENT.md

### 13.9 状态一致性

40. ENVIRONMENT.md 加入 PERSISTENCE_WHITELIST
41. validate_file_locations 不报 ENVIRONMENT.md 为 violation
42. ENVIRONMENT.md 在 persistence/ 目录中（符合文件布局规范）
43. .aether/research/.venv/ 在 output_dir 内（受 file_scope 保护）

### 13.10 回退安全

44. 删除 local-executor.md + ENVIRONMENT.md 模板后，恢复旧版 autoresearch SKILL.md + 旧版 research-worker.md 即可回退到 Layer 3.3 架构
45. autoresearch_legacy.md 可恢复为 SKILL.md（回退到单 sandbox-executor 模式）
46. Layer 0-3.4 的改动不受本层影响
47. 核心源文件改动仅在 MCP server 白名单常量

### 13.11 上下文占用

48. ENVIRONMENT.md ≈ ~1-2K tokens（YAML 格式，精炼）
49. local-executor 独立 session，不污染 worker 上下文
50. worker 只读 ENVIRONMENT.md 摘要和 EXECUTION.md sections，不承载 executor 中间信息
51. 多 executor 并行 dispatch 不增加 worker 上下文（task 工具并发调用）
