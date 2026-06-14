# Layer 3.9: Remove Sandbox-Executor / Docker — Add Local Compilation Support

> 前置依赖: Layer 0-3.5（核心安全 + Agent 基础设施 + Research 配置层 + Research Infrastructure + Gap Analysis + Context Isolation + Subagent Runtime Limits + Environment-Aware Execution）
> 本文档解决 phase_execution 执行路径的简化问题：移除 sandbox-executor 和 Docker 隔离，将所有执行收敛到本地环境，同时为编译/构建任务增加本地执行支持（local_compile 策略）与安全约束。
> 后续扩展：待本地版本稳定后，可恢复 Docker/sandbox 支持（届时作为 Layer 3.10）。

---

## 目录

1. [动机与目标](#1-动机与目标)
2. [设计决策汇总](#2-设计决策汇总)
3. [文件删除清单](#3-文件删除清单)
4. [核心修改](#4-核心修改)
5. [次要修改](#5-次要修改)
6. [代码修改](#6-代码修改)
7. [测试文件修改](#7-测试文件修改)
8. [前置设计文档更新](#8-前置设计文档更新)
9. [运行时数据修改](#9-运行时数据修改)
10. [验收清单](#10-验收清单)
11. [回滚方案](#11-回滚方案)

---

## 1. 动机与目标

### 1.1 当前问题

1. **Docker 依赖过重**：macOS 上 Docker Desktop 安装体积大、启动慢，许多用户不具备 Docker 环境
2. **sandbox-executor 增加维护负担**：多 executor 架构导致派发逻辑复杂，coordinator 需要管理 docker/uv_venv/local 三种策略
3. **实际使用中 Docker 利用率低**：大多数研究任务为纯 Python + SymPy/NumPy，Docker 隔离并非必需
4. **编译/构建任务完全依赖 Docker**：无 Docker 则无法执行编译任务，缺少本地构建回退路径

### 1.2 目标

- 移除 sandbox-executor agent 和 Docker skill，简化执行架构
- 将隔离策略从 3 种（docker/uv_venv/local）简化为 3 种（uv_venv/local/local_compile），全部基于本地执行
- 为编译/构建任务增加本地执行支持（local_compile 策略），附带安全约束；环境探测采用需求驱动模式，不硬编码特定编译器列表
- 保持架构可扩展性，未来可重新引入 Docker 隔离

### 1.3 不做的事

- 不修改 local-executor 的核心执行逻辑（uv_venv 策略不变）
- 不修改 debate phase 或 verification phase 的逻辑
- 不修改 MCP 工具的通用接口（仅移除 docker 探测代码）
- 不将编译工具链检查加入 health-check（health-check 只负责 research-agent 基础设施能否工作；项目所需的编译/构建工具由 autoresearch 执行阶段的需求驱动探测负责）

---

## 2. 设计决策汇总

| #   | 决策                                                                     | 理由                                                                                        |
| --- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| D1  | 删除 sandbox-executor.md 和 docker/SKILL.md                              | Docker 隔离路径整体移除，不再维护                                                           |
| D2  | 删除 autoresearch_legacy.md                                              | 旧版完全基于 sandbox-executor，无参考价值                                                   |
| D3  | 隔离策略从 `docker/uv_venv/local` 改为 `uv_venv/local/local_compile`     | 本地执行统一管理                                                                            |
| D4  | local-executor 增加 `local_compile` 策略支持                             | 编译/构建任务降级到本地执行                                                                 |
| D5  | local_compile 增加安全约束（声明式编译命令、输出目录限制、不受信源标注） | 无 Docker 隔离时需自我约束                                                                  |
| D6  | ENVIRONMENT.md 新增动态 `tools` 和 `gpu` 字段                            | 需求驱动的工具链信息和 GPU 信息对策略分类必要                                               |
| D7  | 编译工具链不纳入 health-check                                            | health-check 只负责 research-agent 基础设施；项目编译工具由 autoresearch 需求驱动探测负责   |
| D8  | Docker 相关探测代码从 research-state MCP server.py 移除                  | 无 Docker 则无需探测                                                                        |
| D9  | 删除/修改 sandbox-executor 相关测试文件                                  | 测试与被删除的 agent 保持一致                                                               |
| D10 | 前置设计文档（layer-3.3~3.6, layer-2.x）增加 SUPERSEDED 标注             | 避免旧文档中 sandbox-executor 描述误导维护者                                                |
| D11 | autoresearch Step 2 采用需求驱动探测                                     | 不硬编码特定编译器列表，由 PLAN.md environment_requirements 驱动探测，支持任意编译/构建工具 |
| D12 | local-executor 增加 `fallback_models` 配置                               | 继承原 sandbox-executor 的模型回退能力，确保单 executor 架构下的鲁棒性                      |
| D13 | ENVIRONMENT.md 运行时实例 `python` 字段替换为 `uv_python`                | 确保所有 Python 执行通过 uv 虚拟环境隔离，禁止直接使用本地 python                           |
| D14 | local_compile 错误处理统一到 Step 5 通用错误处理                         | 避免策略特定错误处理与通用错误处理边界不清，让 agent 灵活判断错误原因                       |

---

## 3. 文件删除清单

### 3.1 `.aether/agent/sandbox-executor.md`

整体删除。sandbox-executor agent 定义，所有内容围绕 Docker 隔离执行。

### 3.2 `.aether/skills/docker/SKILL.md`

整体删除。Docker skill，包含容器选择、构建、执行、GPU 支持等全部 Docker 操作指导。

### 3.3 `.aether/skills/autoresearch/autoresearch_legacy.md`

整体删除。旧版 autoresearch，完全基于 sandbox-executor 的单 executor 模式。

### 3.4 `packages/opencode/test/layer-2/sandbox-executor-and-compat.test.ts`

整体删除。4 个 sandbox-executor 专用测试用例（T2.1.5-T2.1.8），随 agent 定义移除而失效。

---

## 4. 核心修改

### 4.1 `.aether/skills/autoresearch/SKILL.md`

#### 4.1.1 description 字段

```yaml
# 旧
description: |
  Phase 5 (phase_execution) of the Path 3 research state machine.
  Environment-aware execution — probe host, classify isolation strategy,
  dispatch multi-executor (sandbox-executor for Docker, local-executor for uv venv/local),
  collect results, evaluate acceptance tests, output digest.

# 新
description: |
  Phase 5 (phase_execution) of the Path 3 research state machine.
  Environment-aware execution — probe host, classify isolation strategy,
  dispatch local-executor (uv venv / local tools / local compilation),
  collect results, evaluate acceptance tests, output digest.
```

#### 4.1.2 Lifecycle Contract — MUST NOT

```markdown
# 旧

**MUST NOT**: Modify PLAN.md claims/deliverables during execution. Call advance_plan (coordinator manages state transitions). Skip environment verification. Fall back to host execution when Docker isolation is required.

# 新

**MUST NOT**: Modify PLAN.md claims/deliverables during execution. Call advance_plan (coordinator manages state transitions). Skip environment verification. Execute compilation commands not declared in PLAN.md environment_requirements.
```

#### 4.1.3 Step 2: Environment Probe — 移除 docker 探测，改为需求驱动探测

> **设计原则**：health-check 只负责 research-agent 基础设施（uv, git, MCP, network）能否工作。项目所需的编译/构建工具由本步骤的需求驱动探测负责，不硬编码特定工具列表。

**删除**：

```bash
docker --version 2>/dev/null || echo "docker: not available"
```

**新增以下三类探测**：

1. **固定探测**（research-agent 基础设施，始终执行）：

```bash
uv --version 2>/dev/null || echo "CRITICAL: uv not available — Python tasks cannot be isolated; report as critical gap"
uv python list 2>/dev/null || echo "uv python management: not available"
wolframscript --version 2>/dev/null || echo "wolframscript: not available"
```

2. **需求驱动探测**（从 PLAN.md environment_requirements 提取工具名）：

对 PLAN.md 中每个 `isolation_hint` 含 `local_compile` 的 requirement，提取其 `software` 字段中的工具名，执行探测：

```bash
[tool_name] --version 2>/dev/null || [tool_name] -V 2>/dev/null || echo "[tool_name]: not available"
```

探测约定：优先尝试 `--version`，失败则尝试 `-V`。结果写入 ENVIRONMENT.md `host_system.tools` 字典。

3. **GPU 探测**（仅当 PLAN.md 环境需求含 GPU 时执行）：

```bash
nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null || echo "nvidia-smi: not available"
system_profiler SPDisplaysDataType 2>/dev/null | grep "Chipset Model" || echo "GPU: not detected"
```

#### 4.1.4 Step 3: Classify Isolation Strategy — 替换策略表

```markdown
# 旧

| Condition                                                                             | Strategy                                                                      |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Licensed/self-contained software (Mathematica, MATLAB, Stata), host available         | `local`                                                                       |
| Pure Python + wheel-installable packages (numpy, scipy, sympy, pandas), uv available  | `uv_venv`                                                                     |
| Pure Python + wheel-installable packages, **uv NOT available**                        | `gap (critical)` — user must install uv first; do NOT fallback to bare python |
| C/C++ compilation needed (pybind11 development, Cython C extension), Docker available | `docker`                                                                      |
| GPU workloads (PyTorch/TensorFlow training), Docker + GPU available                   | `docker`                                                                      |
| Untrusted external repo code, Docker available                                        | `docker`                                                                      |
| Mixed (Python + Mathematica)                                                          | Split into separate tasks per strategy                                        |

# 新

| Condition                                                                            | Strategy                                                                      |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| Licensed/self-contained software (Mathematica, MATLAB, Stata), host available        | `local`                                                                       |
| Pure Python + wheel-installable packages (numpy, scipy, sympy, pandas), uv available | `uv_venv`                                                                     |
| Pure Python + wheel-installable packages, **uv NOT available**                       | `gap (critical)` — user must install uv first; do NOT fallback to bare python |
| Compilation/build tasks, toolchain available                                         | `local_compile`                                                               |
| GPU workloads (PyTorch/TensorFlow training), local GPU available                     | `local` (with GPU)                                                            |
| Untrusted external repo code                                                         | `local_compile` with `untrusted_source: true` (security constraints apply)    |
| Mixed (Python + compilation)                                                         | Split into separate tasks per strategy                                        |
| Compilation/build tasks, toolchain NOT available                                     | `gap (medium)` — non-critical, tasks marked inconclusive                      |
```

#### 4.1.5 Step 4: ENVIRONMENT.md 模板更新

> **注意**：本节定义的是 autoresearch SKILL.md 中 ENVIRONMENT.md 的**写入模板**。§9.1 中运行时实例的结构与此模板一致，修改时须同步。

```yaml
# 旧（autoresearch SKILL.md 中的当前模板）
host_system:
  os: "[e.g., macOS 15.5 (Apple Silicon aarch64)]"
  uv: { available: true|false, version: "..." }
  uv_python: { available: true|false, versions: ["..."] }
  docker: { available: true|false, desktop: true|false, version: "..." }
  wolframscript: { available: true|false, version: "..." }

# 新
host_system:
  os: "[e.g., macOS 15.5 (Apple Silicon aarch64)]"
  uv: { available: true|false, version: "..." }
  uv_python: { available: true|false, versions: ["..."] }
  wolframscript: { available: true|false, version: "..." }
  tools:                                          # 动态填充，key 由 PLAN.md environment_requirements 决定
    gcc: { available: true|false, version: "..." }    # e.g., gcc, g++, rustc, go, cmake, make, ...
    # ... 任意工具，由需求驱动探测结果决定
  gpu:
    available: true|false
    info: "[e.g., NVIDIA A100 / Apple M2 Pro 16-core GPU / none]"
```

isolation_strategy 条目更新：

```yaml
# 旧
isolation_strategy:
  - task: "[task_name]"
    strategy: "[docker|uv_venv|local]"
    software: ["..."]
    rationale: "[brief reason]"
    setup_commands: ["..."] # for uv_venv strategy
    run_prefix: "..." # for uv_venv strategy
    command: "..." # for local strategy (e.g., wolframscript -c)

# 新
isolation_strategy:
  - task: "[task_name]"
    strategy: "[uv_venv|local|local_compile]"
    software: ["..."]
    rationale: "[brief reason]"
    untrusted_source: true|false  # only for local_compile
    setup_commands: ["..."]       # for uv_venv / local_compile
    run_prefix: "..."             # for uv_venv
    build_command: "..."          # for local_compile (e.g., "cmake -B build && cmake --build build" / "cargo build" / "go build")
    run_command: "..."            # for local_compile (e.g., "./build/simulation")
    command: "..."                # for local strategy (e.g., wolframscript -c)
```

#### 4.1.6 Step 6: Dispatch Executors — 移除 docker 派发，增加 local_compile 派发

删除整段 "strategy=docker → dispatch sandbox-executor"。

新增 "strategy=local_compile → dispatch local-executor"：

> 安全约束的权威定义位于 `local-executor.md`。dispatch prompt 不逐条重复约束内容，仅引用。

```
task(
  description: "[task_name] (local_compile)",
  subagent_type: "local-executor",
  prompt: "Execute [task_name] via local compilation.
  Task: [description from PLAN.md]
  Isolation strategy: local_compile
  Build command: [from ENVIRONMENT.md]
  Run command: [from ENVIRONMENT.md]
  Acceptance tests: [relevant tests from PLAN.md]
  Untrusted source: [true|false from ENVIRONMENT.md]
  Observe ALL local_compile security constraints defined in local-executor.md.
  UV-FIRST POLICY: All Python execution MUST use .aether/research/.venv/bin/python or uv run.
  Read ENVIRONMENT.md for toolchain and strategy details.
  Write results to .aether/research/persistence/EXECUTION.md (append section)."
)
```

#### 4.1.7 Step 10: execution_cycle_digest 更新

```yaml
# 旧
environment_strategy_used:
  - task: "[task_name]"
    strategy: "[docker|uv_venv|local]"
    executor: "[sandbox-executor|local-executor]"

# 新
environment_strategy_used:
  - task: "[task_name]"
    strategy: "[uv_venv|local|local_compile]"
    executor: "local-executor"
```

#### 4.1.8 Subagent Dispatch

```markdown
# 旧

- sandbox-executor: For Docker-isolated tasks (strategy=docker)
- local-executor: For uv venv and host tool tasks (strategy=uv_venv or local)

# 新

- local-executor: For all local tasks (strategy=uv_venv, local, or local_compile)
```

#### 4.1.9 Integrity

```markdown
# 旧

Never fabricate sources. Never claim verification without evidence. Never override computational oracle results with LLM-only reasoning. Never silently adjust acceptance criteria when tests fail. Never skip environment verification. Never fall back to host execution when Docker isolation is required.

# 新

Never fabricate sources. Never claim verification without evidence. Never override computational oracle results with LLM-only reasoning. Never silently adjust acceptance criteria when tests fail. Never skip environment verification. Never execute compilation commands not declared in PLAN.md environment_requirements.
```

---

### 4.2 `.aether/agent/research.md`

#### 4.2.1 Entry Gate Enforcement (L88)

```markdown
# 旧

- FORBIDDEN: Classifying as Path 3 and then dispatching explore, general, research-explorer, sandbox-executor, or verifiers directly — use research-worker only for Path 3.

# 新

- FORBIDDEN: Classifying as Path 3 and then dispatching explore, general, research-explorer, or verifiers directly — use research-worker only for Path 3.
```

#### 4.2.2 Execution Loop 图 (L207)

```markdown
# 旧

│ → sandbox-executor/local-executor → EXECUTION.md │

# 新

│ → local-executor → EXECUTION.md │
```

#### 4.2.3 LLM-only Mode (L695)

```markdown
# 旧

f. User declines → continue in LLM-only mode (no MCP, no Python, no SymPy, no Docker). Mark STATE.md `infrastructure: degraded`

# 新

f. User declines → continue in LLM-only mode (no MCP, no Python, no SymPy). Mark STATE.md `infrastructure: degraded`
```

#### 4.2.4 LLM-only Mode Behavior (L812)

```markdown
# 旧

- Do NOT use SymPy verification, Docker containers

# 新

- Do NOT use SymPy verification
```

#### 4.2.5 Subagent Dispatch Rules (L834-835)

```markdown
# 旧

- FORBIDDEN: Dispatching explore, general, research-explorer, sandbox-executor, gpd-verifier, or research-verifier directly for Path 3 phase work. All Path 3 phases and sub-phases are dispatched via research-worker subagent.
- Allowed for Path 3: research-worker only. Worker internally dispatches research-explorer/sandbox-executor/local-executor/verifiers with delegation_depth: 0.

# 新

- FORBIDDEN: Dispatching explore, general, research-explorer, gpd-verifier, or research-verifier directly for Path 3 phase work. All Path 3 phases and sub-phases are dispatched via research-worker subagent.
- Allowed for Path 3: research-worker only. Worker internally dispatches research-explorer/local-executor/verifiers with delegation_depth: 0.
```

---

### 4.3 `.aether/agent/research-worker.md`

#### 4.3.1 Hard Constraint — Python Execution (L51)

```markdown
# 旧

HARD CONSTRAINT: MUST NOT execute bare python/pip commands via bash. All Python execution MUST go through either: (a) uv run (for PEP 723 inline-script scripts), OR (b) .aether/research/.venv/bin/python (for venv-isolated execution), OR (c) dispatch to local-executor/sandbox-executor (for execution sub-phases). Direct `python3 -c '...'` or `pip install ...` is FORBIDDEN.

# 新

HARD CONSTRAINT: MUST NOT execute bare python/pip commands via bash. All Python execution MUST go through either: (a) uv run (for PEP 723 inline-script scripts), OR (b) .aether/research/.venv/bin/python (for venv-isolated execution), OR (c) dispatch to local-executor (for execution sub-phases). Direct `python3 -c '...'` or `pip install ...` is FORBIDDEN.
```

#### 4.3.2 Digest Schema — environment_strategy_used (L176-177)

```yaml
# 旧
    strategy: "[docker|uv_venv|local]"
    executor: "[sandbox-executor|local-executor]"

# 新
    strategy: "[uv_venv|local|local_compile]"
    executor: "local-executor"
```

#### 4.3.3 Allowed Subagents (L250)

```markdown
# 旧

- Allowed: research-explorer, sandbox-executor, local-executor, gpd-verifier, gpd-reviewer, research-verifier

# 新

- Allowed: research-explorer, local-executor, gpd-verifier, gpd-reviewer, research-verifier
```

---

### 4.4 `.aether/agent/local-executor.md`

这是改动最大的文件，需要**增加** local_compile 支持。以下是完整的新增/修改内容：

#### 4.4.1 移除反 Docker 约束（4处）并更新 Step 0

- L33: 删除 `HARD CONSTRAINT: MUST NOT use Docker. This executor handles non-Docker tasks only. Docker tasks belong to sandbox-executor.`
- L25-28: 增加 `fallback_models` 字段（继承原 sandbox-executor 配置）：

```yaml
# 新增
fallback_models:
  - alibaba-cn/glm-5.1
  - alibaba-cn/kimi-k2.6
  - alibaba-cn/qwen3.6-max-preview
```

- L59: 替换为 `Confirm this task's isolation_strategy is \`uv_venv\`, \`local\`, or \`local_compile\`. If strategy is none of these, report error.`
- L97: 删除 `Do NOT fall back to Docker or host system install`
- L149: 删除 `Do NOT fall back to Docker when strategy is uv_venv/local`

#### 4.4.2 新增策略定义

在 Phase Routing 或策略定义部分新增：

```markdown
## Supported Strategies

| Strategy      | Description                                   | Toolchain                                 |
| ------------- | --------------------------------------------- | ----------------------------------------- |
| uv_venv       | Pure Python + wheel-installable packages      | uv, .aether/research/.venv                |
| local         | Host-installed commercial/standalone software | wolframscript, matlab, etc.               |
| local_compile | Compilation/build + execution                 | gcc/g++/clang, cmake, make, cargo, go etc |
```

#### 4.4.3 新增 Hard Constraints — local_compile 安全约束

```markdown
### local_compile Security Constraints (HARD)

1. **Declarative compilation**: MUST NOT execute compilation commands not declared in PLAN.md `environment_requirements`. Only commands explicitly listed in the task's `build_command` / `run_command` (derived from PLAN.md) are permitted. This is the authoritative definition of this constraint.
2. **Output directory restriction**: All build outputs (object files, binaries, libraries) MUST be written within `.aether/research/`. MUST NOT write to system directories (`/usr/`, `/opt/`, `/usr/local/`, etc.).
3. **No system library override**: MUST NOT statically link or override system libraries in sensitive paths.
4. **Untrusted source annotation**: If `untrusted_source=true` in ENVIRONMENT.md isolation_strategy, annotate risk in EXECUTION.md. See §4.1.6 dispatch prompt for the unified untrusted_source flow.
5. **GPU execution**: Allowed locally. Follow Step 3.5 procedure for GPU verification and recording.
6. **No network-facing binaries**: MUST NOT compile or execute binaries that open network listeners, unless explicitly declared in PLAN.md `environment_requirements` with `network_access: true`.
```

> **实施指示**：约束 #1 与 autoresearch SKILL.md 的 Integrity 条目（"Never execute compilation commands not declared in PLAN.md environment_requirements"）表达同一规则。在 autoresearch SKILL.md 中，该约束以 Integrity 条目形式存在；在 local-executor.md 中，以 Hard Constraint 形式存在。两处独立定义、措辞一致，不互相引用——因为 local-executor 作为 leaf subagent 不会读取 autoresearch SKILL.md。

#### 4.4.4 新增执行流程 — local_compile

```markdown
## Procedure — local_compile Strategy

### Step CL-1: Read Environment Profile

Read `.aether/research/persistence/ENVIRONMENT.md` — extract toolchain info from `host_system.tools`, build/run commands, untrusted_source flag.

### Step CL-2: Verify Tool Availability

For each tool required by the task:

1. Check ENVIRONMENT.md `host_system.tools` — confirm the required tool is available
2. If tool NOT available → report failure in EXECUTION.md:
```

## Task: [task_name] (strategy: local_compile)

**Status**: FAILED
**Reason**: Required tool [name] not available on host

3. Skip to Step CL-6 (output digest)

### Step CL-3: Prepare Build Directory

```bash
mkdir -p .aether/research/build/[task_name]
```

Copy source files if needed:

```bash
cp -r [source_dir] .aether/research/build/[task_name]/
```

### Step CL-4: Execute Build

Execute the `build_command` from ENVIRONMENT.md isolation_strategy:

```bash
# Example: CMake project
cd .aether/research/build/[task_name]
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build

# Example: Cargo project
cd .aether/research/build/[task_name]
cargo build --release

# Example: Go project
cd .aether/research/build/[task_name]
go build -o simulation
```

Capture stdout and stderr. If build fails, apply general error handling (Step 5): analyze the error output to determine cause (toolchain error, missing dependency, source error, etc.), report in EXECUTION.md with full error context, and set task status accordingly.

### Step CL-5: Execute Binary

Execute the `run_command` from ENVIRONMENT.md isolation_strategy:

```bash
# Example
.aether/research/build/[task_name]/build/simulation [args]
```

Capture stdout and stderr. If execution fails, apply general error handling (Step 5): analyze the error output, report in EXECUTION.md with full error context, and set task status accordingly. If execution succeeds → collect output files, set task status to COMPLETED.

### Step CL-6: Write EXECUTION.md Section

Append section to `.aether/research/persistence/EXECUTION.md`:

```markdown
## Task: [task_name] (strategy: local_compile)

**Executor**: local-executor
**Strategy**: local_compile
**Untrusted source**: [true|false]
**Toolchain**: [e.g., clang 15.0.0 / rustc 1.75.0 / go 1.21]
**Build command**: [build_command from ENVIRONMENT.md]
**Run command**: [run_command from ENVIRONMENT.md]
**Status**: COMPLETED | FAILED | PARTIAL

### Build Output

[stdout/stderr from build step, truncated if >200 lines]

### Execution Output

[stdout/stderr from run step, truncated if >200 lines]

### Output Files

- [path]: [description]
```

#### 4.4.5 新增执行流程 — GPU Workloads (strategy=local with GPU)

当 strategy=`local` 且任务涉及 GPU 时，在现有 Step 3（Setup Environment）之后增加 GPU 验证步骤：

```markdown
### Step 3.5: Verify GPU Availability (only when strategy=local with GPU)

1. Read ENVIRONMENT.md `host_system.gpu` — confirm GPU is available
2. If GPU NOT available → report failure in EXECUTION.md:

## Task: [task_name] (strategy: local — GPU required)

**Status**: FAILED
**Reason**: GPU not available on host — task requires GPU but ENVIRONMENT.md reports gpu.available=false

3. If GPU available → verify framework-specific requirements:
   - PyTorch: `.aether/research/.venv/bin/python -c "import torch; assert torch.cuda.is_available() or torch.backends.mps.is_available()"`
   - TensorFlow: `.aether/research/.venv/bin/python -c "import tensorflow as tf; assert len(tf.config.list_physical_devices('GPU')) > 0"`
4. Record GPU info in EXECUTION.md task section: `**GPU**: [info from ENVIRONMENT.md]`
```

#### 4.4.6 Step 9 Execution Report 模板更新

更新 execution report 以支持 local_compile 策略：

```markdown
# 旧

## Task: [task_name] (strategy: [uv_venv|local])

# 新

## Task: [task_name] (strategy: [uv_venv|local|local_compile])
```

在 report 表格后增加 GPU 信息行（仅当 strategy=local with GPU 时）：

```markdown
**GPU**: [gpu info from ENVIRONMENT.md]
```

---

## 5. 次要修改

### 5.1 `.aether/skills/research-question-framing/SKILL.md`

#### L24 — Downstream note

```markdown
# 旧

**You MUST write environment_requirements with enough specificity for the execution phase to classify each requirement into an isolation strategy (docker/uv_venv/local).**

# 新

**You MUST write environment_requirements with enough specificity for the execution phase to classify each requirement into an isolation strategy (uv_venv/local/local_compile).**
```

#### L144-145 — 策略指引

```markdown
# 旧

> - C/C++ compilation, GPU, untrusted code → strategy `docker`
> - Docker itself → strategy prerequisite, `critical: false` (fallback to local if unavailable)

# 新

> - Compilation/build tasks → strategy `local_compile` (requires toolchain declared in environment_requirements)
> - GPU workloads → strategy `local` (requires local GPU)
> - Toolchain not available → gap (medium priority, non-critical)
```

#### L160, L162 — environment_requirements 示例

```yaml
# 旧
  software: "[e.g., Docker]"
  isolation_hint: "[docker prerequisite — not a research tool itself]"

# 新
  software: "[e.g., gcc, cmake / rustc, cargo / go]"
  isolation_hint: "[local_compile prerequisite — build toolchain]"
```

### 5.2 `.aether/skills/health-check/SKILL.md`

#### L90-91 — Infrastructure checks 模板

```yaml
# 旧
"docker_cli": { "status": "...", "client_version": "..." },
"docker_daemon": { "status": "...", "server_version": "..." },

# 新（直接删除这两行，不替换为编译器检查项）
```

#### L141 — critical 检查项

```markdown
# 旧

- uv_available, git_available, git_working_dir, docker_cli, docker_daemon → `true`

# 新

- uv_available, git_available, git_working_dir → `true`
```

#### L148 — priority 映射

```markdown
# 旧

- docker_cli, docker_daemon → `medium`

# 新（直接删除这两行，不替换为编译器优先级）
```

### 5.3 `.aether/skills/env-setup/SKILL.md`

#### L83

```markdown
# 旧

- **Per-item authorization**: Each item is authorized individually. User can install only uv (required) and skip Docker (optional).

# 新

- **Per-item authorization**: Each item is authorized individually. User can install only uv (required) and skip optional tools.
```

### 5.4 `.aether/skills/env-setup/references/install_registry.json`

移除 `docker` 和 `docker_daemon` 两个条目（L39-63）。不新增编译工具链条目——编译/构建工具属于项目特定需求，不属于 research-agent 基础设施，由 autoresearch 需求驱动探测负责（参见 D7）。

### 5.5 `.aether/skills/deep-research/SKILL.md`

#### L98

```markdown
# 旧

- Goal: [Execute PLAN.md via sandbox-executor, verify results]

# 新

- Goal: [Execute PLAN.md via local-executor, verify results]
```

---

## 6. 代码修改

### 6.1 `.aether/mcp/research-state/server.py`

#### L546-574 — 移除 docker 探测

删除以下代码块，不替换为编译器探测（编译工具链由 autoresearch 需求驱动探测负责，参见 D7）：

```python
result = _run_cmd(["docker", "version", "--format", "{{.Client.Version}}"])
# ... 整个 docker_cli 检查块 (约 L546-554)
result = _run_cmd(["docker", "info", "--format", "{{.ServerVersion}}"])
# ... 整个 docker_daemon 检查块 (约 L556-574)
```

#### L730 — 移除 sandbox_executor_docker 映射

```python
# 旧
"sandbox_executor_docker": "docker",

# 删除此行
```

#### L1114 — 移除 docker 提及

```markdown
# 旧

- infrastructure: uv, network reachability (3 endpoints)

# 新

- infrastructure: uv, network reachability (3 endpoints)
```

---

## 7. 测试文件修改

### 7.1 `packages/opencode/test/layer-2/sandbox-executor-and-compat.test.ts`

**整体删除**（已在 §3.4 列出）。该文件包含 4 个 sandbox-executor 专用测试用例（T2.1.5-T2.1.8），随 agent 定义移除而失效。

### 7.2 `packages/opencode/test/layer-2/fixture.ts`

#### 7.2.1 删除 `makeSandboxExecutorConfig()` 函数（L148-174）

整个函数随 sandbox-executor 移除而失效。

#### 7.2.2 修改 `makeResearchConfig()` 中 `env_scope`（L45）

```typescript
// 旧
env_scope: { allowed_commands: ["uv", "curl", "rg", "grep", "git"] },

// 新
env_scope: { allowed_commands: ["uv", "curl", "rg", "grep", "git"] },
```

### 7.3 `packages/opencode/test/layer-2/skills-and-file-loading.test.ts`

#### L20-27 — 删除 T2.1.2（docker SKILL.md 存在性测试）

```typescript
// 旧
test("T2.1.2: docker SKILL.md exists with full content", async () => {
  const content = await Bun.file(path.join(projectRoot, "docker", "SKILL.md")).text()
  expect(content).toContain("name: docker")
  // ...
})

// 新：删除此测试（docker/SKILL.md 已被删除）
```

#### L46 — 从 skillDirs 数组中删除 "docker"

```typescript
// 旧
const skillDirs = ["paper-search", "source-comparison", "paper-code-audit"]

// 新
const skillDirs = ["paper-search", "source-comparison", "paper-code-audit"]
```

#### L78 — 从 research agent 内联配置的 env_scope 中删除 "docker"

```typescript
// 旧
env_scope: allowed_commands: -uv

// 新
env_scope: allowed_commands: -uv
```

#### L100 — 删除 docker run 权限断言

```typescript
// 旧
expect(Permission.evaluate("bash", "docker run", r!.permission).action).toBe("allow")

// 新：删除此断言（docker 已从 env_scope allowed_commands 中移除），
// or replace with other allowed_command 的断言，如：
expect(Permission.evaluate("bash", "uv run ...", r!.permission).action).toBe("allow")
```

#### L154-218 — sandbox-executor 测试用例

```typescript
// 旧
test("sandbox-executor.md from .aether/agent/ creates subagent", async () => {
  // ... reads sandbox-executor.md, verifies Agent.get("sandbox-executor")
})

// 新：替换为 local_compile 策略相关测试
test("local-executor.md supports local_compile strategy", async () => {
  // ... reads local-executor.md, verifies supported strategies include local_compile
})
```

注意：L218 `expect(names).not.toContain("sandbox-executor")` 这行断言在删除 sandbox-executor 后仍应保留（验证 agent 确实不存在），但需确认上下文中 `names` 的来源仍然是有效的测试场景。

### 7.4 `packages/opencode/test/layer-2/research-primary.test.ts`

#### L49 — 移除 docker 命令断言

```typescript
// 旧
expect(Permission.evaluate("bash", "docker run nginx", r!.permission).action).toBe("allow")

// 新：删除此断言（docker 已从 env_scope allowed_commands 中移除），
// 或替换为其他 allowed_command 的断言，如：
expect(Permission.evaluate("bash", "curl https://example.com", r!.permission).action).toBe("allow")
```

---

## 8. 前置设计文档更新

以下设计文档包含大量 sandbox-executor / Docker 引用，是系统架构的真实来源。Layer 3.9 实施后，这些文档中的相关描述已过时。不修改这些文档的具体内容（工作量过大且容易引入不一致），而是在文档头部增加 SUPERSEDED 标注，指向 Layer 3.9。

### 8.1 `docs/agent-docs/layer-3.3-context-isolation.md`

约 15 处 sandbox-executor 引用（上下文隔离模式、dispatch 模式、token 预算估算）。

在文档头部增加：

```markdown
> **SUPERSEDED BY**: [Layer 3.9](layer-3.9-remove-sandbox-add-local-compile.md) — sandbox-executor 已移除，执行架构从双 executor 改为单 local-executor。本文档中 sandbox-executor 相关的上下文隔离模式、dispatch 描述和 token 估算已过时，以 Layer 3.9 为准。
```

### 8.2 `docs/agent-docs/layer-3.4-subagent-runtime-limits.md`

3 处 sandbox-executor 引用（token 预算、超时设置）。

在文档头部增加：

```markdown
> **SUPERSEDED BY**: [Layer 3.9](layer-3.9-remove-sandbox-add-local-compile.md) — sandbox-executor 已移除。本文档中 sandbox-executor 的 token 预算和超时设置已过时。local-executor 的预算保持不变；local_compile 策略的建议超时与 uv_venv 相同（20 分钟）。
```

### 8.3 `docs/agent-docs/layer-3.5-environment-isolation.md`

约 30 处 sandbox-executor / Docker 引用。**这是定义双执行器架构的核心文档**，Layer 3.9 本质上是对 Layer 3.5 的架构变更。

在文档头部增加：

```markdown
> **SUPERSEDED BY**: [Layer 3.9](layer-3.9-remove-sandbox-add-local-compile.md) — sandbox-executor 和 Docker 隔离已移除，双 executor 架构（sandbox-executor + local-executor）已合并为单 local-executor 架构。本文档中以下章节已过时：§8 sandbox-executor.md 修改、策略分类表中的 docker 行、dispatch 逻辑中的 sandbox-executor 派发。以 Layer 3.9 为准。
```

### 8.4 `docs/agent-docs/layer-3.6-health-check.md`

约 10 处 Docker / sandbox-executor 引用（Docker CLI/daemon 检查项、sandbox-executor skill 文件检查）。

在文档头部增加：

```markdown
> **SUPERSEDED BY**: [Layer 3.9](layer-3.9-remove-sandbox-add-local-compile.md) — Docker 健康检查项（docker_cli, docker_daemon）已移除。编译工具链不纳入 health-check（由 autoresearch 需求驱动探测负责）。本文档中 Docker 相关的检查项定义和 sandbox-executor skill 验证已过时，以 Layer 3.9 为准。
```

### 8.5 `docs/agent-docs/layer-2-research-config.md`

2 处 sandbox-executor 引用（subagent 定义）。

在文档头部增加：

```markdown
> **PARTIALLY SUPERSEDED**: [Layer 3.9](layer-3.9-remove-sandbox-add-local-compile.md) — sandbox-executor subagent 定义已移除。其余 Layer 2 内容（research agent、skills、MCP）不受影响。
```

### 8.6 `docs/agent-docs/layer-2.1-missing-skills-recovery.md`

1 处 sandbox-executor 引用。

在文档头部增加：

```markdown
> **PARTIALLY SUPERSEDED**: [Layer 3.9](layer-3.9-remove-sandbox-add-local-compile.md) — sandbox-executor subagent 补齐说明已过时（agent 已移除）。
```

---

## 9. 运行时数据修改

### 9.1 `.aether/research/persistence/ENVIRONMENT.md`

> **注意**：运行时实例结构同 §4.1.5 中的模板定义，修改时须同步。

下次 execution cycle 启动时 autoresearch skill 会重新探测并覆盖此文件。如需手动更新：

```yaml
# 旧（当前运行时实例实际内容）
> Read by sandbox-executor and local-executor to determine execution strategy.
host_system:
  python: { available: false, versions: [], default: "" }
  docker: { available: false, desktop: false, version: "" }
  uv: { available: false, version: "" }
  gpu: { available: false }

# 新
> Read by local-executor to determine execution strategy.
host_system:
  uv: { available: false, version: "" }
  uv_python: { available: false, versions: [] }
  tools: {}                                          # 动态填充，key 由需求驱动探测决定
  gpu:
    available: false
    info: ""
```

> **注意**：当前运行时实例使用 `python` 字段（直接使用本地 python），而非 `uv_python`（通过 uv 虚拟环境隔离）。实施时必须将 `python` 替换为 `uv_python`，与 §4.1.5 模板一致。所有 Python 执行必须通过 uv 虚拟环境，禁止直接使用本地 python。

---

## 10. 验收清单

### 10.1 文件完整性

- [ ] `sandbox-executor.md` 已删除
- [ ] `docker/SKILL.md` 已删除
- [ ] `autoresearch_legacy.md` 已删除
- [ ] `sandbox-executor-and-compat.test.ts` 已删除
- [ ] 非设计文档/非 SUPERSEDED 标注的 .aether/ 下 .md 文件中无 `sandbox-executor` 引用
- [ ] 所有 .aether/ 下 .md 文件中无 Docker 隔离策略引用（`strategy: docker`）
- [ ] `server.py` 中无 `docker_cli`/`docker_daemon`/`sandbox_executor_docker` 引用
- [ ] `research.md` 中 `rg -c 'docker|sandbox.executor' .aether/agent/research.md` 返回 0

### 10.2 功能正确性

- [ ] `autoresearch/SKILL.md` 策略表仅包含 `uv_venv`/`local`/`local_compile`
- [ ] `autoresearch/SKILL.md` Step 6 仅派发 `local-executor`
- [ ] `local-executor.md` 包含 `local_compile` 策略定义和安全约束
- [ ] `local-executor.md` 包含 local_compile 执行流程（CL-1 到 CL-6）
- [ ] `local-executor.md` Step 0 确认策略为 `uv_venv`, `local`, 或 `local_compile`
- [ ] `local-executor.md` 包含 `fallback_models` 配置（与原 sandbox-executor 一致）
- [ ] `local-executor.md` 包含 GPU 验证步骤（Step 3.5）
- [ ] `local-executor.md` Step 9 execution report 支持 `local_compile` 策略
- [ ] `research.md` 中无 sandbox-executor 引用
- [ ] `research-worker.md` digest schema 仅包含 `uv_venv`/`local`/`local_compile`
- [ ] `research-state/server.py` 无 docker 探测代码（不替换为编译器探测）
- [ ] ENVIRONMENT.md 模板（§4.1.5）使用 `uv_python`（非 `python`），确保所有 Python 执行通过 uv 虚拟环境
- [ ] ENVIRONMENT.md 运行时实例（§9.1）`python` 字段已替换为 `uv_python`
- [ ] ENVIRONMENT.md 模板（§4.1.5）和运行时实例（§9.1）结构一致

### 10.3 安全约束

- [ ] `local-executor.md` 包含 6 条 local_compile 安全约束（约束 #1 独立定义，与 autoresearch Integrity 条目措辞一致但不跨文件引用）
- [ ] `autoresearch/SKILL.md` MUST NOT 包含声明式编译命令约束
- [ ] untrusted_source 统一描述：§4.1.6 dispatch prompt 定义完整流程，§4.4.3 约束 #4 引用该流程
- [ ] dispatch prompt 不逐条重复安全约束，仅引用 local-executor.md

### 10.4 测试完整性

- [ ] `sandbox-executor-and-compat.test.ts` 已删除
- [ ] `fixture.ts` 中 `makeSandboxExecutorConfig()` 已删除
- [ ] `fixture.ts` 中 `makeResearchConfig().env_scope` 无 `docker` 条目
- [ ] `skills-and-file-loading.test.ts` 中 T2.1.2（docker SKILL.md 存在性测试）已删除
- [ ] `skills-and-file-loading.test.ts` 中 `skillDirs` 数组无 `"docker"` 条目
- [ ] `skills-and-file-loading.test.ts` 中 L78 research agent 内联配置 env_scope 无 `docker`
- [ ] `skills-and-file-loading.test.ts` 中 L100 docker run 权限断言已删除或替换
- [ ] `skills-and-file-loading.test.ts` 中 sandbox-executor 测试已替换为 local_compile 测试
- [ ] `research-primary.test.ts` 中 `docker run nginx` 断言已移除或替换
- [ ] `bun test` 全部通过

### 10.5 设计文档一致性

- [ ] `layer-3.3-context-isolation.md` 头部已添加 SUPERSEDED 标注
- [ ] `layer-3.4-subagent-runtime-limits.md` 头部已添加 SUPERSEDED 标注
- [ ] `layer-3.5-environment-isolation.md` 头部已添加 SUPERSEDED 标注
- [ ] `layer-3.6-health-check.md` 头部已添加 SUPERSEDED 标注
- [ ] `layer-2-research-config.md` 头部已添加 PARTIALLY SUPERSEDED 标注
- [ ] `layer-2.1-missing-skills-recovery.md` 头部已添加 PARTIALLY SUPERSEDED 标注

### 10.6 弹性环境探测

- [ ] autoresearch Step 2 包含需求驱动探测逻辑（从 PLAN.md 提取工具名并探测）
- [ ] ENVIRONMENT.md 模板使用动态 `tools:` 字典，不硬编码编译器列表
- [ ] health-check 不包含编译工具链检查项
- [ ] install_registry.json 不包含编译工具链条目

### 10.7 GPU 一致性

- [ ] `local-executor.md` 包含 GPU 验证步骤（Step 3.5）
- [ ] GPU 不可用时的错误处理已定义
- [ ] GPU 任务 execution report 包含 GPU 信息行

### 10.8 可扩展性

- [ ] 架构文档中注明 Docker/sandbox 支持可在未来 Layer 3.10 恢复
- [ ] 隔离策略分类表结构保持可扩展（新增行即可）

---

## 11. 回滚方案

若需恢复 Docker/sandbox 支持：

1. 从 git 历史恢复 `sandbox-executor.md` 和 `docker/SKILL.md`
2. 在 `autoresearch/SKILL.md` 隔离策略表中重新添加 `docker` 行
3. 在 `local-executor.md` 中重新添加反 Docker 约束，移除 `fallback_models`
4. 在 `research-state/server.py` 中恢复 docker 探测代码
5. 在 `research.md` 和 `research-worker.md` 中恢复 sandbox-executor 引用
6. 从 git 历史恢复 `sandbox-executor-and-compat.test.ts` 和 `fixture.ts` 中的 `makeSandboxExecutorConfig()`
7. 移除前置设计文档头部的 SUPERSEDED 标注
8. 将 ENVIRONMENT.md 运行时实例中 `uv_python` 回退为 `python`（如需恢复旧格式）

建议恢复时作为 Layer 3.10 文档记录，与本次 Layer 3.9 修改独立追踪。
