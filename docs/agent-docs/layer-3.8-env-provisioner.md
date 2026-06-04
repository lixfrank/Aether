# Layer 3.8: Environment Provisioner — 项目级依赖识别与安装 Subagent

> 前置依赖: Layer 0-3.7（核心安全 + Agent 基础设施 + Research 配置层 + Research Infrastructure + Gap Analysis + Context Isolation + Subagent Runtime Limits + Environment Isolation + Health Check + State Recovery）
> 本文档解决 **项目级依赖识别与安装** 问题：phase_execution 中为具体科研项目识别并安装执行所需的依赖（Python 包如 numpy/scipy/gmpy2/amflow、Julia 包、C 库等）。**基础设施**（uv、Docker、gcc、GPU）的可用性检测由 Layer 3.6 Health Check 负责，检测结果存储在 `~/.aether/health/global_health.json`；env-provisioner 的核心职责是解决项目执行所需的具体依赖——**识别并安装**，而非仅验证。
> 当前系统问题：(1) 不检查项目级依赖可安装性；(2) 基础设施与项目依赖探测混为一谈；(3) 缺失只报 gap 不主动解决；(4) 商用/开源不区分；(5) 探测挤占 worker 上下文；(6) executor 既执行又安装——职责混乱。
> 改进方案：引入 `env-provisioner` subagent，**统一负责环境识别与安装**。executor 只负责执行研究任务，发现缺失环境时中断汇报。安装遵循 **隔离优先** 原则，商用软件反馈用户决定。所有安装操作设置 **15 分钟时间上限**。

---

## 目录

