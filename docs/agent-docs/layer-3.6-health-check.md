# Layer 3.6: Research Agent Health Check — 分层检测架构

> 前置依赖: Layer 0-3.5（核心安全 + Agent 基础设施 + Research 配置层 + Research Infrastructure + Gap Analysis + Context Isolation + Subagent Runtime Limits + Environment Isolation）
> 本文档定义 research agent 启动前的分层健康检测机制。当前系统无主动 health 检测——MCP servers 可能离线、uv 不可用、Docker 未启动、skill 引用链断裂时，agent 只能在运行时碰错才发现。改进方案：引入 4 层分级检测 + MCP tool 集成 + agent 启动时自检。

---

## 目录

1. [问题分析](#1-问题分析)
2. [设计决策汇总](#2-设计决策汇总)
3. [分层检测架构](#3-分层检测架构)
4. [MCP Health Tool 设计](#4-mcp-health-tool-设计)
5. [Agent 启动自检协议](#5-agent-启动自检协议)
6. [降级策略](#6-降级策略)
7. [实现细节](#7-实现细节)
8. [验收清单](#8-验收清单)

---

## 1. 问题分析

### 1.1 当前系统的 5 个健康盲点

**盲点 A：MCP 服务器可能离线但无人知道**

research-state 和 research-conventions 是两个独立 MCP 进程。当前 `run_health_check`（research-state MCP）只检查文件结构，不检测 MCP 自身是否在线——因为它本身就是 MCP，能被调用就证明自己在线。但 research-conventions MCP 是否在线，research-state 无法检测。如果 research-conventions MCP 崩溃，gpd-verifier/gpd-reviewer 在执行时调用 `convention_lock_status` 会返回错误，但此时已进入了 phase_execution，无法回退。

**盲点 B：执行环境未预检**

autoresearch skill 的 Step 2 探测宿主机环境（`python3 --version`, `uv --version`, `docker --version` 等），但这是在 phase_execution 才做的。更早的 phase（analysis、landscape、framing）也可能需要 alpha CLI 或 uv run，但没有预检。如果 alpha CLI 未认证，在 phase_analysis 调用 alpha-research 时才发现降级到 no-login mode，搜索质量已经受限。

**盲点 C：skill 引用链断裂不可知**

每个 agent 的 `skill_refs` 列出了依赖的 skill 名称。当前无机制验证这些 skill 的 SKILL.md 是否存在于 skills 目录中。如果 gpd-verification 的 SKILL.md 被误删，gpd-verifier 调用 `skill` tool 加载时会失败，但失败发生在 phase_execution 的 verification 子阶段——最昂贵的阶段。

**盲点 D：SymPy 脚本依赖不可知**

gpd-verification 的 9 个 SymPy 脚本通过 `uv run`（PEP 723）执行。脚本声明了 `sympy` 依赖，但 `uv run` 是否能成功安装 sympy 并执行，取决于网络和 uv 本身是否可用。当前在 verification 阶段才发现脚本无法运行，此时只能降级为 LLM-only reasoning——违反 gpd-verification 的核心原则。

**盲点 E：host python3 检测不合理**

autoresearch skill Step 2 探测 `python3 --version`，但系统中没有任何组件直接使用 `python3`。所有 Python 执行走 `uv run`（PEP 723 inline metadata）或 `.venv/bin/python`（uv venv）。检测 host python3 检测的是一个不被使用的系统，而真正需要的 `uv` 可用性未被充分验证。

### 1.2 影响范围

| 失败场景                       | 在哪个 phase 发现               | 代价                               |
| ------------------------------ | ------------------------------- | ---------------------------------- |
| research-conventions MCP 离线  | phase_execution                 | 无法读写约定锁，验证流程中断       |
| uv 不可用                      | phase_execution                 | 所有 SymPy 脚本和 venv 创建失败    |
| Docker 不可用                  | phase_execution                 | sandbox-executor 无法启动容器      |
| alpha CLI 未认证               | phase_analysis                  | 论文搜索降级为 title+abstract only |
| gpd-verification SKILL.md 缺失 | phase_execution（verification） | 物理验证降级为 LLM-only            |
| SymPy 脚本无法运行             | phase_execution（verification） | 计算验证降级为 LLM-only            |

所有这些失败都在运行时才发现，越晚发现代价越高。

---

## 2. 设计决策汇总

| #   | 决策                                                                | 原因                                                                        | 替代方案                  |
| --- | ------------------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------- |
| D1  | 4 层分级检测（基础设施 → Skill 引用链 → 运行时 → 持久化）           | 分层检测可以快速定位故障层级，避免全量检测浪费时间                          | 单一扁平检测列表          |
| D2  | Health tool 放在 research-state MCP 中                              | research-state MCP 已有 `run_health_check`，扩展它而非新建 MCP              | 新建独立 health MCP       |
| D3  | 不检测 host python3，检测 uv 可用性                                 | 系统中无组件使用 host python3，所有 Python 执行走 uv                        | 同时检测 python3 和 uv    |
| D4  | SymPy 脚本检测用 dry-run（空输入 JSON）而非实际计算                 | 不引入真实计算依赖，只验证脚本可启动并返回合法 JSON 格式                    | 运行一个真实 SymPy 表达式 |
| D5  | MCP cross-health：research-state 检测 research-conventions 是否在线 | 两个 MCP 是独立进程，需要互相感知在线状态                                   | 各 MCP 只检测自身         |
| D6  | Agent 启动时自检（非强制阻塞）                                      | 自检结果写入 STATE.md，agent 可读后决定是否降级或继续，但不阻塞用户立即使用 | 自检失败则拒绝启动        |

---

## 3. 分层检测架构

### Layer 1: 基础设施（Infrastructure）

检测运行环境的基本可用性。这些是所有后续层的前提。

| 检测项             | 检测方法                                                       | 预期结果                | 影响的组件                                   |
| ------------------ | -------------------------------------------------------------- | ----------------------- | -------------------------------------------- |
| **uv 可用**        | `uv --version`                                                 | 返回版本号，exit code 0 | local-executor, 所有 SymPy 脚本, MCP servers |
| **uv Python 管理** | `uv python list`                                               | 列出可用 Python 版本    | local-executor, gpd-verification scripts     |
| **Docker 可用**    | `docker version --format '{{.Server.Version}}'`                | 返回版本号，exit code 0 | sandbox-executor                             |
| **Docker daemon**  | `docker info --format '{{.ServerVersion}}'`                    | daemon 在运行           | sandbox-executor                             |
| **NVIDIA GPU**     | `nvidia-smi --query-gpu=name --format=csv,noheader`            | 列出 GPU 名称（可选）   | sandbox-executor（GPU 任务）                 |
| **alpha CLI**      | `alpha status`                                                 | 返回认证状态            | alpha-research skill（CLI mode）             |
| **网络可达**       | `curl -s -o /dev/null -w "%{http_code}" https://api.arxiv.org` | HTTP 200                | alpha-research no-login mode, webfetch       |

**关键设计**：不检测 `python3 --version`。uv 可以独立管理 Python 版本（`uv python install`），host python3 不是依赖。

### Layer 2: Skill 引用链（Skill Reference Chain）

检测每个 agent 的 `skill_refs` 指向的 SKILL.md 是否存在，以及 gpd plugin 的 references JSON 和 scripts 是否完整。

| 检测项                                       | 检测方法                                                                                 | 预期结果      | 影响的组件                 |
| -------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------- | -------------------------- |
| **research-worker: alpha-research**          | 查找 `.aether/skills/alpha-research/SKILL.md`                                            | 文件存在      | research-worker            |
| **sandbox-executor: docker**                 | 查找 `.aether/skills/docker/SKILL.md`                                                    | 文件存在      | sandbox-executor           |
| **research-verifier: research-verification** | 查找 `.aether/skills/research-verification/SKILL.md`                                     | 文件存在      | research-verifier          |
| **gpd-verifier: 5 个 skill_refs**            | 查找每个 gpd-\* skill 的 SKILL.md                                                        | 全部 5 个存在 | gpd-verifier               |
| **gpd-reviewer: 3 个 skill_refs**            | 查找每个 gpd-\* skill 的 SKILL.md                                                        | 全部 3 个存在 | gpd-reviewer               |
| **gpd-verification scripts**                 | 查找 `scripts/` 下 9 个 .py 文件                                                         | 全部 9 个存在 | gpd-verifier               |
| **gpd-verification references**              | 查找 `references/check_registry.json` + `contract_checks.json` + 14 个 domain_checklists | 全部存在      | gpd-verifier               |
| **gpd-errors references**                    | 查找 error_catalog.json + traceability_matrix.json + detection_strategies.json           | 全部存在      | gpd-reviewer, gpd-verifier |
| **gpd-conventions references**               | 查找 convention_defaults.json + subfield_defaults/physics.json                           | 全部存在      | gpd-conventions MCP        |
| **gpd-domain-check references**              | 查找 4 个 protocols + 14 个 bundles                                                      | 全部存在      | gpd-reviewer, gpd-verifier |
| **literature-review scripts**                | 查找 download_paper.py + search_databases.py + verify_citations.py                       | 全部存在      | literature-review          |
| **alpha-research scripts**                   | 查找 arxiv_search.py                                                                     | 文件存在      | alpha-research             |

检测方法：遍历所有 `.aether/agent/*.md` 的 frontmatter `skill_refs`，解析每个 skill 名称，查找对应的 SKILL.md 文件路径。对 gpd-\* skills，额外检查 `references/` 和 `scripts/` 目录完整性。

### Layer 3: 运行时验证（Runtime Verification）

检测 MCP tool 调用和脚本执行是否返回合法结果。这是最重的一层，仅在 Layer 1-2 通过后执行。

| 检测项                                 | 检测方法                                                                                                                                             | 预期结果                                               | 影响的组件                 |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------- |
| **research-state MCP online**          | 调用 `get_state(project_dir)`                                                                                                                        | 返回含 `phase` 和 `schema_version` 的 dict             | 所有 Path 3 phases         |
| **research-state advance_plan**        | 调用 `advance_plan(phase="health_test", plan_number="0", project_dir)`                                                                               | 返回含 `previous` 和 `current` 的 dict                 | phase transition           |
| **research-conventions MCP online**    | 调用 `convention_lock_status(project_dir)`                                                                                                           | 返回含 `conventions` 和 `completeness_percent` 的 dict | gpd-verifier, gpd-reviewer |
| **research-conventions skill_resolve** | 调用 `skill_resolve_path(skill_name="gpd-conventions", project_dir)`                                                                                 | 返回 `found: true` + skill_dir 路径                    | subfield_defaults          |
| **SymPy 脚本 dry-run**                 | `uv run scripts/dimensional_check.py '{"expression":"1","context":{"domain":"health_test"},"conventions":{},"dimension_map":{"1":"dimensionless"}}'` | 返回含 `status`、`schema_version` 的 JSON              | gpd-verification           |
| **alpha-research arxiv_search**        | `uv run .aether/skills/alpha-research/arxiv_search.py "health test query" --max-papers 1`                                                            | 返回至少 1 条结果                                      | alpha-research no-login    |

**关键设计**：SymPy 脚本检测使用 dry-run（最小合法输入），不执行真实物理计算。只验证脚本能被 `uv run` 启动并返回符合 schema 的 JSON。

**advance_plan 检测的副作用处理**：检测调用 advance_plan 会修改 state.json。检测完成后必须调用 advance_plan 将状态回滚到检测前的 phase。具体流程：

```
1. get_state → 记录当前 phase 和 plan_number
2. advance_plan(phase="health_test", plan_number="0") → 验证可调用
3. advance_plan(phase=original_phase, plan_number=original_plan_number) → 回滚
```

### Layer 4: 持久化（Persistence）

检测文件结构可写性和 schema 合法性。最轻的一层。

| 检测项                            | 检测方法                                                 | 预期结果         | 影响的组件        |
| --------------------------------- | -------------------------------------------------------- | ---------------- | ----------------- |
| **persistence 目录可写**          | 尝试创建 `.aether/research/persistence/`                 | 目录存在或可创建 | 所有 Path 3       |
| **state.json 可读写**             | 写入 → 读取 → 验证 JSON 合法                             | 内容与写入一致   | 状态机            |
| **STATE.md 格式**                 | 检查 Current Phase 字段存在                              | 字段存在         | 会话恢复          |
| **convention_defaults.json 可读** | 读取 gpd-conventions/references/convention_defaults.json | JSON 合法且非空  | subfield_defaults |

---

## 4. MCP Health Tool 设计

### 4.1 扩展 research-state MCP 的 `run_health_check`

当前 `run_health_check` 只检查文件结构（state.json 存在、STATE.md 存在、ROADMAP.md 存在等）。扩展为 4 层分级检测。

#### Tool Schema

```python
@mcp.tool(annotations=READ_ONLY)
def run_health_check(
    project_dir: str,
    layers: list[str] | None = None,
    fix: bool = False,
) -> dict[str, Any]:
    """Full project health dashboard with 4-layer progressive detection.

    Layers:
    - infrastructure: uv, docker, alpha CLI, network reachability
    - skill_chain: SKILL.md existence, gpd references/scripts completeness
    - runtime: MCP tool calls, SymPy script dry-run, alpha search
    - persistence: directory writable, state.json valid, convention_defaults readable

    By default runs all layers. Pass layers=["infrastructure","skill_chain"]
    to run only specific layers. Runtime layer requires infrastructure layer
    to pass first.

    Returns per-layer status with issues and checks details.
    """
```

#### 返回格式

```json
{
  "healthy": true,
  "schema_version": 1,
  "layers": {
    "infrastructure": {
      "healthy": true,
      "checks": {
        "uv_available": { "status": "pass", "version": "0.4.20" },
        "uv_python_management": { "status": "pass", "versions": ["3.11", "3.12"] },
        "docker_available": { "status": "pass", "version": "24.0.7" },
        "docker_daemon": { "status": "pass", "running": true },
        "nvidia_gpu": { "status": "skip", "reason": "not required" },
        "alpha_cli": { "status": "pass", "authenticated": true },
        "network_reachable": { "status": "pass", "arxiv_api": 200 }
      },
      "issues": []
    },
    "skill_chain": {
      "healthy": true,
      "checks": {
        "research_worker_alpha_research": { "status": "pass", "path": ".../alpha-research/SKILL.md" },
        "gpd_verifier_5_skills": { "status": "pass", "count": 5 },
        "gpd_verification_9_scripts": { "status": "pass", "count": 9 },
        "gpd_verification_references": { "status": "pass", "count": 16 }
      },
      "issues": []
    },
    "runtime": {
      "healthy": true,
      "checks": {
        "research_state_mcp": { "status": "pass", "phase_returned": "exploration" },
        "research_conventions_mcp": { "status": "pass", "completeness_percent": 0.0 },
        "convention_skill_resolve": { "status": "pass", "found": true },
        "sympy_dry_run": { "status": "pass", "script": "dimensional_check.py" },
        "alpha_search": { "status": "pass", "results_count": 1 }
      },
      "issues": [],
      "advance_plan_rollback": { "rolled_back": true, "original_phase": "phase_analysis" }
    },
    "persistence": {
      "healthy": true,
      "checks": {
        "persistence_dir_writable": { "status": "pass" },
        "state_json_valid": { "status": "pass", "phase": "phase_analysis" },
        "convention_defaults_readable": { "status": "pass", "keys_count": 18 }
      },
      "issues": []
    }
  },
  "summary": {
    "total_checks": 28,
    "passed": 26,
    "failed": 0,
    "skipped": 2,
    "degradations": []
  },
  "project_dir": "/path/to/project"
}
```

#### 检测顺序约束

```
infrastructure → skill_chain → runtime → persistence
```

- infrastructure 是 skill_chain 的前提（需要 uv 可用才能查找 skill）
- skill_chain 是 runtime 的前提（需要 SKILL.md 存在才能 dry-run scripts）
- 如果前一层的 healthy=false，后续层自动 skip 并标记 `blocked_by: "<previous_layer>"`
- 用户可通过 `layers` 参数只运行指定层

### 4.2 MCP Cross-Health

research-state MCP 需检测 research-conventions MCP 是否在线。实现方式：

```python
async def _check_conventions_mcp_online(project_dir: Path) -> dict:
    try:
        result = convention_lock_status(project_dir=str(project_dir))
        if "error" in result:
            return {"status": "fail", "reason": result["error"]}
        return {"status": "pass", "completeness_percent": result.get("completeness_percent", 0)}
    except Exception as e:
        return {"status": "fail", "reason": str(e)}
```

由于 research-state MCP 和 research-conventions MCP 在同一 agent 进程中注册，research-state 可以通过 MCP client 调用 research-conventions 的 tool。如果两个 MCP 在不同进程中运行，则 agent 会作为 bridge——health tool 的调用链为：agent → research-state MCP `run_health_check` → agent 收到结果 → agent 调用 research-conventions MCP `convention_lock_status` → 将结果合并到 health response 中。

**实际实现选择**：由于 MCP tool 在同一进程中注册（通过 `mcp:` 配置在 agent frontmatter 中），research-state MCP 可以直接导入并调用 research-conventions MCP 的 tool 函数。但更安全的做法是在 health tool 中让 agent 层面执行 cross-MCP 检测——health tool 返回后，agent 补充调用 research-conventions MCP 的 tool，将结果写入 STATE.md 的 health section。

### 4.3 SymPy 脚本 Dry-Run 设计

选择 `dimensional_check.py` 作为 dry-run 代表脚本（它是 9 个脚本中最简单的一个，输入最小）：

```bash
uv run .aether/skills/plugins/gpd/gpd-verification/scripts/dimensional_check.py \
  '{"expression":"1","context":{"domain":"health_test"},"conventions":{},"dimension_map":{"1":"dimensionless"}}'
```

预期输出：

```json
{ "status": "pass", "computation": "dimensionless", "evidence": "...", "confidence": 1.0, "schema_version": 1 }
```

如果 dry-run 失败，标记所有 9 个 SymPy 脚本为 `degraded`（无法做确定性计算验证）。

---

## 5. Agent 启动自检协议

### 5.1 自检时机

research agent 在以下时机执行自检：

1. **会话启动时**：读取 STATE.md 后，如果无活跃项目（phase = "not yet started"），在 Entry Gate 前先调用 `run_health_check(layers=["infrastructure", "skill_chain"])`
2. **phase_execution 开始前**：在 dispatch 第一个 execution_cycle worker 之前，调用 `run_health_check(layers=["infrastructure", "skill_chain", "runtime"])`
3. **用户主动请求**：用户说 "检查环境" / "health check" 时，调用 `run_health_check(layers=None)`（全量检测）

### 5.2 自检流程

````
1. 调用 research-state MCP run_health_check(layers=["infrastructure", "skill_chain"])
2. 读取返回结果
3. 将结果摘要写入 .aether/research/persistence/STATE.md 的 Health section:
   ```markdown
   ## Health Status (auto-check at session start)
   infrastructure: pass / degraded [details]
   skill_chain: pass / degraded [details]
   degradations: [list of degraded items and impact]
````

4. 根据 degradations 决定：
   - 无降级 → 继续正常流程
   - alpha CLI 未认证 → 提示用户 `alpha login`，降级为 no-login mode
   - Docker 不可用 → 在 ENVIRONMENT.md 标记 docker 不可用，所有 docker 任务降级为 uv_venv
   - gpd skill 链断裂 → 提示用户检查 skills 目录，gpd-verification 降级为 research-verification only
   - uv 不可用 → 严重降级，提示用户安装 uv，无法执行任何 Python 计算

```

### 5.3 自检不阻塞

自检是非阻塞的——即使检测发现问题，agent 仍然启动并进入 Entry Gate。自检结果只是提供降级决策的依据。用户可以在任何时间手动调用 `run_health_check` 重新检测。

---

## 6. 降级策略

| 检测失败项               | 降级方案                                             | 降级范围                                  | 用户提示                               |
| ------------------------ | ---------------------------------------------------- | ----------------------------------------- | -------------------------------------- |
| uv 不可用                | 无 Python 计算能力，所有 SymPy 脚本不可用            | gpd-verification, local-executor, MCP scripts | "请安装 uv: curl -LsSf https://astral.sh/uv/install.sh | sh" |
| Docker 不可用            | sandbox-executor 不可用，所有 docker 任务降级为 uv_venv | sandbox-executor                        | "Docker 不可用，容器隔离任务将使用 uv venv" |
| NVIDIA GPU 不可用        | GPU 任务不可用，CPU-only 任务正常                    | sandbox-executor（GPU 任务）              | 无提示（可选依赖）                     |
| alpha CLI 未认证         | 论文搜索降级为 title+abstract only（no-login mode） | alpha-research skill                    | "运行 `alpha login` 可解锁全文阅读和 Q&A" |
| 网络不可达（arXiv API）  | 论文搜索不可用，只能依赖本地文件                     | alpha-research, literature-review       | "arXiv API 不可达，请检查网络"         |
| gpd skill 链断裂         | 物理验证降级为 research-verification only            | gpd-verifier, gpd-reviewer             | "gpd skills 不完整，物理计算验证不可用" |
| SymPy 脚本不可运行       | 计算验证降级为 LLM-only reasoning                    | gpd-verification scripts              | "SymPy 脚本无法运行，确定性验证不可用" |
| research-conventions MCP 离线 | 约定锁读写不可用，验证流程降级       | gpd-verifier, gpd-reviewer             | "research-conventions MCP 离线，请重启" |
| convention_defaults.json 缺失 | subfield_defaults 不可用，需手动指定约定 | gpd-conventions                       | "物理约定默认值文件缺失"              |

### 降级决策矩阵

```

infrastructure.pass AND skill_chain.pass → 全量能力
infrastructure.pass AND skill_chain.fail(gpd) → 通用研究可用，物理验证降级
infrastructure.fail(uv) AND skill_chain.pass → 无 Python 计算能力
infrastructure.fail(alpha_cli) → 论文搜索降级
infrastructure.fail(network) → 外部搜索不可用
infrastructure.fail(docker) → 容器隔离不可用，uv_venv 降级

````

---

## 7. 实现细节

### 7.1 research-state MCP 扩展

修改 `.aether/mcp/research-state/server.py`：

1. 保留现有 `run_health_check` 作为 Layer 4（persistence）检测
2. 新增 Layer 1-3 检测函数
3. 重构 `run_health_check` 参数签名，增加 `layers` 参数

新增检测函数：

```python
def _check_infrastructure(project_dir: Path) -> dict:
    checks = {}
    issues = []

    # uv
    result = subprocess.run(["uv", "--version"], capture_output=True, text=True, timeout=10)
    checks["uv_available"] = result.returncode == 0
    if result.returncode != 0:
        issues.append("uv not available")
    else:
        checks["uv_version"] = result.stdout.strip()

    # uv python management
    result = subprocess.run(["uv", "python", "list"], capture_output=True, text=True, timeout=10)
    checks["uv_python_management"] = result.returncode == 0
    if result.returncode == 0:
        checks["uv_python_versions"] = [line.strip() for line in result.stdout.strip().splitlines() if line.strip()]

    # docker
    result = subprocess.run(["docker", "version", "--format", "{{.Server.Version}}"],
                           capture_output=True, text=True, timeout=10)
    checks["docker_available"] = result.returncode == 0
    if result.returncode == 0:
        checks["docker_version"] = result.stdout.strip()
    else:
        issues.append("docker not available")

    # docker daemon
    result = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"],
                           capture_output=True, text=True, timeout=10)
    checks["docker_daemon_running"] = result.returncode == 0

    # alpha CLI (optional)
    result = subprocess.run(["alpha", "status"], capture_output=True, text=True, timeout=10)
    if result.returncode == 0:
        checks["alpha_cli_authenticated"] = "account" in result.stdout.lower() or "logged" in result.stdout.lower()
    else:
        checks["alpha_cli_available"] = False
        issues.append("alpha CLI not available")

    # network (arXiv API)
    result = subprocess.run(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
                            "https://api.arxiv.org"],
                           capture_output=True, text=True, timeout=15)
    checks["network_reachable"] = result.stdout.strip() == "200"

    return {"healthy": len(issues) == 0, "checks": checks, "issues": issues}


def _check_skill_chain(project_dir: Path) -> dict:
    checks = {}
    issues = []

    # Scan all agent frontmatter for skill_refs
    agent_dir = project_dir / ".aether" / "agent"
    if not agent_dir.exists():
        issues.append("agent directory missing")
        return {"healthy": False, "checks": checks, "issues": issues}

    skill_search_dirs = [
        project_dir / ".aether" / "skills",
        project_dir / ".opencode" / "skills",
    ]

    # For each agent, verify skill_refs exist
    for agent_md in sorted(agent_dir.glob("*.md")):
        content = agent_md.read_text()
        if not content.startswith("---"):
            continue
        end = content.find("---", 3)
        if end == -1:
            continue
        fm = yaml.safe_load(content[3:end])
        skill_refs = fm.get("skill_refs", [])
        for ref in skill_refs:
            found = False
            for base in skill_search_dirs:
                for skill_md in base.rglob("SKILL.md"):
                    sfm_content = skill_md.read_text()
                    if sfm_content.startswith("---"):
                        sfm_end = sfm_content.find("---", 3)
                        sfm = yaml.safe_load(sfm_content[3:sfm_end])
                        if sfm.get("name") == ref:
                            found = True
                            checks[f"{agent_md.stem}_{ref}"] = {
                                "status": "pass",
                                "path": str(skill_md)
                            }
                            break
                if found:
                    break
            if not found:
                checks[f"{agent_md.stem}_{ref}"] = {"status": "fail", "path": None}
                issues.append(f"skill '{ref}' referenced by '{agent_md.stem}' not found")

    # gpd-verification specific: scripts and references completeness
    gpd_verification_dir = _find_skill_dir("gpd-verification", project_dir)
    if gpd_verification_dir:
        scripts_dir = gpd_verification_dir / "scripts"
        expected_scripts = [
            "dimensional_check.py", "spot_check.py", "limiting_case_check.py",
            "conservation_check.py", "convergence_check.py", "ward_identity_check.py",
            "positivity_check.py", "kramers_kronig_check.py", "symmetry_check.py",
        ]
        found_scripts = [s for s in expected_scripts if (scripts_dir / s).exists()]
        checks["gpd_verification_scripts"] = {
            "expected": len(expected_scripts),
            "found": len(found_scripts),
            "missing": [s for s in expected_scripts if s not in found_scripts],
        }
        if len(found_scripts) < len(expected_scripts):
            issues.append(f"gpd-verification scripts incomplete: missing {expected_scripts - found_scripts}")

        refs_dir = gpd_verification_dir / "references"
        expected_refs = ["check_registry.json", "contract_checks.json"]
        domain_dir = refs_dir / "domain_checklists"
        if domain_dir.exists():
            expected_refs.extend([f.name for f in domain_dir.glob("*.json")])
        found_refs = [r for r in expected_refs if (refs_dir / r).exists() or (domain_dir / r).exists()]
        checks["gpd_verification_references"] = {
            "expected": len(expected_refs),
            "found": len(found_refs),
            "missing": [r for r in expected_refs if r not in found_refs],
        }

    return {"healthy": len(issues) == 0, "checks": checks, "issues": issues}
````

### 7.2 autoresearch SKILL.md 环境探测修改

将 Step 2 的探测从 `python3 --version` 改为 `uv --version` + `uv python list`：

```bash
# 原始（不合理）
python3 --version 2>/dev/null || echo "python: not available"

# 修改后（合理）
uv --version 2>/dev/null || echo "uv: not available"
uv python list 2>/dev/null || echo "uv python management: not available"
```

删除 `python3 --version` 行，保留 `docker --version`、`wolframscript --version`、`nvidia-smi`。

### 7.3 research.md 自检注入

在 research.md 的 Session Recovery section 中增加自检步骤：

```
On session start:
  1. (新增) Call run_health_check(layers=["infrastructure", "skill_chain"]) via research-state MCP
  2. (新增) Write health summary to STATE.md
  3. (新增) If degradations exist → inform user of degraded capabilities
  4. Read .aether/research/persistence/STATE.md, state.json, DIGESTS.md, and ENVIRONMENT.md
  5. (existing flow continues...)
```

### 7.4 文件改动清单

| 文件                                   | 改动内容                                       |
| -------------------------------------- | ---------------------------------------------- |
| `.aether/mcp/research-state/server.py` | 扩展 run_health_check，新增 Layer 1-3 检测函数 |
| `.aether/agent/research.md`            | Session Recovery 增加自检步骤                  |
| `.aether/skills/autoresearch/SKILL.md` | Step 2 环境探测改为 uv 优先，移除 python3      |
| `.aether/agent/local-executor.md`      | 无改动（已有 uv venv 流程）                    |

---

## 8. 验收清单

| #   | 验收项                                                         | 验收方法                                                 |
| --- | -------------------------------------------------------------- | -------------------------------------------------------- |
| 1   | `run_health_check(layers=["infrastructure"])` 返回 uv 版本     | 调用 MCP tool，检查返回含 uv_version                     |
| 2   | `run_health_check` 不检测 python3                              | 调用 MCP tool，返回中无 python3 相关字段                 |
| 3   | `run_health_check(layers=["skill_chain"])` 检测所有 skill_refs | 调用 MCP tool，每个 agent 的 skill_refs 都被检测         |
| 4   | gpd-verification 9 个脚本被完整性检测                          | 调用 MCP tool，返回 scripts count=9                      |
| 5   | `run_health_check(layers=["runtime"])` 包含 SymPy dry-run      | 调用 MCP tool，dimensional_check.py dry-run 返回 pass    |
| 6   | advance_plan 检测后自动回滚                                    | 检测前后 get_state 返回相同 phase                        |
| 7   | research.md Session Recovery 包含自检步骤                      | 读取 research.md，有 health check 步骤                   |
| 8   | autoresearch SKILL.md Step 2 不包含 python3                    | 读取 SKILL.md，无 `python3 --version`                    |
| 9   | 降级策略：uv 不可用时提示用户                                  | 模拟 uv 不可用环境，调用 health check，返回 degradations |
| 10  | 降级策略：Docker 不可用时标记 uv_venv 降级                     | 模拟 Docker 不可用环境，返回降级建议                     |
