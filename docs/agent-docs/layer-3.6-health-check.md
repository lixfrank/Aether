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
6. [降级策略](#6-降级策略)（含 6.5 自动安装协议）
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

| #   | 决策                                                                                                                                | 原因                                                                                                                                                                                                                                                                       | 替代方案                                                                                                                                         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | 4 层分级检测（基础设施 → 持久化 → Skill 引用链 → 运行时）                                                                           | 持久化问题快速致命（state.json 损坏即全盘不可用），应优先检测；运行时最重放最后                                                                                                                                                                                            | 原顺序 infra→skill→runtime→persistence                                                                                                           |
| D2  | Health tool 放在 research-state MCP 中                                                                                              | research-state MCP 已有 `run_health_check`，扩展它而非新建 MCP                                                                                                                                                                                                             | 新建独立 health MCP                                                                                                                              |
| D3  | 不检测 host python3，检测 uv 可用性                                                                                                 | 系统中无组件使用 host python3，所有 Python 执行走 uv                                                                                                                                                                                                                       | 同时检测 python3 和 uv                                                                                                                           |
| D4  | SymPy 脚本检测对所有 9 个脚本做 dry-run                                                                                             | 各脚本依赖路径不同（ward_identity 需要 SymPy tensor），单脚本通过不代表全通过                                                                                                                                                                                              | 仅测试 dimensional_check.py                                                                                                                      |
| D5  | MCP cross-health 由 agent 仲裁（非 MCP 直接互调）                                                                                   | MCP 协议是 agent→MCP 单向调用；MCP 间直接导入违反进程隔离，拆分进程后调用链断裂                                                                                                                                                                                            | MCP server 直接导入 / MCP 间互调                                                                                                                 |
| D6  | Agent 启动时自检（非强制阻塞）                                                                                                      | 自检结果写入全局+项目级位置，agent 可读后决定是否降级或继续，但不阻塞用户立即使用                                                                                                                                                                                          | 自检失败则拒绝启动                                                                                                                               |
| D7  | Layer 1 检测 git 可用性和工作区上下文                                                                                               | 3.7 State Recovery 的 Phase Commit 和 rollback 依赖 git；非 git 仓库中 rollback 不可用                                                                                                                                                                                     | 仅在 3.7 运行时检测 git                                                                                                                          |
| D8  | 检测失败后的自动安装由单一 env-setup skill + install_registry 驱动                                                                  | 大部分缺失项可一行命令安装，无需每项一个 skill；registry 数据结构便于分类（auto vs manual）与扩展                                                                                                                                                                          | 每软件一个 skill / 脚本直接安装                                                                                                                  |
| D9  | 全局检测结果存储在用户级目录（`~/.aether/health/`）                                                                                 | uv/git/docker 可用性是用户级属性，不随项目变化；项目级 STATE.md 仅写入各层 pass/fail/degraded 状态，不写入具体细节，细节由全局文件承载                                                                                                                                     | 全部细节存项目 STATE.md                                                                                                                          |
| D10 | Tier 0 LLM bootstrap：MCP 不可用时 agent 直接 bash 检测 uv                                                                          | MCP server 是 Python 进程，uv 不可用时 MCP 无法启动；需 LLM 层先检测并修复 uv 才能进入 MCP 层                                                                                                                                                                              | 无 fallback，uv 不可用即报错退出                                                                                                                 |
| D11 | 自动安装逐项授权，不批量一次性授权                                                                                                  | 用户可能只想安装 uv（必须）但不想安装 Docker（可选）；批量授权迫使用户二选一全量或全拒                                                                                                                                                                                     | 批量一次性授权                                                                                                                                   |
| D12 | 不检测 NVIDIA GPU（aether 本身不依赖 GPU）                                                                                          | health check 是全局级检测；GPU 是项目级可选需求，应由项目 ENVIRONMENT.md 或 PLAN.md 声明                                                                                                                                                                                   | 在 Layer 1 检测 GPU                                                                                                                              |
| D13 | 网络检测结果写入 `~/.aether/health/network_status.md`供 agent 阅读                                                                  | 避免 agent 在网络不可用时重复试错搜索；agent 读该文件后可直接跳过外部搜索或降级                                                                                                                                                                                            | 仅在 health check 返回值中体现                                                                                                                   |
| D14 | advance_plan rollback 失败时直接写回 state.json 原文作为 fallback                                                                   | rollback 函数本身可能出错，此时 state.json 残留非法 phase "health_test"，下次会话状态机无法解析                                                                                                                                                                            | 无 fallback，依赖 rollback 成功                                                                                                                  |
| D15 | STATE.md Next Action 仅在 degradation 场景更新，其他场景保持原 workflow 不变                                                        | health check 是辅助操作，不应改变 workflow 进度；仅在发现阻塞时将 Next Action 切换为 degradation 概要 + 指向 global_health.json，解除后恢复原值                                                                                                                            | 每次检测都更新 Next Action                                                                                                                       |
| D16 | health_check 作为 research-worker 的一个执行模式，而非 primary agent 直接实施                                                       | 与 Path 3 coordinator/worker/skill 三层链路一致；primary agent 只做 Tier 0 (bash) + Tier 0.5 (权限预获取) + digest 处理 + 临时文件迁移 + env-setup 用户交互，检测逻辑由 worker 执行并返回结构化 digest                                                                     | primary agent 直接调用 MCP + bash 执行全部检测                                                                                                   |
| D17 | 全局检测结果采用两阶段写入：worker 写临时文件到项目 .aether/research/ → coordinator 迁移至 ~/.aether/health/                        | worker file_scope 限制为 .aether/research/\*\*，无权写入 ~/.aether/health/；coordinator 无 file_scope 限制且负责全局状态管理。两阶段写入避免修改权限系统或绕过 file_scope                                                                                                  | worker 直接写 ~/.aether/health/（违反 file_scope）/ task tool 传 file_scope（path.relative 导致 pattern 无法匹配）/ worker bash 绕过（开坏先例） |
| D18 | coordinator 在 Tier 0 阶段预创建 ~/.aether/health/ 空占位文件，一次性获取用户写权限；cache_check.sh 由 seedDefaultAssets() 统一管理 | coordinator 写入项目外路径时触发 permission ask；若在 health check 完成后再写入，会打断用户当前任务。预创建在会话最早期完成权限申请，后续覆写同路径不再询问。cache_check.sh 是不变脚本，由 seedDefaultAssets() 从 .aether/health/ 同步，与 agent/mcp/skills 同生命周期管理 | 不预创建，每次写入实时申请权限 / coordinator 动态创建 cache_check.sh                                                                             |

---

## 3. 分层检测架构

检测顺序：**基础设施 → 持久化 → Skill 引用链 → 运行时**。持久化问题（state.json 损坏）快速致命，优先检测；运行时最重，放最后。

### Layer 1: 基础设施（Infrastructure）

检测运行环境的基本可用性。这些是所有后续层的前提。结果存储在全局位置（`~/.aether/health/`），不随项目变化。

| 检测项                           | 检测方法                                                     | 预期结果                | 影响的组件                                     | 失败分类                          |
| -------------------------------- | ------------------------------------------------------------ | ----------------------- | ---------------------------------------------- | --------------------------------- |
| **uv 可用**                      | `uv --version`                                               | 返回版本号，exit code 0 | local-executor, 所有 SymPy 脚本, MCP servers   | not_installed                     |
| **uv Python 管理**               | `uv python list`                                             | 列出可用 Python 版本    | local-executor, gpd-verification scripts       | not_configured                    |
| **git 可用**                     | `git --version`                                              | 返回版本号，exit code 0 | Phase Commit Protocol, State Recovery rollback | not_installed                     |
| **git 工作区**                   | `git rev-parse --git-dir`                                    | 返回 .git 路径          | Phase Commit Protocol (需 repo context)        | not_initialized                   |
| **Docker CLI**                   | `docker version --format '{{.Client.Version}}'`              | 返回客户端版本号        | Docker 可用性判断                              | not_installed                     |
| **Docker daemon**                | `docker info --format '{{.ServerVersion}}'`                  | daemon 在运行           | sandbox-executor                               | daemon_not_running                |
| **alpha CLI**                    | `alpha status`                                               | 返回认证状态            | alpha-research skill（CLI mode）               | not_installed / not_authenticated |
| **网络可达（arXiv）**            | 见下方 fallback 方案，检测 `https://api.arxiv.org`           | HTTP 200                | alpha-research no-login mode, webfetch         | unreachable                       |
| **网络可达（Semantic Scholar）** | 见下方 fallback 方案，检测 `https://api.semanticscholar.org` | HTTP 200                | literature-review, research-worker             | unreachable                       |
| **网络可达（INSPIRE-HEP）**      | 见下方 fallback 方案，检测 `https://inspirehep.net/api`      | HTTP 200                | physics 文献搜索                               | unreachable                       |

**关键设计**：

- 不检测 `python3 --version`。uv 可以独立管理 Python 版本（`uv python install`），host python3 不是依赖。
- 不检测 NVIDIA GPU。aether 本身不依赖 GPU 运行；GPU 是项目级可选需求，由 ENVIRONMENT.md 或 PLAN.md 声明。
- Docker 检测分为 **CLI 可用** 和 **daemon 运行** 两个独立项，失败分类不同（前者是"未安装"，后者是"未启动"），降级提示也不同。

#### 网络检测 fallback 方案

网络检测不依赖单一工具（curl），按优先级尝试多种方式：

```python
def _check_network(url: str) -> dict:
    methods = [
        ("curl",  ["curl", "-sL", "-o", "/dev/null", "-w", "%{http_code}", url]),
        ("wget",  ["wget", "-q", "-O", "/dev/null", "--timeout=5", url]),
        ("python", ["python3", "-c", f"import urllib.request; r=urllib.request.urlopen('{url}',timeout=5); print(r.status)"]),
    ]
    for name, cmd in methods:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode == 0:
            code = result.stdout.strip()
            if code.startswith("2"):
                return {"status": "pass", "method": name, "url": url, "http_code": int(code)}
            if code == "429":
                return {"status": "degraded", "method": name, "url": url, "http_code": 429,
                        "note": "rate limited, endpoint reachable but throttled"}
    return {"status": "fail", "url": url, "attempts": [m[0] for m in methods]}
```

关键改进：

- curl 加 `-L` 跟随重定向（原 `-s` 不跟随 301/302，导致误判为不可达）
- 2xx 均视为 pass（部分 API 返回 204 No Content）
- 429 单独标记为 `degraded`（API 可达但限流），不与 `fail`（不可达）混淆
- 3xx/5xx 仍视为 fail

#### 网络状态持久化

网络检测结果写入 `~/.aether/health/network_status.md`，供 research agent 和 research-worker agent 在执行搜索前阅读，避免重复试错：

```markdown
# Network Status (updated: 2024-01-15T10:30:00Z)

## Reachable

- arXiv API: OK (curl, 200)
- Semantic Scholar: OK (curl, 200)

## Unreachable

- INSPIRE-HEP: FAIL (curl/wget/python all failed) → physics 文献搜索不可用

## Recommendations

- arXiv/Semantic Scholar 可用 → 论文搜索正常
- INSPIRE-HEP 不可用 → physics 领域文献搜索降级为 arXiv only
```

agent 读取该文件后，直接跳过不可达的 API，无需在搜索时反复尝试失败的 endpoint。

### Layer 2: 持久化（Persistence）

检测文件结构可写性和 schema 合法性。最轻的一层，但问题致命（state.json 损坏导致全盘不可用），因此排在 skill_chain 之前。结果存储在项目级位置。

| 检测项                            | 检测方法                                                                         | 预期结果         | 影响的组件        |
| --------------------------------- | -------------------------------------------------------------------------------- | ---------------- | ----------------- |
| **persistence 目录可写**          | 尝试创建 `.aether/research/persistence/`                                         | 目录存在或可创建 | 所有 Path 3       |
| **state.json 可读写**             | 写入 → 读取 → 验证 JSON 合法                                                     | 内容与写入一致   | 状态机            |
| **STATE.md 最小格式**             | 检查 `## Current Phase` heading 存在（STATE.md 恢复依赖此 heading 定位当前状态） | heading 存在     | 会话恢复          |
| **convention_defaults.json 可读** | 读取 gpd-conventions/references/convention_defaults.json                         | JSON 合法且非空  | subfield_defaults |

### Layer 3: Skill 引用链（Skill Reference Chain）

检测每个 agent 的 `skill_refs` 指向的 SKILL.md 是否存在，以及 gpd plugin 的 references JSON 和 scripts 是否完整。结果存储在项目级位置。

| 检测项                                       | 检测方法                                                                                                 | 预期结果       | 影响的组件                 |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------- | -------------------------- |
| **research-worker: alpha-research**          | 查找 `.aether/skills/alpha-research/SKILL.md`                                                            | 文件存在       | research-worker            |
| **sandbox-executor: docker**                 | 查找 `.aether/skills/docker/SKILL.md`                                                                    | 文件存在       | sandbox-executor           |
| **research-verifier: research-verification** | 查找 `.aether/skills/research-verification/SKILL.md`                                                     | 文件存在       | research-verifier          |
| **gpd-verifier: 5 个 skill_refs**            | 查找每个 gpd-\* skill 的 SKILL.md                                                                        | 全部 5 个存在  | gpd-verifier               |
| **gpd-reviewer: 3 个 skill_refs**            | 查找每个 gpd-\* skill 的 SKILL.md                                                                        | 全部 3 个存在  | gpd-reviewer               |
| **gpd-verification scripts**                 | 查找 `scripts/` 下 9 个 .py 文件                                                                         | 全部 9 个存在  | gpd-verifier               |
| **gpd-verification references**              | 查找 `references/check_registry.json` + `contract_checks.json` + 14 个 domain_checklists（共 16 个文件） | 全部 16 个存在 | gpd-verifier               |
| **gpd-errors references**                    | 查找 error_catalog.json + traceability_matrix.json + detection_strategies.json                           | 全部存在       | gpd-reviewer, gpd-verifier |
| **gpd-conventions references**               | 查找 convention_defaults.json + subfield_defaults/physics.json                                           | 全部存在       | gpd-conventions MCP        |
| **gpd-domain-check references**              | 查找 4 个 protocols + 14 个 bundles                                                                      | 全部存在       | gpd-reviewer, gpd-verifier |
| **literature-review scripts**                | 查找 download_paper.py + search_databases.py + verify_citations.py + generate_pdf.py                     | 全部 4 个存在  | literature-review          |
| **alpha-research scripts**                   | 查找 arxiv_search.py                                                                                     | 文件存在       | alpha-research             |

检测方法：遍历所有 `.aether/agent/*.md` 的 frontmatter `skill_refs`，解析每个 skill 名称，查找对应的 SKILL.md 文件路径。对 gpd-\* skills，额外检查 `references/` 和 `scripts/` 目录完整性。

### Layer 4: 运行时验证（Runtime Verification）

检测 MCP tool 调用和脚本执行是否返回合法结果。这是最重的一层，仅在 Layer 1-3 通过后执行。

| 检测项                                 | 检测方法                                                                                  | 预期结果                                               | 影响的组件                 | 执行方            |
| -------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------- | ----------------- |
| **research-state MCP online**          | 调用 `get_state(project_dir)`                                                             | 返回含 `phase` 和 `schema_version` 的 dict             | 所有 Path 3 phases         | worker (via MCP)  |
| **research-state advance_plan**        | 调用 `advance_plan(phase="health_test", plan_number="0", project_dir)`                    | 返回含 `previous` 和 `current` 的 dict                 | phase transition           | worker (via MCP)  |
| **9 个 SymPy 脚本 dry-run**            | 对每个脚本分别传入最小合法 JSON 输入，验证返回含 `status` 和 `schema_version` 的 JSON     | 9 个全部返回 pass                                      | gpd-verification           | worker (via MCP)  |
| **alpha-research arxiv_search**        | `uv run .aether/skills/alpha-research/arxiv_search.py "health test query" --max-papers 1` | 返回至少 1 条结果                                      | alpha-research no-login    | worker (via bash) |
| **research-conventions MCP online**    | 调用 `convention_lock_status(project_dir)`                                                | 返回含 `conventions` 和 `completeness_percent` 的 dict | gpd-verifier, gpd-reviewer | worker 仲裁       |
| **research-conventions skill_resolve** | 调用 `skill_resolve_path(skill_name="gpd-conventions", project_dir)`                      | 返回 `found: true` + skill_dir 路径                    | subfield_defaults          | worker 仲裁       |

**关键设计**：

1. **所有 9 个 SymPy 脚本均需 dry-run**：各脚本依赖路径不同（dimensional_check 最简单，ward_identity 需要 SymPy tensor 操作，convergence_check 需要 numpy 数值计算），单脚本通过不代表全部通过。dry-run 输入为每个脚本的最小合法 JSON（见 §4.3）。

2. **MCP cross-health 由 worker 仲裁**（D5 + D16）：research-conventions MCP 的检测项标记为"worker 仲裁"，不在 MCP tool 内直接调用。worker 先调用 research-state MCP 的 `run_health_check`，获得 infrastructure + persistence + skill_chain + self_runtime 结果，然后 worker 自行调用 research-conventions MCP 的 `convention_lock_status` 和 `skill_resolve_path`，将结果合并到最终 health status，写入全局 health 文件并返回 digest。coordinator 基于 digest 更新 STATE.md。详见 §4.2。

3. **advance_plan 检测的副作用处理**：检测调用 advance_plan 会修改 state.json。采用双保险回滚 + 崩溃恢复机制：

```
1. get_state → 记录当前 phase 和 plan_number，并备份 state.json 原文内容
2. 将 state.json 原文内容备份至 state.json.health_backup（崩溃恢复用）
3. advance_plan(phase="health_test", plan_number="0") → 验证可调用
4. advance_plan(phase=original_phase, plan_number=original_plan_number) → 尝试回滚
5. 若第 4 步失败 → 直接将 state.json 原文内容写回文件（绕过 advance_plan 函数）
6. 无论回滚是否成功 → 删除 state.json.health_backup
```

**崩溃恢复**：若进程在步骤 3-5 之间崩溃，state.json 将残留非法 phase "health_test"。恢复机制：

- 每次会话启动时（Session Recovery），状态机检查 state.json 的 phase 值是否在合法 phase 列表中
- 若 phase 为 "health_test"（非法），检查是否存在 state.json.health_backup：
  - 存在 → 用 health_backup 内容恢复 state.json，删除 health_backup
  - 不存在 → 无法恢复，重置为默认状态（phase=exploration, plan_number=0），并在 STATE.md 写入警告

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
) -> dict[str, Any]:
    """Full project health dashboard with 4-layer progressive detection.

    Layers:
    - infrastructure: uv, docker, alpha CLI, network reachability (3 endpoints)
    - persistence: directory writable, state.json valid, convention_defaults readable
    - skill_chain: SKILL.md existence, gpd references/scripts completeness
    - runtime: MCP tool calls, all 9 SymPy scripts dry-run, alpha search

    NOTE: Cross-MCP checks (research-conventions) are NOT included in
    this tool's output. The agent must call research-conventions MCP
    separately and merge results (see §4.2).

    By default runs all layers. Pass layers=["infrastructure","persistence"]
    to run only specific layers. Runtime layer requires all previous
    layers to pass first.

    Returns per-layer status with issues and checks details.

    NOTE: This tool is READ_ONLY. Auto-install of missing items is handled
    by the env-setup skill (see §6.5), which requires per-item user authorization.
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
        "git_available": { "status": "pass", "version": "2.43.0" },
        "git_working_dir": { "status": "pass", "git_dir": ".git" },
        "docker_cli": { "status": "pass", "client_version": "24.0.7" },
        "docker_daemon": { "status": "pass", "server_version": "24.0.7", "running": true },
        "alpha_cli": { "status": "pass", "authenticated": true },
        "network_arxiv": { "status": "pass", "method": "curl", "http_code": 200 },
        "network_semantic_scholar": { "status": "pass", "method": "curl", "http_code": 200 },
        "network_inspire_hep": { "status": "pass", "method": "curl", "http_code": 200 }
      },
      "issues": []
    },
    "persistence": {
      "healthy": true,
      "checks": {
        "persistence_dir_writable": { "status": "pass" },
        "state_json_valid": { "status": "pass", "phase": "phase_analysis" },
        "convention_defaults_readable": { "status": "pass", "keys_count": 18 }
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
        "advance_plan_test": { "status": "pass", "rollback": "success" },
        "sympy_dry_run": {
          "dimensional_check": { "status": "pass" },
          "spot_check": { "status": "pass" },
          "limiting_case_check": { "status": "pass" },
          "conservation_check": { "status": "pass" },
          "convergence_check": { "status": "pass" },
          "ward_identity_check": { "status": "pass" },
          "positivity_check": { "status": "pass" },
          "kramers_kronig_check": { "status": "pass" },
          "symmetry_check": { "status": "pass" }
        },
        "alpha_search": { "status": "pass", "results_count": 1 }
      },
      "issues": [],
      "cross_mcp_pending": ["research_conventions_mcp_online", "convention_skill_resolve"]
    }
  },
  "summary": {
    "total_checks": 24,
    "passed": 22,
    "failed": 0,
    "degradations": [],
    "cross_mcp_pending_count": 2
  },
  "project_dir": "/path/to/project"
}
```

**注意**：返回格式中 `nvidia_gpu` 已移除（D12），Docker 拆分为 `docker_cli` 和 `docker_daemon`（D4），网络检测扩展为 3 个 endpoint（D13），SymPy dry-run 扩展为 9 个脚本（D4），新增 `cross_mcp_pending` 字段标识需 agent 仲裁补充的检测项。

#### 检测顺序约束

```
infrastructure → persistence → skill_chain → runtime
```

- infrastructure 是 persistence 的前提（需要 uv 来执行 Python 检测脚本）
- persistence 是 skill_chain 的前提（需要 state.json 可读写才能解析 skill_refs）
- skill_chain 是 runtime 的前提（需要 SKILL.md 存在才能 dry-run scripts）
- 如果前一层的 healthy=false，后续层自动 skip 并标记 `blocked_by: "<previous_layer>"`
- 用户可通过 `layers` 参数只运行指定层

### 4.2 MCP Cross-Health：Agent 仲裁协议

**设计决策（D5）**：MCP cross-health 由 agent 仲裁，而非 MCP server 直接互调。

**原因**：MCP 协议是 agent→MCP 单向调用。MCP server 间直接导入违反进程隔离原则——如果两个 MCP 未来拆分到不同进程，直接导入的调用链会断裂，且用户升级后不会收到任何迁移提示。

**仲裁协议**：

`run_health_check` 返回值中包含 `cross_mcp_pending` 字段，列出需要仲裁补充的检测项。仲裁由 research-worker 执行（而非 coordinator），worker 按以下流程补充：

```
1. worker 调用 research-state MCP run_health_check → 获得 infrastructure + persistence + skill_chain + runtime_self
2. worker 读取 cross_mcp_pending 列表
3. 对每个 pending 项，worker 自行调用对应 MCP tool：
   - "research_conventions_mcp_online" → worker 调用 research-conventions MCP convention_lock_status(project_dir)
   - "convention_skill_resolve" → worker 调用 research-conventions MCP skill_resolve_path(skill_name="gpd-conventions", project_dir)
4. worker 将 cross_mcp 结果合并到最终 health status
5. worker 将完整 health status 写入项目内临时文件（.aether/research/.health_global.json 等，D17）；digest 中包含 degradation_summary + 临时文件路径
6. coordinator 从临时文件迁移至 ~/.aether/health/（D17），然后基于 digest 更新 STATE.md Health Status section
```

**优势**：

- MCP server 保持独立，无需互相导入
- 未来 MCP 拆分到不同进程时无需修改代码
- Worker 是天然的中介层，可以处理 MCP 调用失败、超时等异常（与 Path 3 其他 phase 中 worker 的角色一致）
- 新增 MCP 只需在 `cross_mcp_pending` 中声明检测项，worker 按协议执行
- Coordinator 不需要执行检测逻辑，保持其 coordinator-only 的职责边界

### 4.3 SymPy 脚本 Dry-Run 设计

对所有 9 个脚本分别做 dry-run（D4），每个脚本使用其最小合法输入：

| 脚本                 | dry-run 输入（最小合法 JSON）                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| dimensional_check    | `{"expression":"1","context":{"domain":"health_test"},"conventions":{},"dimension_map":{"1":"dimensionless"}}` |
| spot_check           | `{"expression":"1","context":{"domain":"health_test"},"spot_check_type":"unit_consistency","conventions":{}}`  |
| limiting_case_check  | `{"expression":"1","limit_value":"1","variable":"x","conventions":{},"context":{"domain":"health_test"}}`      |
| conservation_check   | `{"expression":"1","conserved_quantity":"energy","conventions":{},"context":{"domain":"health_test"}}`         |
| convergence_check    | `{"expression":"1","n_terms":"3","conventions":{},"context":{"domain":"health_test"}}`                         |
| ward_identity_check  | `{"expression":"1","identities_to_check":["unit"],"conventions":{},"context":{"domain":"health_test"}}`        |
| positivity_check     | `{"expression":"1","conventions":{},"context":{"domain":"health_test"}}`                                       |
| kramers_kronig_check | `{"expression":"1","conventions":{},"context":{"domain":"health_test"}}`                                       |
| symmetry_check       | `{"expression":"1","symmetry_type":"parity","conventions":{},"context":{"domain":"health_test"}}`              |

每个脚本 dry-run 预期返回 `{"status": "pass", "schema_version": 1, ...}`。

**执行策略**：9 个脚本按顺序执行（非并行）。首个脚本 timeout 60s（`uv run` 冷启动需下载 sympy 及依赖），后续脚本 timeout 10s（依赖已缓存）。总 timeout 最多 60 + 8×10 = 140s。如果某脚本 dry-run 失败，仅标记该脚本为 degraded，其他脚本继续检测。只有当所有 9 个脚本全部 pass 时，`sympy_dry_run` 整体才标记为 pass；任何脚本 fail 则标记为 degraded 并在 `issues` 中列出具体失败的脚本。

---

## 5. Agent 启动自检协议

### 5.1 检测层级

health check 分为三个层级，从最轻到最重：

| 层级         | 执行方                | 检测内容                                   | 时机                                           | 结果存储                                                                |
| ------------ | --------------------- | ------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------- |
| **Tier 0**   | coordinator 直接 bash | uv 可用性 + 全局目录预创建                 | 会话启动最早期，MCP 之前                       | `~/.aether/health/global_health.json`（coordinator 预创建占位 + 迁移）  |
| **Tier 1-3** | research-worker       | infrastructure + persistence + skill_chain | Tier 0 通过后，coordinator dispatch worker     | 项目内临时文件 → coordinator 迁移至 `~/.aether/health/` + 项目 STATE.md |
| **Tier 4**   | research-worker       | runtime + cross_mcp                        | 用户请求（"检查环境"）或用户补充环境后重新检测 | 同 Tier 1-3（临时文件 → 迁移）+ 项目 STATE.md                           |

### 5.2 Tier 0: LLM Bootstrap 检测（Coordinator 侧）

MCP server 是 Python 进程。如果 uv 不可用，MCP server 无法启动，`run_health_check` tool 无法被调用。因此，coordinator 必须在调用任何 MCP tool 之前，先通过 bash 直接检测 uv 可用性。这是唯一由 coordinator 直接执行的检测步骤（D16），因为 MCP 不可用时 worker 无法 dispatch。

**流程**：

```
1. 会话启动 → coordinator 执行 bash: uv --version
2. 如果 uv 可用 → 检查缓存有效性：
   a. bash: bash ~/.aether/health/cache_check.sh
      （cache_check.sh 由 `seedDefaultAssets()` 从 `.aether/health/` 在 CLI 启动时同步到 `~/.aether/health/`）
   b. exit 0（缓存有效）→ 读取 ~/.aether/health/global_health.json 缓存，跳过 Tier 1-4 检测
   c. exit 1（缓存过期或缺失）→ 预创建全局健康目录（D18）：
      i.  bash: mkdir -p ~/.aether/health
      ii. write tool: 写入空占位文件 ~/.aether/health/global_health.json（内容为 {}）
      iii. write tool: 写入空占位文件 ~/.aether/health/network_status.md（内容为空）
      → 此步骤触发对 ~/.aether/health/ 的写权限申请，用户仅在此处授权一次
      → 后续 coordinator 覆写同路径文件时不再询问
      iv. dispatch research-worker(mode=health_check)
3. 如果 uv 不可用 → 进入 LLM-only bootstrap 模式：
   a. 告知用户："uv 不可用，MCP 工具无法启动。uv 是所有 Python 计算的基础依赖。"
   b. 加载 env-setup skill，询问用户是否自动安装 uv（逐项授权，此处只有一项）
   c. 用户同意 → coordinator 执行安装命令（curl -LsSf https://astral.sh/uv/install.sh | sh）
   d. 安装后 → coordinator 重新 bash 检测 uv --version
   e. uv 检测通过 → 提示用户可能需要重启 shell（PATH 未刷新）
      - 若 uv 命令仍不可用 → 建议用户 source ~/.bashrc 或重新开终端
   f. uv 最终可用 → 执行步骤 2（缓存检查 + 预创建 + dispatch worker）
   g. 用户拒绝安装 → coordinator 在 LLM-only 模式下继续（无 MCP、无 Python 计算）
```

**LLM-only 模式下的 coordinator 行为**：

- 不调用任何 MCP tool
- 不 dispatch research-worker（worker 依赖 MCP）
- 不执行任何 Python 脚本
- 不使用 SymPy 验证、alpha 搜索、Docker 容器
- 仅使用 LLM reasoning、bash 基础命令（git、curl）、本地文件读写
- 在 STATE.md 标记 `infrastructure: degraded`，详情见 `~/.aether/health/global_health.json`

### 5.3 Tier 1-4: Worker-Based Health Check

Tier 0 通过后，coordinator 不直接调用 MCP tool 执行检测。而是 dispatch research-worker（health_check 模式）执行 Tier 1-4 检测，worker 返回 `PhaseResultDigest`，coordinator 像处理其他 phase digest一样处理 health_check digest（D16）。

**架构分层**：

```
coordinator (research.md):
  Tier 0: bash uv --version → LLM bootstrap if fail
  Tier 0.5: bash cache_check.sh → if cache valid → skip health check
            if cache expired → 预创建 ~/.aether/health/ 空占位文件（一次性权限申请，D18）
  Tier 1-4: dispatch research-worker(mode=health_check) → 等待 digest
  收到 digest → 处理 degradation / env-setup 交互 / 更新 STATE.md
               → 迁移临时文件至 ~/.aether/health/（D17）

research-worker (health_check 模式):
  Tier 1-3: 调用 run_health_check MCP → infrastructure + persistence + skill_chain
  Tier 4:   调用 run_health_check MCP (runtime) + 仲裁 cross-MCP
  写入项目内临时文件 .aether/research/.health_global.json + .health_network.md
  返回 PhaseResultDigest{phase: health_check, status: pass/degraded/failed, output_paths: [临时文件路径]}
```

**自检时机**：

1. **会话启动时**：Tier 0 通过后，coordinator dispatch worker (mode=health_check, layers=["infrastructure", "persistence", "skill_chain"])
2. **用户主动请求**：用户说 "检查环境" / "health check" 时，coordinator dispatch worker (mode=health_check, layers=None)（全量检测）
3. **用户补充环境后重新检测**：用户说 "我已补充环境" / "我安装了缺失的 xxx" 时，coordinator dispatch worker (mode=health_check, layers=None)（全量检测），验证缺失项是否已修复

### 5.4 结果存储：全局 + 项目级分层

检测结果分为两类，存储在不同位置：

**全局检测结果**（不随项目变化）：

存储位置：`~/.aether/health/global_health.json`

```json
{
  "schema_version": 1,
  "updated_at": "2024-01-15T10:30:00Z",
  "infrastructure": {
    "uv_available": { "status": "pass", "version": "0.4.20" },
    "docker_cli": { "status": "pass", "client_version": "24.0.7" },
    "docker_daemon": { "status": "pass", "server_version": "24.0.7" },
    "git_available": { "status": "pass", "version": "2.43.0" },
    "alpha_cli": { "status": "pass", "authenticated": true }
  },
  "network": {
    "arxiv": { "status": "pass", "method": "curl", "http_code": 200 },
    "semantic_scholar": { "status": "pass", "method": "curl", "http_code": 200 },
    "inspire_hep": { "status": "fail", "method": null }
  }
}
```

- `expires_at` 字段已移除。缓存有效期通过文件 mtime（最后修改时间）判断，无需 LLM 计算时间差。coordinator 在 Tier 0 阶段通过固定脚本 `~/.aether/health/cache_check.sh` 判断缓存是否过期（mtime 距当前时间 > 24h 则过期），避免 LLM 做时间运算。
- 用户手动请求 health check、env-setup 安装后，coordinator 写入新结果，文件 mtime 自动更新，缓存自动续期。
- 新项目切换时，如果全局检测结果未过期，直接使用缓存，无需重新检测 uv/git/docker。

**项目级检测结果**（依赖项目目录结构）：

存储位置：项目的 `.aether/research/persistence/STATE.md` Health section

STATE.md 由 **coordinator** 基于 worker digest 写入，仅记录各层的 pass/fail/degraded 状态，不记录具体检测项细节。具体细节由以下全局文件承载（由 worker 写入项目内临时文件，coordinator 迁移至全局位置，D17）：

- infrastructure + network 详情 → `~/.aether/health/global_health.json`（coordinator 从 `.aether/research/.health_global.json` 迁移）
- 网络可达性详情 → `~/.aether/health/network_status.md`（coordinator 从 `.aether/research/.health_network.md` 迁移）
- skill_chain / runtime 各检测项详情 → `run_health_check` 返回值（worker digest 中包含 summary，coordinator 按需重新调用）

STATE.md 格式示例：

```markdown
## Health Status (project-level, updated: 2024-01-15T10:30:00Z)

persistence: pass
skill_chain: pass
runtime: degraded
cross_mcp: pass

→ infrastructure + network 详情：`~/.aether/health/global_health.json`
→ 网络可达性详情：`~/.aether/health/network_status.md`
→ 各层检测项详情：`run_health_check` 返回值
```

- 项目级检测结果每次切换项目时重新检测（不同项目有不同的 skills、state.json）。
- 全局检测结果可直接从 `~/.aether/health/global_health.json` 读取缓存。

### 5.4.1 STATE.md Next Action 更新规则

**核心原则**：health check 仅在发现 degradation 时更新 STATE.md 的 Next Action 字段；其他场景保持原有 workflow 的 Next Action 不变。

| 场景                                        | Next Action 更新规则                                                                 | 说明                                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| health check 全部通过                       | **不更新** Next Action，保持原值                                                     | 无阻塞，继续正常 workflow（session recovery / 当前 phase 流程）                      |
| health check 发现 degradation（会话启动时） | 写入 `health check: [degradation 概要] → 详情见 ~/.aether/health/global_health.json` | 阻塞用户决策：agent 逐项询问 env-setup 授权，用户决策完成后重新检测                  |
| uv 不可用（Tier 0 LLM bootstrap）           | 写入 `health check: uv不可用 → 详情见 ~/.aether/health/global_health.json`           | 最严重阻塞：无 Python 计算能力。agent 优先引导安装 uv                                |
| 用户请求"检查环境"（处于活跃 phase）        | **不更新** Next Action，保持原值                                                     | 检查环境是信息性操作，不改变当前 workflow 进度；检查结果仅追加 Health Status section |
| 用户补充环境后重新检测                      | 重新检测全部通过 → 恢复**检测前**的 Next Action                                      | re-check 通过意味着阻塞解除，恢复到被阻塞前的 workflow 状态                          |
| 用户补充环境后重新检测                      | 重新检测仍有 degradation → 更新为剩余 degradation 概要 + 指向 global_health.json     | 部分问题已解决，但仍有阻塞项，更新 Next Action 反映当前阻塞                          |

**Next Action 格式示例**：

```markdown
## Next Action

health check: infrastructure degraded (uv, docker_cli) → 详情见 ~/.aether/health/global_health.json
```

- 概要只列出 **degraded 层级名称** 和 **失败分类**（如 `infrastructure degraded (uv, docker_cli)`），不列出具体检测项结果
- 具体细节（版本号、失败原因、影响范围）全部在 `global_health.json` 中，STATE.md 仅指向该文件
- degradation 解除后恢复原 workflow Next Action 的方式：agent 在检测前备份 Next Action 原值到 STATE.md 的 `## Blockers` section（追加 `health_degradation: [概要]`），解除时从 Blockers 移除该条目并恢复原 Next Action

**恢复机制**：

```
检测前: Next Action = "Dispatch worker for phase_analysis (plan 1)"
         Blockers = _none_

检测发现 degradation:
         Next Action = "health check: infrastructure degraded (uv) → 详情见 ~/.aether/health/global_health.json"
         Blockers = "health_degradation: infrastructure (uv)"

用户安装 uv 后重新检测通过:
         Next Action = "Dispatch worker for phase_analysis (plan 1)"  ← 从 Blockers health_degradation 条目恢复
         Blockers = _none_
```

**网络状态文件**（全局，供所有 agent 阅读）：

存储位置：`~/.aether/health/network_status.md`

格式见 §3 Layer 1 网络状态持久化。research agent 和 research-worker agent 在执行搜索前应先阅读此文件，跳过不可达的 API。

### 5.5 自检不阻塞

自检是非阻塞的——即使检测发现问题，agent 仍然启动并进入 Entry Gate。自检结果只是提供降级决策的依据。用户可以在任何时间手动调用 `run_health_check` 重新检测。

唯一例外：当 health check 发现 degradation 时，STATE.md Next Action 会从原 workflow 值切换为 degradation 概要 + 指向 global_health.json（见 §5.4.1）。这不阻塞 agent 启动，但阻塞 workflow 推进——agent 需等待用户决策 env-setup 后才能继续原 workflow。degradation 解除后，Next Action 自动恢复到原值。

### 5.6 Worker Health Check 模式详细协议

**设计决策（D16）**：health_check 作为 research-worker 的一个执行模式，而非 primary agent 直接实施。

**原因**：

1. **架构一致性**：Path 3 的所有 phase 执行都走 coordinator→worker→skill 三层链路。health_check 是一个有界任务（执行检测、返回结果），天然适合 worker 执行模式。
2. **职责清晰**：coordinator 负责 Tier 0 bootstrap + digest 处理 + env-setup 用户交互（需 `question` tool）。Worker 负责检测执行（MCP 调用、bash 检测、cross-MCP 仲裁）。两者职责不重叠。
3. **可复用**：worker health_check 模式可在任何时机被 coordinator dispatch（会话启动、用户请求、env-setup 后重新检测），复用同一套执行逻辑。
4. **不膨胀 research.md**：检测逻辑复杂（4 层、30+ 检测项、cross-MCP 仲裁、临时文件写入），全部放在 worker 中可避免 primary agent prompt 过长。

#### Worker 执行流程

```
1. Worker 收到 dispatch prompt（mode=health_check, layers=[...]）
2. 调用 research-state MCP run_health_check(layers=指定 layers)
3. 如果 runtime 层包含 cross_mcp_pending → 仲裁：
   a. 调用 research-conventions MCP convention_lock_status(project_dir)
   b. 调用 research-conventions MCP skill_resolve_path(skill_name="gpd-conventions", project_dir)
   c. 合并 cross_mcp 结果到 health status
4. 写入 .aether/research/.health_global.json（从 health status 提取全局部分，D17）
5. 写入 .aether/research/.health_network.md（从 health status 提取网络部分，D17）
6. 返回 PhaseResultDigest{phase: health_check, output_paths: [步骤4-5的路径], ...}
```

#### PhaseResultDigest Schema（health_check 模式）

```yaml
phase_result_digest:
  phase: health_check
  sub_phase: null
  cycle: null
  status: pass | degraded | failed
  # pass = all layers healthy
  # degraded = some layers degraded (non-critical failures)
  # failed = critical failure (state.json corrupt, persistence not writable)
  degradation_summary:
    infrastructure: pass | degraded | failed
    persistence: pass | degraded | failed
    skill_chain: pass | degraded | failed
    runtime: pass | degraded | failed
    cross_mcp: pass | degraded | failed
    failed_items:
      - layer: [infrastructure | persistence | skill_chain | runtime]
        key: [health_check_key, e.g. "uv_available"]
        failure_class:
          [
            not_installed | not_configured | daemon_not_running | not_authenticated | unreachable | missing | corrupt | ...,
          ]
        auto_installable: true | "partial" | false
        priority: critical | high | medium | low
  output_paths:
    temp_global_health_json: ".aether/research/.health_global.json"
    temp_network_status_md: ".aether/research/.health_network.md"
    final_global_health_json: "~/.aether/health/global_health.json"
    final_network_status_md: "~/.aether/health/network_status.md"
  next_phase: null # health_check 不推进 state machine，仅提供诊断
```

**关键设计**：

- `degradation_summary` 是摘要级信息（各层 pass/fail/degraded + failed_items 列表），不包含具体检测项的版本号/HTTP code等细节——这些细节在 `global_health.json` 中，STATE.md 只指向该文件
- `failed_items` 包含 `auto_installable` 和 `priority` 字段，coordinator 可直接据此驱动 env-setup 逐项授权流程，无需再读取 install_registry.json 分类
- `next_phase: null` 表示 health_check 不推进 state machine phase。coordinator 根据 degradation 结果决定下一步（继续原 workflow / 进入 env-setup / 阻塞等待）
- `output_paths` 区分临时路径（temp*\*，worker 写入的项目内路径）和最终路径（final*\*，coordinator 迁移后的全局路径）。coordinator 从临时路径读取内容并覆写到最终路径，然后删除临时文件（D17）

#### Coordinator 处理 Health Check Digest

coordinator 收到 health_check digest 后的处理流程：

```
0. 迁移临时文件至全局位置（D17）：
   a. 读取 digest.output_paths.temp_global_health_json → 读取内容
   b. write tool: 覆写 ~/.aether/health/global_health.json（Tier 0 已预创建，权限已获取）
   c. 读取 digest.output_paths.temp_network_status_md → 读取内容
   d. write tool: 覆写 ~/.aether/health/network_status.md
   e. 删除临时文件（bash: rm .aether/research/.health_global.json .aether/research/.health_network.md）

1. 读取 digest.status：
   - pass → 不更新 STATE.md Next Action，继续原 workflow
   - degraded → 进入 degradation 处理流程（见下方）
   - failed → 进入 critical failure 处理流程（见下方）

2. degradation 处理流程：
   a. 备份 STATE.md Next Action 到 Blockers section:
      "health_degradation: [degradation_summary概要, e.g. infrastructure (uv, docker_cli)]"
   b. 更新 STATE.md Next Action:
      "health check: [degradation概要] → 详情见 ~/.aether/health/global_health.json"
   c. 更新 STATE.md Health Status section（各层 pass/fail/degraded + 指向 global_health.json）
   d. 告知用户 degradation 概要
   e. 对 digest.failed_items 中 auto_installable=true 或 "partial" 的项，按 priority 排序，
      使用 question tool 逐项询问用户是否授权安装（env-setup skill 工作流）
   f. 用户安装完成后 → 重新 dispatch worker (mode=health_check, layers=None) 全量检测
   g. 新 digest.status=pass → 从 Blockers 恢复原 Next Action，移除 health_degradation 条目

3. critical failure 处理流程（persistence.fail 等）：
   a. 同样备份 Next Action 到 Blockers
   b. 更新 Next Action 为 critical failure 概要 + 指向 global_health.json
   c. 告知用户 critical failure 无法降级绕过，需手动修复
   d. 等待用户确认修复后 → 重新 dispatch worker 全量检测

4. 用户请求"检查环境"（在活跃 phase 中）时的特殊处理：
   a. dispatch worker (mode=health_check) → 等待 digest
   b. 收到 digest → 仅更新 STATE.md Health Status section
   c. **不更新 Next Action**（informational，不改变 workflow 进度）
   d. 如发现 degradation → 仅告知用户，不主动进入 env-setup 流程
      （用户可选择稍后处理）
```

---

## 6. 降级策略

| 检测失败项                     | 降级方案                                                | 降级范围                                      | 可自动安装 | 用户提示                                                      |
| ------------------------------ | ------------------------------------------------------- | --------------------------------------------- | ---------- | ------------------------------------------------------------- |
| uv 不可用                      | 无 Python 计算能力，所有 SymPy 脚本不可用               | gpd-verification, local-executor, MCP scripts | yes        | "uv 未安装，可自动安装（需逐项授权）"                         |
| git 不可用                     | Phase Commit 和 State Recovery rollback 不可用          | Phase Commit Protocol, State Recovery         | yes        | "git 未安装，可自动安装（需逐项授权）"                        |
| 非 git 仓库                    | Phase Commit 和 rollback 不可用（无 repo context）      | Phase Commit Protocol, State Recovery         | yes        | "非 git 仓库，可自动执行 git init（需逐项授权）"              |
| Docker CLI 未安装              | sandbox-executor 不可用，所有 docker 任务降级为 uv_venv | sandbox-executor                              | yes        | "Docker 未安装，可自动安装（需逐项授权）"                     |
| Docker daemon 未运行           | sandbox-executor 不可用                                 | sandbox-executor                              | yes        | "Docker 已安装但 daemon 未运行，可尝试自动启动（需逐项授权）" |
| alpha CLI 未认证               | 论文搜索降级为 title+abstract only（no-login mode）     | alpha-research skill                          | partial    | "alpha CLI 可自动安装，但认证需手动执行 `alpha login`"        |
| 网络不可达（arXiv）            | arXiv 论文搜索不可用                                    | alpha-research, literature-review             | no         | "arXiv API 不可达，请检查网络"                                |
| 网络不可达（Semantic Scholar） | Semantic Scholar 搜索不可用                             | literature-review, research-worker            | no         | "Semantic Scholar API 不可达"                                 |
| 网络不可达（INSPIRE-HEP）      | INSPIRE-HEP 物理文献搜索不可用                          | physics 文献搜索                              | no         | "INSPIRE-HEP 不可达，物理文献搜索降级为 arXiv only"           |
| gpd skill 链断裂               | 物理验证降级为 research-verification only               | gpd-verifier, gpd-reviewer                    | no         | "gpd skills 不完整，请检查 skills 目录"                       |
| SymPy 脚本不可运行             | 计算验证降级为 LLM-only reasoning                       | gpd-verification scripts                      | no         | "SymPy 脚本无法运行（依赖 uv + 网络）"                        |
| research-conventions MCP 离线  | 约定锁读写不可用，验证流程降级                          | gpd-verifier, gpd-reviewer                    | no         | "research-conventions MCP 离线，请重启 agent"                 |
| convention_defaults.json 缺失  | subfield_defaults 不可用，需手动指定约定                | gpd-conventions                               | no         | "物理约定默认值文件缺失"                                      |

> **partial** 表示可自动安装本体但需用户手动完成后续步骤（如认证）。
> NVIDIA GPU 不在此表中——aether 本身不依赖 GPU（D12）。项目级 GPU 需求由 ENVIRONMENT.md 声明。

### 降级决策矩阵

```

infrastructure.pass AND persistence.pass AND skill_chain.pass → 全量能力
infrastructure.pass AND persistence.pass AND skill_chain.fail(gpd) → 通用研究可用，物理验证降级
infrastructure.fail(uv) → Tier 0 LLM bootstrap，无 Python 计算能力
infrastructure.fail(git) → Phase Commit 和 State Recovery rollback 不可用
infrastructure.fail(git_working_dir) → rollback 不可用（非 git 仓库）
infrastructure.fail(alpha_cli) → 论文搜索降级
infrastructure.fail(network_arxiv) → arXiv 搜索不可用
infrastructure.fail(network_semantic_scholar) → Semantic Scholar 搜索不可用
infrastructure.fail(network_inspire_hep) → INSPIRE-HEP 搜索不可用
infrastructure.fail(docker_cli) → Docker 未安装，容器隔离不可用
infrastructure.fail(docker_daemon) AND docker_cli.pass → Docker 已安装但 daemon 未运行
persistence.fail(state_json) → 状态机不可用，全盘降级
persistence.fail(persistence_dir) → 状态持久化不可用

```

### 6.5 自动安装协议（env-setup skill）

当 health check 发现缺失项时，agent 可通过 `env-setup` skill 引导用户完成自动安装，而非仅提示手动操作。

#### 设计原则

- **检测与安装解耦**：health check MCP tool 是只读操作（`READ_ONLY` annotation）；安装是写操作，由 agent 通过 skill 指引执行，需用户逐项授权（D11）
- **分类优先**：install_registry 将所有检测项分为 `auto_installable`（可自动安装）、`partial`（可安装但需手动后续步骤）、`no`（需完全手动），agent 据此与用户逐项沟通
- **单 skill + registry**：不为每个软件创建独立 skill，所有安装方法集中在 `install_registry.json`，新增软件仅需新增一条 registry entry
- **逐项授权**：每项独立询问用户是否授权安装，用户可选择性安装（如只安装 uv，不安装 Docker）

#### env-setup skill 结构

```
env-setup/
  SKILL.md                    # 自动安装工作流指引
  references/
    install_registry.json     # 软件 → 安装方法映射
```

#### install_registry.json schema

```json
{
  "uv": {
    "auto_installable": true,
    "platforms": {
      "macos": "curl -LsSf https://astral.sh/uv/install.sh | sh",
      "linux": "curl -LsSf https://astral.sh/uv/install.sh | sh"
    },
    "verify_command": "uv --version",
    "post_install_note": "可能需要重新启动 shell 或 source ~/.bashrc/~/.zshrc；同一进程的 PATH 可能未更新，若 verify 失败请建议用户 source 或重开终端",
    "layer": "infrastructure",
    "health_check_key": "uv_available",
    "priority": "critical"
  },
  "git": {
    "auto_installable": true,
    "platforms": {
      "macos": "brew install git",
      "linux": "sudo apt-get install -y git || sudo yum install -y git"
    },
    "verify_command": "git --version",
    "post_install_note": null,
    "layer": "infrastructure",
    "health_check_key": "git_available",
    "priority": "high"
  },
  "git_init": {
    "auto_installable": true,
    "platforms": {
      "macos": "git init",
      "linux": "git init"
    },
    "verify_command": "git rev-parse --git-dir",
    "post_install_note": null,
    "layer": "infrastructure",
    "health_check_key": "git_working_dir",
    "condition": "git_available == pass AND git_working_dir == fail",
    "priority": "high"
  },
  "docker": {
    "auto_installable": true,
    "platforms": {
      "macos": "brew install --cask docker",
      "linux": "curl -fsSL https://get.docker.com | sh"
    },
    "verify_command": "docker version --format '{{.Client.Version}}'",
    "post_install_note": "macOS 安装后需打开 Docker Desktop 应用；Linux 需 sudo systemctl start docker 启动 daemon",
    "layer": "infrastructure",
    "health_check_key": "docker_cli",
    "priority": "medium"
  },
  "docker_daemon": {
    "auto_installable": true,
    "platforms": {
      "macos": "open -a Docker",
      "linux": "sudo systemctl start docker"
    },
    "verify_command": "docker info --format '{{.ServerVersion}}'",
    "verify_delay_seconds": 30,
    "post_install_note": "Docker Desktop 启动需要时间，将在 30 秒后验证 daemon 是否就绪",
    "layer": "infrastructure",
    "health_check_key": "docker_daemon",
    "condition": "docker_cli == pass AND docker_daemon == fail",
    "priority": "medium"
  },
  "alpha_cli": {
    "auto_installable": "partial",
    "platforms": {
      "macos": "brew install alpha || npm install -g @anthropic/alpha",
      "linux": "npm install -g @anthropic/alpha"
    },
    "verify_command": "alpha status",
    "post_install_note": "安装完成后需手动执行 `alpha login` 完成认证",
    "manual_step": "alpha login",
    "layer": "infrastructure",
    "health_check_key": "alpha_cli",
    "priority": "low"
  }
}
```

> NVIDIA GPU 不在 registry 中（D12：aether 不依赖 GPU，项目级需求由 ENVIRONMENT.md 声明）。

**字段说明**：

| 字段                   | 类型             | 说明                                                                              |
| ---------------------- | ---------------- | --------------------------------------------------------------------------------- |
| `auto_installable`     | bool / "partial" | `true` = 可完全自动安装；`"partial"` = 可安装但需手动后续；`false` = 不可自动安装 |
| `platforms`            | dict             | `{macos: cmd, linux: cmd}`，agent 根据宿主机 platform 选择                        |
| `verify_command`       | string           | 安装后用于验证的命令，与 health check 对应项的检测方法一致                        |
| `verify_delay_seconds` | number \| null   | 安装后等待多少秒再执行 verify_command（适用于 Docker Desktop 等需启动时间的软件） |
| `post_install_note`    | string \| null   | 安装后需用户注意的事项（如重启 shell、打开 GUI）                                  |
| `manual_step`          | string \| null   | `partial` 类型需要的手动后续步骤（如 `alpha login`）                              |
| `manual_instructions`  | string \| null   | `false` 类型提供给用户的手动安装指引                                              |
| `condition`            | string \| null   | 安装前置条件表达式，如 `git_available == pass AND git_working_dir == fail`        |
| `layer`                | string           | 对应 health check 的层级，用于定位 health_check_key                               |
| `health_check_key`     | string           | 对应 health check 返回中该项的 key，安装后可重新检测验证                          |
| `priority`             | string           | `critical` / `high` / `medium` / `low`，决定逐项授权时的询问顺序                  |

#### 逐项授权工作流

```
1. health check → 获得所有 failed 项
2. 读取 install_registry.json → 分类并按 priority 排序：
   - installable_items:  auto_installable == true 或 "partial" 的项，按 priority 排序（critical → high → medium → low）
   - manual_items:       auto_installable == false 或不在 registry 中的项
3. 对每个 installable_item，**逐项**询问用户：
   ┌─ uv 不可用（priority: critical）
   │  "uv 是所有 Python 计算的基础依赖，建议安装。
   │   安装命令：curl -LsSf https://astral.sh/uv/install.sh | sh
   │   是否授权自动安装 uv？[yes/no]"
   │  → 用户同意 → 执行安装 → verify → 记录结果
   │  → 用户拒绝 → 标记为 user_declined，继续下一项
   │
   ├─ git 不可用（priority: high）
   │  "git 是状态回滚与阶段提交的基础依赖。
   │   安装命令：brew install git (macOS) / apt-get install git (Linux)
   │   是否授权自动安装 git？[yes/no]"
   │  → ...
   │
   ├─ Docker CLI 未安装（priority: medium）
   │  "Docker 是可选的容器隔离环境，不安装则降级为 uv venv。
   │   安装命令：brew install --cask docker (macOS) / get.docker.com (Linux)
   │   是否授权自动安装 Docker？[yes/no]"
   │  → ...
   │
   └─ alpha CLI 未认证（priority: low, partial）
      "alpha CLI 可提升论文搜索质量（全文阅读），安装后需手动 alpha login。
       是否授权自动安装 alpha CLI？[yes/no]"
      → ...
4. 执行每项安装：
   - 执行前检查 condition（如 git_init 需要 git_available 先通过）
   - 执行 install_command
   - 若 verify_delay_seconds 非空 → 等待指定秒数（告知用户"等待服务启动..."）
   - 执行 verify_command 验证
   - 验证失败 → 标记该项为 install_failed，告知用户
     - 特殊处理 uv：uv 安装后同一进程 PATH 可能未更新，verify 失败时建议用户 source ~/.bashrc 或重开终端
   - 验证通过 → 标记该项为 installed
   - 有 post_install_note → 告知用户注意事项
   - partial 类型 → 告知用户需执行 manual_step
5. 安装完毕 → 重新调用 run_health_check 验证整体状态
6. 整理 manual_items + install_failed + user_declined + partial 的 manual_step：
   "以下项仍需手动处理：
   - alpha CLI: 请执行 `alpha login`
   - uv: 安装失败，请手动执行 curl ... | sh 或重开终端
   - [用户拒绝的项]：可稍后通过 '检查环境' 重新检测并安装"
```

**关键设计**：逐项授权而非批量授权（D11）。用户可只安装 uv（必须）而跳过 Docker（可选），不被迫二选一。

#### 与 health check 的交互

- `run_health_check` 是只读 MCP tool，不包含安装逻辑
- `env-setup` skill 的 SKILL.md 指引 coordinator 执行上述逐项授权工作流（coordinator 使用 question tool 与用户交互）
- 安装完成后，coordinator 重新 dispatch research-worker(mode=health_check) 验证安装结果
- uv 安装属于 Tier 0 范围（LLM bootstrap，coordinator 直接执行），优先级最高；其他项属于 Tier 1-4 范围（通过 worker 检测后 coordinator 交互安装）

---

## 7. 实现细节

### 7.1 research-state MCP 扩展

修改 `.aether/mcp/research-state/server.py`：

1. 保留现有 `run_health_check` 作为 Layer 2（persistence）检测
2. 新增 Layer 1（infrastructure）、Layer 3（skill_chain）、Layer 4（runtime）检测函数
3. 重构 `run_health_check` 参数签名：移除 `fix` 参数，增加 `layers` 参数
4. 检测顺序改为 infrastructure → persistence → skill_chain → runtime
5. Docker 检测拆分为 `docker_cli`（Client.Version）和 `docker_daemon`（ServerVersion）
6. 网络检测使用 fallback 方案（curl → wget → python3），检测 3 个 endpoint
7. 移除 NVIDIA GPU 检测
8. SymPy dry-run 改为所有 9 个脚本
9. runtime 层返回 `cross_mcp_pending` 而非直接调用 research-conventions MCP
10. advance_plan rollback 增加 fallback：失败时直接写回 state.json 原文

**接口迁移说明**：

- `fix` 参数移除：原 `fix=true` 会在 state.json 缺失时自动创建。新设计中检测与修复解耦——health check MCP tool 是只读操作（`READ_ONLY`），自动修复由 env-setup skill 驱动（需逐项用户授权）。当前无已知调用方传递 `fix=true`（autoresearch SKILL.md 不调用此 MCP tool），因此移除无破坏性影响
- `layers` 参数新增：默认 `None`（执行全部 4 层），可传 `["infrastructure", "persistence"]` 只执行指定层。该参数是纯增量变更，不破坏现有调用
- 返回格式扩展：原返回 `{"healthy", "issues", "checks", "project_dir"}`，新返回增加 `layers` 嵌套结构和 `schema_version` 字段。旧字段 `healthy`、`issues`、`checks` 保留为顶层字段以保持兼容（persistence 层结果映射到 `checks`），新增内容在 `layers` 键下

新增检测函数：

```python
def _check_network(url: str) -> dict:
    methods = [
        ("curl",  ["curl", "-sL", "-o", "/dev/null", "-w", "%{http_code}", url]),
        ("wget",  ["wget", "-q", "-O", "/dev/null", "--timeout=5", url]),
        ("python", ["python3", "-c", f"import urllib.request; r=urllib.request.urlopen('{url}',timeout=5); print(r.status)"]),
    ]
    for name, cmd in methods:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode == 0:
            code = result.stdout.strip()
            if code.startswith("2"):
                return {"status": "pass", "method": name, "url": url, "http_code": int(code)}
            if code == "429":
                return {"status": "degraded", "method": name, "url": url, "http_code": 429,
                        "note": "rate limited, endpoint reachable but throttled"}
    return {"status": "fail", "url": url, "attempts": [m[0] for m in methods]}


def _check_infrastructure(project_dir: Path) -> dict:
    checks = {}
    issues = []

    result = subprocess.run(["uv", "--version"], capture_output=True, text=True, timeout=10)
    checks["uv_available"] = result.returncode == 0
    if result.returncode != 0:
        issues.append("uv not available")
    else:
        checks["uv_version"] = result.stdout.strip()

    result = subprocess.run(["uv", "python", "list"], capture_output=True, text=True, timeout=10)
    checks["uv_python_management"] = result.returncode == 0
    if result.returncode == 0:
        checks["uv_python_versions"] = [line.strip() for line in result.stdout.strip().splitlines() if line.strip()]

    result = subprocess.run(["git", "--version"], capture_output=True, text=True, timeout=10)
    checks["git_available"] = result.returncode == 0
    if result.returncode != 0:
        issues.append("git not available")
    else:
        checks["git_version"] = result.stdout.strip()

    result = subprocess.run(["git", "rev-parse", "--git-dir"], capture_output=True, text=True, timeout=10)
    checks["git_working_dir"] = result.returncode == 0
    if result.returncode != 0:
        issues.append("not inside a git repository")

    result = subprocess.run(["docker", "version", "--format", "{{.Client.Version}}"],
                           capture_output=True, text=True, timeout=10)
    checks["docker_cli"] = result.returncode == 0
    if result.returncode == 0:
        checks["docker_client_version"] = result.stdout.strip()
    else:
        issues.append("docker CLI not installed")

    result = subprocess.run(["docker", "info", "--format", "{{.ServerVersion}}"],
                           capture_output=True, text=True, timeout=10)
    checks["docker_daemon"] = result.returncode == 0
    if result.returncode == 0:
        checks["docker_server_version"] = result.stdout.strip()
    elif checks.get("docker_cli", False):
        issues.append("docker CLI available but daemon not running")

    result = subprocess.run(["alpha", "status"], capture_output=True, text=True, timeout=10)
    if result.returncode == 0:
        checks["alpha_cli"] = "account" in result.stdout.lower() or "logged" in result.stdout.lower()
        checks["alpha_authenticated"] = checks["alpha_cli"]
    else:
        checks["alpha_cli_available"] = False
        issues.append("alpha CLI not available")

    checks["network_arxiv"] = _check_network("https://api.arxiv.org")
    checks["network_semantic_scholar"] = _check_network("https://api.semanticscholar.org")
    checks["network_inspire_hep"] = _check_network("https://inspirehep.net/api")

    return {"healthy": len(issues) == 0, "checks": checks, "issues": issues}


def _check_persistence(project_dir: Path) -> dict:
    checks = {}
    issues = []
    persistence_dir = project_dir / ".aether" / "research" / "persistence"

    try:
        persistence_dir.mkdir(parents=True, exist_ok=True)
        checks["persistence_dir_writable"] = {"status": "pass"}
    except OSError as e:
        checks["persistence_dir_writable"] = {"status": "fail", "reason": str(e)}
        issues.append(f"persistence directory not writable: {e}")

    state_json_path = persistence_dir / "state.json"
    if state_json_path.exists():
        try:
            data = json.loads(state_json_path.read_text())
            checks["state_json_valid"] = {"status": "pass", "phase": data.get("phase", "unknown")}
        except json.JSONDecodeError as e:
            checks["state_json_valid"] = {"status": "fail", "reason": str(e)}
            issues.append(f"state.json corrupt: {e}")

    convention_defaults = project_dir / ".aether" / "skills" / "plugins" / "gpd" / "gpd-conventions" / "references" / "convention_defaults.json"
    if convention_defaults.exists():
        try:
            data = json.loads(convention_defaults.read_text())
            checks["convention_defaults_readable"] = {"status": "pass", "keys_count": len(data)}
        except (json.JSONDecodeError, OSError) as e:
            checks["convention_defaults_readable"] = {"status": "fail", "reason": str(e)}
            issues.append(f"convention_defaults.json unreadable: {e}")
    else:
        checks["convention_defaults_readable"] = {"status": "fail", "reason": "file not found"}
        issues.append("convention_defaults.json missing")

    return {"healthy": len(issues) == 0, "checks": checks, "issues": issues}


def _check_skill_chain(project_dir: Path) -> dict:
    # (same as before, unchanged)
    ...
```

### 7.2 autoresearch SKILL.md 环境探测修改

将 Step 2 的探测从 `python3 --version` 改为 `uv --version` + `uv python list`：

```bash
uv --version 2>/dev/null || echo "uv: not available"
uv python list 2>/dev/null || echo "uv python management: not available"
```

删除 `python3 --version` 行，保留 `docker --version`、`wolframscript --version`。

### 7.3 research.md 自检注入（Coordinator 侧）

在 research.md 的 Session Recovery section 中增加 Tier 0 + worker dispatch + digest 处理步骤。Coordinator 不直接执行 Tier 1-4 检测（D16），仅负责 Tier 0 bash bootstrap、缓存有效性检查、全局文件权限预获取、digest 后的 STATE.md/env-setup 交互、以及临时文件迁移。

```
On session start:
  1. (新增) Tier 0: bash uv --version → if fail → LLM bootstrap → env-setup (逐项授权)
  2. (新增) Tier 0.5: 检查缓存有效性
      bash: bash ~/.aether/health/cache_check.sh
      （cache_check.sh 由 seedDefaultAssets() 从 .aether/health/ 同步）
      if exit 0 → 读取 ~/.aether/health/global_health.json 缓存，跳过步骤 3-5
      if exit 1 → 预创建全局健康目录（D18）：
       bash: mkdir -p ~/.aether/health
       write: ~/.aether/health/global_health.json（空占位 {}，触发一次性权限申请）
       write: ~/.aether/health/network_status.md（空占位，触发一次性权限申请）
  3. (新增) dispatch research-worker(mode=health_check, layers=["infrastructure","persistence","skill_chain"])
  4. (新增) 等待 worker 返回 health_check PhaseResultDigest
  5. (新增) 迁移临时文件至全局位置（D17）：
     读取 digest.output_paths.temp_global_health_json → write ~/.aether/health/global_health.json
     读取 digest.output_paths.temp_network_status_md → write ~/.aether/health/network_status.md
     bash: rm 临时文件
  6. (新增) 处理 digest (见 §5.6 Coordinator 处理 Health Check Digest):
     - pass → 不更新 Next Action，继续原 workflow
     - degraded → 备份 Next Action 到 Blockers, 更新 Next Action 为 degradation 概要,
       逐项 env-setup 授权 → 安装完成后重新 dispatch worker 全量检测
     - failed → 备份 Next Action, 更新 Next Action 为 critical failure 概要,
       等待用户手动修复 → 修复后重新 dispatch worker 全量检测
  7. (新增) 写入 STATE.md Health Status section（各层 pass/fail/degraded + 指向 global_health.json）
  8. (existing flow continues: Read STATE.md, state.json, DIGESTS.md, ENVIRONMENT.md...)
```

On user requests "检查环境" or "health check" (during active workflow):

1. dispatch research-worker(mode=health_check, layers=None) → 等待 digest
2. 写入 STATE.md Health Status section
3. **DO NOT update Next Action** — informational，不改变 workflow 进度
4. 如发现 degradation → 仅告知用户，不主动进入 env-setup 流程

On user says "我已补充环境" / "我安装了缺失的 xxx":

1. dispatch research-worker(mode=health_check, layers=None) → 等待 digest (全量检测验证)
2. If digest.status=pass → 从 Blockers 恢复原 Next Action，移除 health_degradation 条目
3. If digest.status=degraded → 更新 Next Action 为剩余 degradation 概要 + 指向 global_health.json

### 7.3b research-worker.md health_check 模式注入

在 research-worker.md 的 Phase Routing table 中增加 health_check 行，skill_refs 增加 health-check，并将执行逻辑提取为独立 skill。

#### Phase Routing 新增行

| phase        | sub_phase | Execution method           |
| ------------ | --------- | -------------------------- |
| health_check | (none)    | Invoke /health-check skill |

#### skill_refs 新增

```
skill_refs:
  - health-check
```

#### health-check skill（`.aether/skills/health-check/SKILL.md`）

health_check 模式的执行逻辑由独立 skill 实现，research-worker 通过 `skill` tool 调用。Skill 内部 6 步协议：

```
Step 1: 读取 dispatch prompt 中的 layers 参数（默认 ["infrastructure","persistence","skill_chain"]）
Step 2: 调用 research-state MCP run_health_check(project_dir, layers=指定 layers)
Step 3: 如果 runtime 层执行且返回 cross_mcp_pending → 仲裁：
   a. 调用 research-conventions MCP convention_lock_status(project_dir)
   b. 调用 research-conventions MCP skill_resolve_path(skill_name="gpd-conventions", project_dir)
   c. 合并 cross_mcp 结果到 health status dict
Step 4: 写入 .aether/research/.health_global.json + .aether/research/.health_network.md（D17）
Step 5: 根据 health status 构建 degradation_summary（各层 pass/degraded/failed + failed_items）
Step 6: 输出 PhaseResultDigest（见 §5.6 schema），next_phase=null
```

**提取为独立 skill 的原因**：

1. health_check 检测逻辑复杂（4 层、30+ 检测项、cross-MCP 仲裁、临时文件写入），独立 skill 避免 research-worker.md 过长
2. 与其他 phase 走 skill tool 调用链路一致（phase_analysis → alpha-research skill, phase_execution → autoresearch skill）
3. Skill 可独立迭代修改，不影响 research-worker.md 的 phase routing 和 digest 格式定义

**关键约束**：

- health_check 模式 **不调用 advance_plan**（不推进 state machine phase）
- health_check 模式 **不修改 STATE.md**（coordinator 负责基于 digest 写入 STATE.md）
- health_check 模式 **仅在 .aether/research/ 下写临时文件**（.health_global.json + .health_network.md），不超出 file_scope（D17）
- 临时文件由 coordinator 读取后迁移至 ~/.aether/health/ 并删除，worker 不直接写全局目录
- health_check digest 的 `next_phase` 字段为 null

### 7.4 全局检测结果管理（两阶段写入，D17 + D18）

全局检测结果采用两阶段写入机制（D17），避免 worker 违反 file_scope 约束：

1. **阶段 1（Worker）**：写入项目内临时文件（`.aether/research/` 下），在 file_scope 允许范围内
2. **阶段 2（Coordinator）**：读取临时文件内容，覆写至 `~/.aether/health/`（Tier 0 已预获取权限，D18），然后删除临时文件

#### 阶段 1：Worker 写入临时文件

Worker 在 health_check 模式中将检测结果写入项目内临时文件：

```
Worker health_check 模式写入步骤：
1. 调用 run_health_check MCP → 获得 result dict
2. 从 result 中提取 infrastructure + network 部分
3. write tool: .aether/research/.health_global.json
   内容格式见下方
4. write tool: .aether/research/.health_network.md
   内容格式见下方
```

**临时文件命名约定**：以 `.health_` 前缀命名，区别于其他持久化文件，coordinator 迁移后删除。临时文件放在 `.aether/research/`（而非 `persistence/` 子目录），因为 `validate_file_locations` MCP tool 会对 `persistence/` 下非白名单文件报违规，而 `.aether/research/.health_*` 不受该检查约束。

#### 阶段 2：Coordinator 迁移至全局位置

Coordinator 收到 worker digest 后执行迁移：

```
Coordinator 迁移步骤：
1. 读取 .aether/research/.health_global.json → 获得内容
2. write tool: 覆写 ~/.aether/health/global_health.json
   （Tier 0.5 已预创建空占位文件并获取写权限，此处不再触发权限申请）
3. 读取 .aether/research/.health_network.md → 获得内容
4. write tool: 覆写 ~/.aether/health/network_status.md
5. bash: rm .aether/research/.health_global.json .aether/research/.health_network.md
```

**为什么不由 worker 直接写全局文件**：worker 的 `file_scope: [".aether/research/**"]` 限制其 write/edit 工具只能写入项目内路径。`~/.aether/health/` 在项目外，write tool 使用的 `path.relative(Instance.worktree, filepath)` 会生成 `../../.aether/health/...` 路径，无法被 file_scope pattern 匹配。两阶段写入完全避免修改权限系统或绕过 file_scope。

**并发安全性**：临时文件写入项目内 `.aether/research/`（项目隔离），coordinator 迁移至 `~/.aether/health/` 时为单线程操作（同一 coordinator 会话内串行处理 digest）。不同项目的 coordinator 会话可能并发写入 `~/.aether/health/`，但全局文件是全量覆写（非追加），最后一次写入胜出，无数据损坏风险。无需额外的文件锁。

#### 缓存有效期判断（cache_check.sh）

coordinator 不由 LLM 计算时间差判断缓存过期，而是调用固定脚本 `~/.aether/health/cache_check.sh`。该脚本由 `seedDefaultAssets()` 从项目 `.aether/health/cache_check.sh` 同步到 `~/.aether/health/`（与 agent/mcp/skills 一同在 CLI 启动时同步）：

```bash
#!/usr/bin/env bash
# ~/.aether/health/cache_check.sh
# Seeded from .aether/health/ via seedDefaultAssets() at CLI startup.
# Usage: bash ~/.aether/health/cache_check.sh
# Exit 0 = cache valid, Exit 1 = cache expired or missing

CACHE_FILE="$HOME/.aether/health/global_health.json"
MAX_AGE_SECONDS=86400  # 24 hours

if [ ! -f "$CACHE_FILE" ]; then exit 1; fi

now=$(date +%s)
mtime=$(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null)
age=$((now - mtime))

if [ "$age" -gt "$MAX_AGE_SECONDS" ]; then exit 1; fi
exit 0
```

coordinator 在 Tier 0.5 阶段调用 `bash ~/.aether/health/cache_check.sh`：

- 脚本由 `seedDefaultAssets()` 在 CLI 启动时自动同步（源：`.aether/health/` → 目标：`~/.aether/health/`）
- `global_health.json` 和 `network_status.md` 是运行时数据，不在 seed 范围内（避免覆盖用户已有数据），由 coordinator 在 Tier 0.5 首次创建空占位
- exit 0（缓存有效）→ 跳过 Tier 1-4 检测，直接读取 `~/.aether/health/global_health.json` 缓存
- exit 1（缓存过期或缺失）→ dispatch worker 执行全量检测

**global_health.json 格式**（由 worker 从 MCP 返回值构建）：

```json
{
  "schema_version": 1,
  "updated_at": "2024-01-15T10:30:00Z",
  "infrastructure": {
    "uv_available": { "status": "pass", "version": "0.4.20" },
    "docker_cli": { "status": "pass", "client_version": "24.0.7" },
    "docker_daemon": { "status": "pass", "server_version": "24.0.7" },
    "git_available": { "status": "pass", "version": "2.43.0" },
    "alpha_cli": { "status": "pass", "authenticated": true }
  },
  "network": {
    "arxiv": { "status": "pass", "method": "curl", "http_code": 200 },
    "semantic_scholar": { "status": "pass", "method": "curl", "http_code": 200 },
    "inspire_hep": { "status": "fail", "method": null }
  }
}
```

**network_status.md 格式**（由 worker 从 MCP 返回值构建）：

```markdown
# Network Status (updated: 2024-01-15T10:30:00Z)

## Reachable

- arxiv: OK (curl, 200)
- semantic_scholar: OK (curl, 200)

## Unreachable

- inspire_hep: FAIL → physics 文献搜索不可用

## Recommendations

- arXiv/Semantic Scholar 可用 → 论文搜索正常
- INSPIRE-HEP 不可用 → physics 领域文献搜索降级为 arXiv only
```

- 缓存有效期通过文件 mtime 判断（24 小时）。过期后，下次会话启动时 coordinator dispatch worker 重新检测。
- mtime 检查由固定脚本 `~/.aether/health/cache_check.sh` 完成，coordinator 在 Tier 0 阶段调用，避免 LLM 计算时间差。
- Worker 在构建临时文件时使用当前 UTC 时间写入 `updated_at` 字段（供人阅读，不用于过期判断）。

### 7.5 文件改动清单

| 文件                                                        | 改动内容                                                                                                                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.aether/mcp/research-state/server.py`                      | 扩展 run_health_check，新增 Layer 1-4 检测函数，拆分 docker 检测，移除 nvidia/fix，增加 fallback 网络，所有 9 sympy dry-run（stdin 传最小合法输入），增加 cross_mcp_pending，alpha_cli 区分 not_installed/not_authenticated |
| `.aether/agent/research.md`                                 | Session Recovery 增加 Tier 0 bash 自检 + Tier 0.5 全局目录预创建 + worker dispatch + digest 处理 + 临时文件迁移至全局 + env-setup 逐项授权交互 + STATE.md/Blockers degradation 更新规则                                     |
| `.aether/agent/research-worker.md`                          | Phase Routing 增加 health_check 行，skill_refs 增加 health-check，增加 health_check 模式执行协议（调用 health-check skill + 返回 digest）                                                                                   |
| `.aether/skills/health-check/SKILL.md`                      | 新增：health_check 模式执行 skill（6 步协议：读取参数 → 调用 MCP → cross-MCP 仲裁 → 写临时文件 → 构建摘要 → 输出 digest）                                                                                                   |
| `.aether/skills/autoresearch/SKILL.md`                      | Step 2 环境探测改为 uv 优先，移除 python3，移除 nvidia-smi，ENVIRONMENT.md host_system 字段更新                                                                                                                             |
| `.aether/skills/env-setup/SKILL.md`                         | 新增：逐项授权自动安装工作流指引                                                                                                                                                                                            |
| `.aether/skills/env-setup/references/install_registry.json` | 新增：软件 → 安装方法映射（含 priority 字段，移除 nvidia）                                                                                                                                                                  |
| `packages/opencode/src/plugin/aether-bin.ts`                | 新增：将 `~/.aether/bin` 加入 shell PATH（支持 uv 安装后同一进程可用）                                                                                                                                                      |
| `packages/opencode/src/plugin/index.ts`                     | 注册 AetherBinPlugin                                                                                                                                                                                                        |
| `~/.aether/health/global_health.json`                       | 运行时：全局检测结果存储位置（由 coordinator 从临时文件迁移写入）                                                                                                                                                           |
| `~/.aether/health/network_status.md`                        | 运行时：网络状态文件供 agent 阅读（由 coordinator 从临时文件迁移写入）                                                                                                                                                      |
| `~/.aether/health/cache_check.sh`                           | 由 `seedDefaultAssets()` 从 `.aether/health/cache_check.sh` 同步至 `~/.aether/health/`（与 agent/mcp/skills 一同在 CLI 启动时同步），缓存有效期判断脚本（基于文件 mtime，避免 LLM 计算时间差）                              |
| `packages/opencode/src/persist/migrate.ts`                  | `seedDefaultAssets()` 新增 `health` subdir 同步（条件：`.aether/health/` 存在）                                                                                                                                             |
| `.aether/agent/local-executor.md`                           | 无改动（已有 uv venv 流程）                                                                                                                                                                                                 |

---

## 8. 验收清单

| #   | 验收项                                                                                                  | 验收方法                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | `run_health_check(layers=["infrastructure"])` 返回 uv 版本                                              | 调用 MCP tool，检查返回含 uv_version                                                                                       |
| 2   | `run_health_check` 不检测 python3                                                                       | 调用 MCP tool，返回中无 python3 相关字段                                                                                   |
| 3   | `run_health_check` 不检测 nvidia_gpu                                                                    | 调用 MCP tool，返回中无 nvidia_gpu 相关字段                                                                                |
| 4   | Docker 检测拆分为 docker_cli 和 docker_daemon                                                           | Docker 未安装时 docker_cli=fail，daemon 未运行时 docker_cli=pass+docker_daemon=fail                                        |
| 5   | 网络检测覆盖 arXiv/Semantic Scholar/INSPIRE-HEP 三个 endpoint                                           | 调用 MCP tool，返回含 network_arxiv/semantic_scholar/inspire_hep                                                           |
| 6   | 网络检测 fallback：curl 不可用时自动降级到 wget/python                                                  | 模拟 curl 不可用环境，网络检测仍返回结果                                                                                   |
| 7   | `~/.aether/health/network_status.md` 存在且内容有效                                                     | 读取文件，含 Reachable/Unreachable/Recommendations                                                                         |
| 8   | 检测顺序为 infrastructure → persistence → skill_chain → runtime                                         | 调用全量检测，各层按此顺序执行                                                                                             |
| 9   | persistence 层在 skill_chain 之前执行                                                                   | 调用 layers=["persistence","skill_chain"]，persistence 先完成                                                              |
| 10  | `run_health_check` runtime 层包含所有 9 个 SymPy dry-run                                                | 调用 MCP tool，返回 sympy_dry_run 含 9 个脚本结果                                                                          |
| 11  | runtime 层返回 cross_mcp_pending 字段                                                                   | 调用 MCP tool，返回含 cross_mcp_pending 列表                                                                               |
| 12  | advance_plan rollback 失败时 fallback 写回 state.json 原文                                              | 模拟 rollback 失败，检测后 state.json 内容与检测前一致                                                                     |
| 13  | research.md Session Recovery 包含 Tier 0 bash 自检步骤                                                  | 读取 research.md，有 uv bash 检测步骤                                                                                      |
| 14  | research.md Session Recovery 包含 worker dispatch 步骤（非直接 MCP 调用）                               | 读取 research.md，Tier 1-4 步骤为 dispatch research-worker(mode=health_check)                                              |
| 15  | `~/.aether/health/global_health.json` 不含 expires_at 字段，缓存有效期由文件 mtime 判断                 | 读取文件，无 expires_at 键；mtime 距当前时间 < 24h 时 cache_check.sh 返回 0                                                |
| 16  | 全局检测结果 24h 过期后自动重新检测（通过 cache_check.sh 判断）                                         | 修改 global_health.json 的 mtime 为 25 小时前，cache_check.sh 返回 1，coordinator dispatch worker 重新检测                 |
| 17  | autoresearch SKILL.md Step 2 不包含 python3                                                             | 读取 SKILL.md，无 `python3 --version`                                                                                      |
| 18  | 降级策略：Docker CLI 未安装 vs daemon 未运行提示不同                                                    | docker_cli fail 提示"未安装"，docker_daemon fail 提示"未运行"                                                              |
| 19  | env-setup skill SKILL.md 含逐项授权工作流                                                               | 查找 `.aether/skills/env-setup/SKILL.md`                                                                                   |
| 20  | install_registry.json 含 priority 字段                                                                  | 读取 registry，每项有 priority（critical/high/medium/low）                                                                 |
| 21  | install_registry.json 不含 nvidia_gpu                                                                   | 读取 registry，无 nvidia_gpu 条目                                                                                          |
| 22  | 自动安装逐项授权而非批量                                                                                | 模拟 uv+docker 不可用，coordinator 逐项询问而非一次性全量授权                                                              |
| 23  | Tier 0 LLM bootstrap：uv 不可用时 coordinator bash 检测                                                 | 移除 uv，会话启动时 coordinator 执行 uv --version bash 命令                                                                |
| 24  | STATE.md Health Status section 仅含各层 pass/fail/degraded，不含具体检测项细节                          | 读取 STATE.md，Health Status 无具体脚本名、endpoint 名、版本号                                                             |
| 25  | STATE.md Health Status 指向 global_health.json 和 network_status.md                                     | 读取 STATE.md，含指向全局文件的链接                                                                                        |
| 26  | health check 全部通过时 STATE.md Next Action 不更新                                                     | 模拟全部通过场景，Next Action 保持原 workflow 值不变                                                                       |
| 27  | health check 发现 degradation 时 STATE.md Next Action 更新为 degradation 概要 + 指向 global_health.json | 模拟 uv 不可用，Next Action 变为 "health check: infrastructure degraded (uv) → 详情见 ~/.aether/health/global_health.json" |
| 28  | degradation 解除后 STATE.md Next Action 恢复到原 workflow 值                                            | 用户安装 uv 后 worker 重新检测通过，coordinator 从 Blockers 恢复 Next Action                                               |
| 29  | 用户请求"检查环境"时 STATE.md Next Action 不更新                                                        | 在活跃 phase 中请求 health check，Next Action 保持不变                                                                     |
| 30  | degradation 时原 Next Action 备份到 STATE.md Blockers section                                           | 模拟 degradation，Blockers 出现 health_degradation 条目                                                                    |
| 31  | research-worker.md Phase Routing 包含 health_check 行                                                   | 读取 research-worker.md，Phase Routing table 有 health_check 行                                                            |
| 32  | research-worker.md 包含 health_check 模式执行协议                                                       | 读取 research-worker.md，有 health_check 模式的 MCP 调用 + cross-MCP 仲裁 + digest 输出步骤                                |
| 33  | worker health_check digest 包含 degradation_summary 和 failed_items                                     | 模拟检测场景，worker digest 含 degradation_summary（各层状态）+ failed_items（含 auto_installable/priority）               |
| 34  | worker health_check 模式不调用 advance_plan                                                             | 执行 health_check 模式，digest 的 next_phase=null，state.json phase 不变                                                   |
| 35  | worker health_check 模式写入项目内临时文件（不超出 file_scope）                                         | 执行 health_check 模式，.health_global.json 和 .health_network.md 写入 .aether/research/ 下                                |
| 36  | coordinator 处理 health_check digest 后正确更新 STATE.md                                                | 模拟 degradation digest，coordinator 更新 STATE.md Health Status + Blockers + Next Action                                  |
| 37  | coordinator 将临时文件迁移至 ~/.aether/health/ 并删除临时文件                                           | 执行完整 health_check 流程，global_health.json 和 network_status.md 出现在 ~/.aether/health/，临时文件已删除               |
| 38  | Tier 0.5 预创建 ~/.aether/health/ 空占位文件，后续覆写不再触发权限申请                                  | 首次会话观察权限申请弹窗一次，第二次 health check 覆写同文件时无弹窗                                                       |
| 39  | alpha_cli 区分 not_installed vs not_authenticated                                                       | alpha CLI 未安装时 failure_class=not_installed，已安装但未认证时 failure_class=not_authenticated                           |
| 40  | health-check skill 存在且包含 6 步执行协议                                                              | 查找 `.aether/skills/health-check/SKILL.md`，含 Step 1-6 + PhaseResultDigest 输出                                          |
| 41  | research-worker.md skill_refs 包含 health-check                                                         | 读取 research-worker.md，skill_refs 列表有 health-check                                                                    |
| 42  | cache_check.sh 由 seedDefaultAssets() 同步至 ~/.aether/health/                                          | 首次 CLI 启动后 ~/.aether/health/cache_check.sh 存在且可执行                                                               |
| 43  | seedDefaultAssets() 包含 health subdir 同步                                                             | 读取 migrate.ts，subdirs 列表含 "health"（条件：.aether/health/ 存在）                                                     |