1. [问题分析](#1-问题分析)
2. [设计决策汇总](#2-设计决策汇总)
3. [两Tier 环境分类体系概述](#3-两tier-环境分类体系概述)
4. [安装范围与同意策略](#4-安装范围与同意策略)
5. [env-provisioner Subagent 定义](#5-env-provisioner-subagent-定义)
6. [环境类型分类与检测规范](#6-环境类型分类与检测规范)
7. [ENVIRONMENT.md 规范更新](#7-environmentmd-规范更新)
8. [autoresearch SKILL.md 修改](#8-autoresearch-skillmd-修改)
9. [research-worker.md 修改](#9-research-workermd-修改)
10. [executor 职责变更](#10-executor-职责变更)
11. [research.md Coordinator 修改](#11-researchmd-coordinator-修改)
12. [文件改动清单](#12-文件改动清单)
13. [验收清单](#13-验收清单)

---

## 1. 问题分析

### 1.1 当前系统的 6 个问题

**A：项目级依赖完全未配置** — autoresearch Step 2 只探测基础设施，不检查项目级依赖（amflow 是否有 wheel、gmpy2 是否需要 GMP）。缺失包在 executor 执行时才暴露，executor 既负责执行又负责安装。

**B：基础设施与项目依赖探测混为一谈** — 基础设施（uv、Docker）是全局级问题（Health Check 负责，结果存于 `global_health.json`），项目依赖（amflow、numpy 版本兼容）是项目级问题（env-provisioner 负责）。两者混在同一 bash 探测步骤中，用同一套 gap 报告机制处理，但解决策略完全不同。

**C：缺失只报 gap，不主动解决** — 很多缺失可自动解决（Python 包 → venv 安装、Docker 内依赖 → Dockerfile、uv/Python 版本 → `uv python install`）。只有宿主机级安装才需用户同意。

**D：商用与开源不区分** — 系统不区分"可自动安装到隔离环境"和"不能自动安装的 Mathematica"。

**E：探测挤占 worker 上下文** — Step 2-4（探测→分类→写 ENVIRONMENT.md）全部在 worker 单次 session 中完成，同时还要 dispatch executor，上下文膨胀。

**F：executor 职责混乱** — local-executor Step 3 包含"创建 .venv + 安装依赖"逻辑。executor 应专注于执行研究任务，环境准备不应是 executor 职责。发现缺失环境时应中断汇报 worker，由 worker 指派 env-provisioner 安装。

### 1.2 核心洞察

**职责分离原则：env-provisioner 负责识别和安装环境，executor 只负责执行任务。**

| 维度     | env-provisioner                     | executor                                        |
| -------- | ----------------------------------- | ----------------------------------------------- |
| 核心职责 | 识别缺失 + 安装到隔离环境 + 验证    | 执行研究脚本/命令 + 收集结果                    |
| 安装权限 | 有（创建 .venv, uv pip install 等） | 无——发现缺失环境时中断，汇报 worker             |
| 发现缺失 | 标记 gap 或主动安装                 | 中断执行 → worker → env-provisioner 重 dispatch |

**基础设施是全局级问题（Health Check → `global_health.json`），项目依赖是项目级问题（env-provisioner → PLAN.md）。** 两类问题的时机、数据来源、缺失处理、同意策略完全不同，详见 §6.8。

**项目级依赖配置是确定性运维任务。** 将它们从 worker 和 executor 的上下文中剥离，交给专用 subagent。安装范围决定同意策略（隔离无需同意，宿主机需同意）。安装超时 15 分钟上限。

### 1.3 影响范围

| 失败场景           | 当前行为            | env-provisioner 后的行为                        |
| ------------------ | ------------------- | ----------------------------------------------- |
| amflow 无 wheel    | executor 执行时失败 | env-provisioner 探测 → 编写 Dockerfile spec     |
| numpy 版本冲突     | 不检查              | env-provisioner 验证 → 安装兼容版本到 .venv     |
| gmpy2 需 GMP       | 不检查              | env-provisioner 探测 → 归类为 docker strategy   |
| uv 不可用          | 标记 gap            | 读取 global_health.json → coordinator 提示用户  |
| Docker 不可用      | 标记 gap            | 读取 global_health.json → 需用户同意后 fallback |
| Mathematica 不可用 | 标记 gap            | 标记 commercial gap → 用户决策                  |
| 安装超时           | executor 卡住       | env-provisioner 自动中断 → 报告用户审核         |

---

## 2. 设计决策汇总

| #   | 决策                                                                    | 原因                                                |
| --- | ----------------------------------------------------------------------- | --------------------------------------------------- |
| D1  | env-provisioner 统一负责环境识别与安装，executor 只负责执行             | 职责分离——executor 发现缺失应中断汇报，不应自行安装 |
| D2  | 两 Tier 分类：Infrastructure（验证）+ Project Dependencies（识别+安装） | 基础设施和项目依赖的关注点、时机、解决策略完全不同  |
| D3  | 隔离优先：venv/Docker 内安装无需用户同意                                | 不影响宿主机，用户期望自动化                        |
| D4  | 宿主机安装需用户同意                                                    | 影响宿主机环境，是侵入性操作                        |
| D5  | 商用软件 → 反馈用户决定                                                 | Mathematica/MATLAB 需许可证                         |
| D6  | 专用 env-provisioner subagent                                           | 确定性运维任务不应挤占 worker/executor 上下文       |
| D7  | 每次只处理一个环境类型                                                  | 聚焦减少遗漏；可并行 dispatch 多个                  |
| D8  | env-provisioner 写独立 probe 文件，worker 原子合并入 ENVIRONMENT.md     | 避免并行写入冲突；原子写入防止半写状态              |
| D9  | 联网搜索安装方法                                                        | 不同 OS/环境的安装方式不同                          |
| D10 | 已配置环境跳过重复检测                                                  | ENVIRONMENT.md status=available 时不再重新探测      |
| D11 | env-provisioner 是 leaf executor（带 websearch/webfetch）               | 不 dispatch subagent，但需联网搜索                  |
| D12 | env-provisioner 允许创建/修改 .venv 和安装 Python 包                    | 职责统一——所有环境安装由 env-provisioner负责        |
| D13 | 安装时间上限 15 分钟，超时自动中断                                      | 防止安装卡住阻塞 cycle；Julia/R/C 包可能耗时        |
| D14 | executor 发现缺失环境 → 中断 + 汇报 → worker dispatch env-provisioner   | executor 不自行安装，职责分离                       |
| D15 | Health Check 结果从 `~/.aether/health/global_health.json` 获取          | 全局级检测结果不应依赖项目级 ENVIRONMENT.md         |
| D16 | PLAN.md environment_requirements 使用结构化 YAML schema                 | 使 env_type 映射更确定                              |
| D17 | ENVIRONMENT.md 写入使用原子协议（临时文件 → rename）                    | 防止合并中断导致半写状态                            |
| D18 | probe 文件保留到 Phase Commit 完成后删除                                | 确保 git 历史有完整 provision 记录                  |
| D19 | gap 解决后只重新 dispatch 失败的 env_type                               | 降低重试成本                                        |

---

## 3. 两Tier 环境分类体系概述

### 3.1 Tier 概念

- **Tier 1: Infrastructure** — 基础设施版本兼容验证。env-provisioner 从 `global_health.json` 获取 Health Check 已检测的可用性数据，只做版本兼容验证。Tier 1 env_type 包括 `uv_python`, `docker`, `cpp_compiler`, `gpu_cuda`, `mathematica`, `matlab`, `julia`, `r_runtime`。除 `uv_python`（isolated scope，可自动安装 Python 版本）外，Tier 1 不可用时标记 gap 由 coordinator 决策。

- **Tier 2: Project Dependencies** — 项目依赖识别+安装+验证。env-provisioner 核心职责。安装到隔离环境（venv/Docker），无需用户同意。Tier 2 env_type 包括 `python_packages`, `python_compiled`, `julia_packages`, `r_packages`, `c_libraries`, `mathematica_pkgs`。

完整 env_type 表格（含探测命令、安装操作、安装方法、宿主机影响说明）见 §6.1 和 §6.2。

### 3.2 关键规则

- Tier 2 安装到隔离环境，**无需用户同意**，env-provisioner 直接安装
- 所有安装操作 **15 分钟时间上限**（详见 §6.7）
- Tier 2 依赖 Tier 1 前提——dispatch 必须先 Tier 1 后 Tier 2

### 3.3 Tier 1 → Tier 2 依赖关系

| Tier 2 依赖       | 需要 Tier 1 前提          | dispatch 约束                      |
| ----------------- | ------------------------- | ---------------------------------- |
| `python_packages` | `uv_python`               | uv_python 先 dispatch              |
| `python_compiled` | `uv_python` + `docker`    | uv_python 和 docker 先 dispatch    |
| `julia_packages`  | `julia`                   | julia 先 dispatch                  |
| `r_packages`      | `r_runtime`               | r_runtime 先 dispatch              |
| `c_libraries`     | `docker` + `cpp_compiler` | docker 和 cpp_compiler 先 dispatch |

---

## 4. 安装范围与同意策略

### 4.1 install_scope 定义

| install_scope           | 定义                 | 同意策略       | 例子                                           |
| ----------------------- | -------------------- | -------------- | ---------------------------------------------- |
| `isolated`              | 安装到隔离环境       | 无需同意       | 创建 .venv + uv pip install；uv python install |
| `isolated_docker`       | 安装到 Docker 容器内 | 无需同意       | 编写 Dockerfile apt-get install spec           |
| `host_install`          | 安装到宿主机         | **需用户同意** | Docker Desktop, xcode-select, brew install gcc |
| `hardware`              | 硬件不可安装         | 标记 gap       | NVIDIA GPU                                     |
| `commercial`            | 商用软件需许可证     | **需用户决定** | Mathematica, MATLAB                            |
| `commercial_dependency` | 依赖商用软件才能安装 | 需用户决定     | Mathematica 包（需要 wolframscript）           |

### 4.2 同意策略流程（权威规范）

此节是 env-provisioner 和 coordinator 的权威同意策略规范。其他章节引用此节。

#### isolated / isolated_docker（无需同意）

env-provisioner 直接安装。安装后通知用户结果（仅告知，非请求同意）。

#### host_install（需用户同意）

env-provisioner 使用 `question` 工具：

"[软件] 需要安装到宿主机。[方法]。
选项: (1) 同意安装, (2) 我自行安装, (3) 跳过此依赖"

- 用户选 (1) → env-provisioner 执行安装（带 10min bash timeout）
- 用户选 (2) → 标记 `host_install_pending` gap → coordinator 等待用户安装后继续（§11.3 retry protocol）
- 用户选 (3) → 标记 `skipped` gap → 使用替代方案或降级

#### commercial / commercial_dependency（需用户决定）

env-provisioner 标记 gap → coordinator 向用户决策（§11.2 定义用户交互模板）：

"[软件] 是商用软件，需要许可证。[用途]。
选项: (1) 我有许可证，已安装, (2) 购买许可证后安装, (3) 使用替代方案, (4) 放弃此任务"

---

## 5. env-provisioner Subagent 定义

### 5.1 Frontmatter

```yaml
---
description: Identify, install, and verify one environment type per invocation
color: "#10B981"
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
  external_directory: ask
  research_state_*: allow
skill_refs: []
mcp:
  research-state: true
output_dir: ".aether/research"
file_scope:
  - ".aether/research/**"
timeout_seconds: 900
---
```

### 5.2 System Prompt

```markdown
<system-reminder>
# Environment Provisioner — HARD CONSTRAINTS

PERMITTED: read/glob/grep any file; edit/write within .aether/research (enforced by file_scope); bash (for environment probing and installation); websearch/webfetch; knowledge_search; question; MCP research-state (get_state only).

FORBIDDEN: write outside .aether/research (enforced by file_scope + bash self-enforcement).

1. **ONE env_type per invocation**. Read dispatch prompt to identify target. Do NOT probe or install other types.
2. **MUST NOT install commercial/licensed software**. Mathematica, MATLAB, Stata — report as `commercial_gap`.
3. **Python packages MUST go into .aether/research/.venv only**. You MAY create .venv if it does not exist, and MUST install packages into it. MUST NOT install on host system.
4. **Host-level installations MUST NOT execute without user consent** via question tool (see §4.2 flow). Isolated installations (venv, Docker, uv python, Julia Pkg, R packages) do NOT require consent.
5. **15-minute overall budget** (enforced by timeout_seconds: 900). Each bash command MUST have a 10-minute timeout (`timeout 600 <command>`). Exceed → mark `install_timeout` in probe file.

Approved installation sources only: official installers, OS package managers (brew/apt), uv python install, PyPI (via uv pip into .venv), Julia Pkg, R install.packages. MUST NOT install arbitrary/untrusted packages.

# ═══════════════════════════════════════════════════════════

# ENVIRONMENT PROVISIONER — Identify, Install & Verify One Environment Type

# ═══════════════════════════════════════════════════════════

You handle ONE environment type per invocation, then return a provisioning_result.

## Tier Routing

Read dispatch prompt's `tier` field. Tier overview: see §3. Detailed per-env_type specs: see §6. Health Check results: see §6.8. Consent strategy: see §4.2.

## Provisioning Protocol (skeleton)

1. **Read dispatch prompt + Health Check** → identify env_type, tier, requirements, install_scope. Read `~/.aether/health/global_health.json` for Tier 1 baseline (§6.8).
2. **Check ENVIRONMENT.md** → if target_env_type status=available + satisfies_requirements → skip_reuse (D10).
3. **Probe status** → per §6 env_type specs. Tier 1: verify version compatibility on top of Health Check data. Tier 2: identify missing dependencies, check installability.
4. **Apply consent strategy** → per §4.2 flow based on install_scope. Install to isolated env without consent; ask consent for host_install; report commercial/hardware gap.
5. **Install** → per §6 install operations for each env_type. isolated scope: create .venv / install packages / verify. isolated_docker scope: write Dockerfile spec. host_install scope: execute after consent.
6. **Report gaps** → commercial/hardware gap → write gap entry to probe file.
7. **Write probe file** → `.aether/research/persistence/env_probe_[env_type].md`. Fields: env_type, tier, install_scope, status, version, satisfies_requirements, provisioned_by, provision_method, install_timestamp, uninstall_command, resolved_packages (each with scope+installed), docker_dependencies, dockerfile_path, venv_state, install_timeout_packages, details.
8. **Notify user** → informational for isolated installs; already-got-consent for host_install; gap report for commercial/hardware.
9. **Output provisioning_result YAML** → fields: env_type, tier, action (skip_reuse|available_pre_existing|auto_install|venv_install|dockerfile_spec|commercial_gap|hardware_gap|installation_failure|version_mismatch|host_install_pending|skipped|install_timeout|provisioning_timeout), status, version, path, satisfies_requirements, install_scope, commercial, install_method, resolved_packages, docker_dependencies, dockerfile_path, venv_state, details, gap_reason, user_action_required.

MUST NOT output any other text after this YAML block.
</system-reminder>
```

---

## 6. 环境类型分类与检测规范

### 6.1 Tier 1: Infrastructure env_types

| env_type       | Health Check 覆盖（global_health.json） | env-provisioner 额外职责 | install_scope  | 探测命令                                        | 宿主机影响说明                           |
| -------------- | --------------------------------------- | ------------------------ | -------------- | ----------------------------------------------- | ---------------------------------------- |
| `uv_python`    | uv + Python 版本                        | 版本兼容+包验证          | `isolated`     | `uv --version`, `uv python list`                | uv 管理目录，不触碰 host python          |
| `docker`       | client + daemon                         | 版本是否满足 PLAN.md     | `host_install` | `docker version`, `docker run --rm hello-world` | 4-5GB GUI 应用，修改系统网络，常驻后台   |
| `cpp_compiler` | 无                                      | 探测可用性+版本兼容      | `host_install` | `gcc --version`, `clang --version`              | 需要 sudo (Linux) / xcode-select (macOS) |
| `gpu_cuda`     | 无                                      | 探测可用性               | `hardware`     | `nvidia-smi`, `nvcc --version`                  | 硬件不可安装                             |
| `mathematica`  | 无                                      | 探测可用性               | `commercial`   | `wolframscript --version`                       | 需许可证                                 |
| `matlab`       | 无                                      | 探测可用性               | `commercial`   | `matlab -batch "disp('ok')"`                    | 需许可证                                 |
| `julia`        | 无                                      | 探测可用性+版本兼容      | `host_install` | `julia --version`                               | 修改 PATH，~500MB                        |
| `r_runtime`    | 无                                      | 探测可用性+版本兼容      | `host_install` | `R --version`, `which Rscript`                  | 需 sudo (Linux) / ~200MB (macOS)         |

env-provisioner 读取 `global_health.json` 获取 Health Check 已覆盖项的检测结果，只对未覆盖项执行 bash 探测。Tier 1 env_type 除 `uv_python` 外不可用时标记 gap。

### 6.2 Tier 2: Project Dependency env_types

| env_type           | 典例依赖                     | install_scope           | 识别方法                    | 安装操作（env-provisioner 执行）          | 不影响宿主机原因   |
| ------------------ | ---------------------------- | ----------------------- | --------------------------- | ----------------------------------------- | ------------------ |
| `python_packages`  | numpy, scipy, sympy          | `isolated`              | dry-run + 检查 .venv 已有包 | 创建 .venv → uv pip install → 验证 import | .venv 完全隔离     |
| `python_compiled`  | amflow, gmpy2, pybind11 模块 | `isolated_docker`       | 检查 PyPI wheel 可用性      | 编写 Dockerfile.env_python_compiled       | Docker 容器隔离    |
| `julia_packages`   | DifferentialEquations.jl     | `isolated`              | 检查 Julia 项目环境已有包   | julia Pkg.add → 验证 using                | Julia 项目环境隔离 |
| `r_packages`       | ggplot2, lme4                | `isolated`              | 检查 R 用户库已有包         | Rscript install.packages → 验证 library   | R 用户库隔离       |
| `c_libraries`      | GMP, MPFR, FFTW              | `isolated_docker`       | 搜索 apt/brew 可用性        | 编写 Dockerfile.env_c_libraries           | Docker 容器隔离    |
| `mathematica_pkgs` | Mathematica 包               | `commercial_dependency` | 需 wolframscript 可用       | 只探测（依赖商用软件）                    | 依赖 wolframscript |

### 6.3 python_packages 详细规范

env-provisioner 最核心的 env_type：

1. 提取所需 Python 包列表（结构化 YAML from dispatch prompt）
2. 检查 .venv 是否存在及 venv_state 已有包是否覆盖需求
3. 对缺失包 `uv pip install --dry-run` 验证可安装性
4. 分类并处理：

| dry-run 结果           | 分类               | env-provisioner 操作                |
| ---------------------- | ------------------ | ----------------------------------- |
| 有 wheel，dry-run 成功 | `pure_python`      | 安装到 .venv → 验证 import          |
| 无 wheel，需编译       | `needs_docker`     | 编写 Dockerfile.env_python_compiled |
| 不在 PyPI              | `not_on_pypi`      | websearch 替代源或报告 gap          |
| 版本冲突               | `version_conflict` | 指定兼容版本安装或报告 gap          |

### 6.4 python_compiled 详细规范

1. 检查 PyPI wheel 可用性：`timeout 600 uv pip install --dry-run [package]`
2. 无 wheel → 编写 Dockerfile spec（`isolated_docker` scope）
3. 有 wheel → 降级为 `python_packages`（直接安装到 .venv）

### 6.5 PLAN.md environment_requirements → env_type 映射

| requirement 字段                                | 映射 env_type              | tier                         |
| ----------------------------------------------- | -------------------------- | ---------------------------- |
| `software: python, version: "3.11"`             | `uv_python`                | infrastructure               |
| `software: python, packages: [numpy, scipy]`    | `python_packages`          | project_dependency           |
| `software: python, packages_compiled: [amflow]` | `python_compiled`          | project_dependency           |
| `software: docker`                              | `docker`                   | infrastructure               |
| `software: mathematica, version: "13+"`         | `mathematica`              | infrastructure               |
| `software: julia, packages: [...]`              | `julia` + `julia_packages` | infrastructure + project_dep |
| `software: gpu_cuda`                            | `gpu_cuda`                 | infrastructure               |
| `software: c_libraries, names: [GMP]`           | `c_libraries`              | project_dependency           |

### 6.6 PLAN.md environment_requirements 结构化 Schema

```yaml
environment_requirements:
  - id: req_1
    software: python
    version: "3.11"
    packages: ["numpy", "scipy", "sympy"]
    packages_compiled: ["amflow"]
    purpose: "numerical simulation"
    critical: true
  - id: req_2
    software: docker
    purpose: "C++ compilation isolation"
    critical: false
```

Schema 规则：

| 字段                | 类型         | 必填 | 说明                                                                        |
| ------------------- | ------------ | ---- | --------------------------------------------------------------------------- |
| `id`                | string       | 是   | 条目唯一标识                                                                |
| `software`          | string       | 是   | 合法值: python/docker/mathematica/julia/r/gpu_cuda/cpp_compiler/c_libraries |
| `version`           | string       | 否   | 版本要求（如 "3.11+"）                                                      |
| `packages`          | list[string] | 否   | 纯 Python 包列表                                                            |
| `packages_compiled` | list[string] | 否   | 可能需编译的包列表                                                          |
| `purpose`           | string       | 是   | 用途                                                                        |
| `critical`          | boolean      | 是   | true = 不可继续；false = 可降级                                             |

`software` 合法值映射到 env_type：`python` → `uv_python` + `python_packages`/`python_compiled`; 其余一对一映射。research-question-framing SKILL.md 模板需更新为此结构化格式。

### 6.7 安装超时机制

| 超时层级 | 时限  | 实现                         | 触发后行为                                                 |
| -------- | ----- | ---------------------------- | ---------------------------------------------------------- |
| 单命令   | 10min | bash `timeout 600 <command>` | 命令被 SIGTERM → probe 文件记录 install_timeout            |
| 整体     | 15min | frontmatter timeout_seconds  | task tool timeout error → worker 标记 provisioning_timeout |

超时后 probe 文件记录 `install_timeout_packages: [{name, timeout_type, duration, suggestion}]`。coordinator 向用户提供继续/替代/跳过选项。

### 6.8 Health Check 结果获取

env-provisioner 从 `~/.aether/health/global_health.json` 读取 Health Check 检测结果。此文件是 Tier 1 env_type 可用性数据的唯一来源，env-provisioner 不自行探测 Health Check 已覆盖的项。

文件格式（与 Layer 3.6 一致）：

```json
{
  "layers": {
    "infrastructure": {
      "checks": {
        "uv_available": { "status": "pass", "version": "0.6.x" },
        "docker_available": { "status": "pass", "version": "27.x" },
        "docker_daemon": { "status": "pass", "running": true }
      }
    }
  }
}
```

worker 在 dispatch env-provisioner 时，将 global_health.json 中与该 env_type 相关的检测结果摘要写入 dispatch prompt（避免 env-provisioner 解析整个 JSON）。env-provisioner 对 Health Check 未覆盖的项（gcc、wolframscript、julia、R、matlab）执行 bash 探测。

---

## 7. ENVIRONMENT.md 规范更新

### 7.1 host_system 结构

旧版（Layer 3.5）扁平结构改为两 Tier 详细结构。每个 env_type 条目包含：`status`, `version`, `satisfies_requirements`, `provisioned_by`, `provision_method`, `install_timestamp`, `install_scope`, `resolved_packages`（Tier 2）, `docker_dependencies`（isolated_docker）, `venv_state`（python_packages）。

代表性条目示例：

```yaml
host_system:
  os: "[auto-detected]"

  # Tier 1 representative entry
  uv_python:
    status: available
    uv_version: "0.6.x"
    python_versions: ["3.11", "3.12"]
    satisfies_requirements: true
    provisioned_by: "env-provisioner"
    provision_method: "uv-python-install"
    install_scope: "isolated"

  # Tier 1 gap entry
  mathematica:
    status: gap
    commercial: true
    required_version: "13+"
    satisfies_requirements: false
    install_scope: "commercial"
    user_action_required: "Purchase Mathematica license"

  # Tier 2 representative entry
  python_packages:
    status: available
    resolved_packages:
      - { name: "numpy", version: "1.26.x", has_wheel: true, scope: "isolated", installed: true }
      - { name: "amflow", has_wheel: false, scope: "isolated_docker", installed: false }
    venv_state: { path: ".aether/research/.venv", python_version: "3.11", installed_packages: ["numpy", "scipy"] }
    satisfies_requirements: true
    provisioned_by: "env-provisioner"
    provision_method: "venv-create+pip-install"
    install_scope: "isolated"
```

所有 env_type 条目遵循相同字段 schema。完整字段列表见 §5.2 Step 7 probe file format。docker、cpp_compiler、julia 等其他 Tier 1 条目和 python_compiled、julia_packages 等其他 Tier 2 条目结构相同，字段从 §6.1/6.2 表格和 §4.1 install_scope 定义推导。

### 7.2 venv_state 结构变更

venv_state 从 local-executor 管理改为 env-provisioner 管理：

```yaml
venv_state:
  path: ".aether/research/.venv"
  python_version: "3.11"
  created_by: "env-provisioner"
  installed_packages: [{ name: "numpy", version: "1.26.x" }]
  last_updated_cycle: 1
```

local-executor 只读取 venv_state 确认环境就绪，不再修改此字段。

### 7.3 provision_log 格式

provision_log 条目格式（env-provisioner 安装操作的审计记录）：

```yaml
provision_log:
  - {
      env_type: "uv_python",
      tier: "infrastructure",
      action: "auto-install",
      method: "uv-python-install",
      install_scope: "isolated",
      install_command: "uv python install 3.11",
      uninstall_command: "uv python uninstall 3.11",
      verification: "...",
      cycle: 1,
    }
  - {
      env_type: "python_packages",
      tier: "project_dependency",
      action: "venv-create+install",
      method: "venv-create+pip-install",
      install_scope: "isolated",
      install_command: "uv venv .aether/research/.venv && uv pip install numpy scipy",
      verification: "...",
      cycle: 1,
    }
```

每个条目必含字段：`env_type`, `tier`, `action`, `method`, `install_scope`, `install_command`, `uninstall_command` (host_install scope), `verification`, `cycle`。`action` 合法值：`auto-install | consent-install | venv-create+install | verify-only | dockerfile-spec-write | install-verify-only`。

### 7.4 gaps section

gap_type 分类：`commercial | hardware | installation_failure | version_mismatch | host_install_pending | not_on_pypi | install_timeout | provisioning_timeout`。

每个 gap 条目包含：`env_type`, `tier`, `gap_type`, `install_scope`, `critical`, `purpose`, `user_action_required`。`commercial=true` 需额外 `required_version`。

### 7.5 ENVIRONMENT.md 原子写入协议

worker 合并 probe 文件时使用原子协议（防止半写状态）：

1. 合并所有 probe 文件到内存
2. 读取现有 ENVIRONMENT.md（保留不受本次合并影响的字段）
3. 写入临时文件 `ENVIRONMENT_new.md`
4. 验证临时文件完整性（YAML 可解析、所有 probe 条目已包含）
5. rename `ENVIRONMENT_new.md` → `ENVIRONMENT.md`（原子操作）
6. rename 失败 → 删除临时文件，旧 ENVIRONMENT.md 不受影响

### 7.6 Migration Protocol

1. ENVIRONMENT.md 模板一次性替换为新模板
2. 首次 env-provisioner 写入重建 host_system section（使用原子写入协议）
3. venv_state 迁移：旧版格式兼容——worker 合并时保留旧 venv_state，env-provisioner 下次 dispatch 时更新
4. 旧 ENVIRONMENT.md 数据：如果旧文件有 venv_state 数据，合并时保留

---

## 8. autoresearch SKILL.md 修改

### 8.1 替换 Step 2

**Step 2.0**: Read `~/.aether/health/global_health.json` → 提取基础设施可用性数据。

**Step 2.1**: 读 PLAN.md `environment_requirements`（结构化 YAML, §6.6）→ 映射到 env_type + tier（§6.5）→ 去重。

**Step 2.2**: 读 ENVIRONMENT.md → 已 available+satisfies 的 env_type 从 provision 列表移除；gap 状态的保留（retry）。

**Step 2.3**: Dispatch env-provisioner via task tool。dispatch prompt 包含 env_type、tier、requirements、install_scope、Health Check 摘要（从 global_health.json 提取）。

dispatch 顺序：(1) Tier 1 先 dispatch（uv_python 优先）；(2) Tier 2 后 dispatch（依赖 Tier 1 结果）；(3) 同 Tier 内无依赖的可并行。

**Step 2.4**: 收集 provisioning_results → 读 probe 文件 → 原子合并入 ENVIRONMENT.md（§7.5）→ probe 文件保留到 Phase Commit 完成后删除（D18）。

### 8.2 Step 3 (Classify Isolation Strategy)

逻辑不变（Layer 3.5 classification rules），输入来源改为 ENVIRONMENT.md。新增：`python_compiled` env_type 包归类为 `docker` strategy。

### 8.3 Step 4 (Write ENVIRONMENT.md)

worker 补充 ENVIRONMENT.md（原子写入）：`probe_timestamp`, `cycle`, `plan_requirements`（从 PLAN.md 提取）, `isolation_strategy`, `venv_state`（env-provisioner 管理，worker 只读）, `gaps`（已从 probe files 合并）。

### 8.4 Step 5 (Gap Check)

区分 gap_type + install_scope。每种 gap 的处理流程见 §4.2 同意策略和 §11.2 coordinator gap handling。

### 8.5 Step 10 (PhaseResultDigest)

新增字段（unchanged fields 不重复列出）：

| 新增字段                   | 类型 | 说明                                                   |
| -------------------------- | ---- | ------------------------------------------------------ |
| `environment_provisioning` | list | 各 env_type 摘要（含 tier, install_scope, venv_state） |
| `commercial_gaps`          | list | 商用软件缺口                                           |
| `host_install_pending`     | list | 等待用户手动安装的软件                                 |
| `pending_user_actions`     | list | 已安装但需用户操作                                     |
| `install_timeouts`         | list | 安装超时的包列表                                       |

---

## 9. research-worker.md 修改

### 9.1 Subagent Dispatch Rules 增加 env-provisioner

```
- Allowed: research-explorer, sandbox-executor, local-executor, env-provisioner, gpd-verifier, gpd-reviewer, research-verifier
```

### 9.2 executor 中断 → env-provisioner 重 dispatch 协议

executor 发现缺失环境时：

1. **中断执行**（不在执行中自行安装任何包）
2. 写入 EXECUTION.md：`"environment_missing: [package] is not available in .venv"`
3. 返回 execution_result：`status: environment_missing`, `missing_env: [package]`, `env_type_hint: python_packages`

worker 收到 `environment_missing` 后：

- 无对应 env_type 条目 → dispatch env-provisioner 处理该 env_type
- 有条目但 status=gap → 报告 coordinator（§11.3 retry protocol）
- env-provisioner 安装完成后 → 重新 dispatch executor

---

## 10. executor 职责变更

### 10.1 local-executor

**移除 venv 创建/管理职责**。Step 3 修改：

```
旧版: Check .venv → if missing: create + install → if packages missing: uv pip install
新版: Check .venv → if exists and packages match: proceed → if missing: ABORT, report environment_missing
```

新增 HARD CONSTRAINT：

```
HARD CONSTRAINT: MUST NOT create .venv or install Python packages. Environment provisioning belongs to env-provisioner. If packages are missing, abort and report environment_missing — worker will dispatch env-provisioner.
```

删除 local-executor Step 6 (Update ENVIRONMENT.md)——local-executor 不再更新 venv_state。

### 10.2 sandbox-executor

新增子步骤：Read Dockerfile specs from `.aether/research/Dockerfile.env_*`。如果 env-provisioner 已编写 Dockerfile specs → 使用它们作为 Docker image build base。

新增 HARD CONSTRAINT：

```
HARD CONSTRAINT: MUST NOT install additional packages inside Docker beyond what env-provisioner specified in Dockerfile. If missing, abort and report environment_missing.
```

---

## 11. research.md Coordinator 修改

### 11.1 Execution Loop dispatch prompt 更新

```
"Execute execution_cycle (cycle [N]). Invoke /autoresearch skill. Read PLAN.md, read Health Check from ~/.aether/health/global_health.json, dispatch env-provisioner for infrastructure validation and project dependency installation, classify isolation strategy, dispatch executors."
```

### 11.2 Coordinator 对各类 gap 的处理（权威交互模板）

#### commercial_gaps

"[软件] 是商用软件，需要许可证。[用途]。
选项: (1) 我有许可证，已安装（重试检测）, (2) 购买许可证后安装, (3) 使用替代方案, (4) 放弃此任务"

用户选 (1) → §11.3 retry protocol

#### host_install_pending

"[软件] 需要您手动安装。建议安装命令: [command]。安装完成后重试即可。"

用户确认已安装 → §11.3 retry protocol

#### pending_user_actions

"[软件] 已安装但需要您的操作: [action]。完成后重试即可。"

#### install_timeout

"[包] 安装超过时间上限。选项: (1) 重试安装（延长超时）, (2) 我手动安装, (3) 使用替代包, (4) 跳过此依赖"

#### installation_failure / version_mismatch / not_on_pypi

报告详情 + 手动安装指引。

### 11.3 Gap Resolution Retry Protocol

gap 解决后，只重新 dispatch 失败的 env_type env-provisioner：

```
task(
  description: "retry provision [env_type]",
  subagent_type: "env-provisioner",
  prompt: "Provision [env_type] — retry after gap resolution. [gap resolution details]. Health Check summary: [from global_health.json]. Read ENVIRONMENT.md."
)
```

env-provisioner 返回 → worker 原子更新 ENVIRONMENT.md 对应条目（不重建整个 host_system）→ coordinator 继续 execution。

### 11.4 Session Recovery 更新

1. Read `~/.aether/health/global_health.json` → infrastructure availability
2. Read STATE.md, state.json, DIGESTS.md, ENVIRONMENT.md
3. ENVIRONMENT.md provision_log → note env-provisioner-installed software
4. ENVIRONMENT.md gaps → remind user (commercial, host_install_pending, pending_user_actions, install_timeout)

### 11.5 Phase Commit Protocol 集成

Phase Commit（Layer 3.7 §6.2）时 `git add .aether/research/` 包含：

- ENVIRONMENT.md
- `env_probe_*.md`（所有 probe 文件——完整 provision 记录）
- `Dockerfile.env_*`（env-provisioner 编写的 Dockerfile specs）
- `.venv/` 被 `.gitignore` 排除

Phase Commit 完成后（clean check 通过）→ worker 删除 probe 文件。

### 11.6 phase_checkpoint 展示更新

```
- Environment requirements: [from PLAN.md]
- Infrastructure: [Tier 1 env_types with status]
- Project dependencies: [Tier 2 env_types with resolved_packages, installed status]
- Gaps: [by gap_type + install_scope]
- Pending actions / timeouts: [list]
```

---

## 12. 文件改动清单

| 文件                                                | 操作     | 核心变更                                           |
| --------------------------------------------------- | -------- | -------------------------------------------------- |
| `.aether/agent/env-provisioner.md`                  | 新建     | subagent 定义（frontmatter+system prompt）         |
| `.aether/skills/autoresearch/SKILL.md`              | 大改     | Step 2 替换为 env-provisioner dispatch + 原子合并  |
| `.aether/agent/research-worker.md`                  | 小改     | 增加 env-provisioner + executor 中断协议           |
| `.aether/agent/local-executor.md`                   | 中改     | 移除 venv 管理 + 增加 environment_missing 约束     |
| `.aether/agent/sandbox-executor.md`                 | 小改     | Dockerfile.env\_\* 读取 + environment_missing 约束 |
| `.aether/agent/research.md`                         | 中改     | dispatch prompt + gap retry + Session Recovery     |
| `.aether/skills/research-question-framing/SKILL.md` | 小改     | PLAN.md environment_requirements 结构化            |
| `.aether/research/persistence/ENVIRONMENT.md`       | 模板更新 | 两 Tier 结构 + env-provisioner 管理 venv_state     |
| `.aether/mcp/research-state/server.py`              | 小改     | 白名单增加 Dockerfile.env*\* 和 env_probe*\*       |

核心源文件改动：**零**（仅 MCP server 白名单常量变更）。

---

## 13. 验收清单

### 13.1 env-provisioner 定义（§5）

- [ ] Frontmatter 包含 bash/websearch/webfetch/question 权限 + `timeout_seconds: 900`
- [ ] System prompt 包含 5 条 HARD CONSTRAINTS（单 env_type、不装商用、isolated-only pip、host_install 需同意、15min 超时）
- [ ] System prompt **不包含** "MUST NOT create .venv" 约束
- [ ] System prompt Provisioning Protocol 为骨架+引用（不重复 §4/§6 详细规范）
- [ ] provisioning_result YAML 包含 tier, install_scope, resolved_packages, venv_state, install_timeout_packages

### 13.2 两 Tier 分类（§3/§6）

- [ ] Tier 1 env_type 列表匹配 §6.1 表格（8 env_types）
- [ ] Tier 2 env_type 列表匹配 §6.2 表格（6 env_types）
- [ ] §3 不包含重复的 env_type 表格（只有概述+指向 §6 的引用）
- [ ] Tier 1→2 依赖关系匹配 §3.3 表格
- [ ] alpha_cli 不在 env_type 列表中

### 13.3 同意策略（§4）

- [ ] install_scope 定义匹配 §4.1 表格（6 scopes）
- [ ] 同意策略流程匹配 §4.2（权威规范）
- [ ] §5.2、§8.4、§11.2 中的同意/gap 引用 §4.2，不重复定义

### 13.4 项目依赖安装（§6 + §10）

- [ ] python_packages：env-provisioner 创建 .venv → install → verify import（§6.3）
- [ ] python_compiled：env-provisioner 编写 Dockerfile spec（§6.4）
- [ ] env-provisioner 创建并管理 .venv（D12）
- [ ] local-executor 不创建 .venv / 不安装 packages（§10.1）
- [ ] local-executor environment_missing 中断 → worker dispatch env-provisioner（§9.2）
- [ ] sandbox-executor 使用 Dockerfile.env\_\* + environment_missing 中断（§10.2）

### 13.5 安装超时（§6.7）

- [ ] frontmatter `timeout_seconds: 900`（15min 整体）
- [ ] 单命令 10min bash timeout
- [ ] probe 文件记录 `install_timeout_packages`
- [ ] coordinator 提供继续/替代/跳过选项

### 13.6 Health Check 结果（§6.8）

- [ ] env-provisioner 从 `~/.aether/health/global_health.json` 读取（D15）
- [ ] worker dispatch prompt 包含 Health Check 摘要
- [ ] env-provisioner 对 Health Check 已覆盖项不做重复 bash 探测

### 13.7 并行写入安全与原子协议（§7.5 + D8/D17/D18）

- [ ] env-provisioner 写独立 probe 文件 `env_probe_[env_type].md`
- [ ] worker 使用原子写入协议合并（临时文件 → rename）
- [ ] probe 文件保留到 Phase Commit 完成后删除

### 13.8 ENVIRONMENT.md（§7）

- [ ] 两 Tier 详细结构（§7.1）
- [ ] venv_state 由 env-provisioner 管理（§7.2）
- [ ] provision_log 含 install_command（非 null）+ uninstall_command（§7.3）
- [ ] gaps 包含 gap_type + install_scope + install_timeout 类型（§7.4）
- [ ] 原子写入协议文档化（§7.5）

### 13.9 PLAN.md 结构化 Schema（§6.6）

- [ ] PLAN.md environment_requirements 使用结构化 YAML schema
- [ ] research-question-framing SKILL.md 模板更新

### 13.10 autoresearch + coordinator 改动（§8 + §11）

- [ ] autoresearch Step 2 不包含 bash 探测命令
- [ ] autoresearch Step 2 包含 env-provisioner dispatch + Health Check 摘要 + 原子合并
- [ ] Coordinator gap handling 匹配 §11.2 交互模板
- [ ] Gap retry protocol 匹配 §11.3
- [ ] Session Recovery 检查 global_health.json + provision_log + gaps
- [ ] Phase Commit 包含 probe 文件 + Dockerfile.env\_\*（§11.5）

### 13.11 安全约束（§5.2 HARD CONSTRAINTS）

- [ ] 所有 5 条 HARD CONSTRAINTS 在 system prompt 中存在
- [ ] env-provisioner 不安装商用软件
- [ ] env-provisioner 创建 .venv + 安装 packages（isolated scope）
- [ ] env-provisioner host_install scope 需用户同意
- [ ] env-provisioner 不修改 global_health.json（只读）

### 13.12 回退安全

- [ ] 删除 env-provisioner.md + 恢复旧版 autoresearch SKILL.md + 恢复旧版 local-executor.md → 回退到 Layer 3.5 架构
- [ ] ENVIRONMENT.md 旧版模板可恢复
