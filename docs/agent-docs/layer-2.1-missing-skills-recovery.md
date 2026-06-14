# Layer 2.1: Missing Skills & Agent Recovery

> **PARTIALLY SUPERSEDED**: [Layer 3.9](layer-3.9-remove-sandbox-add-local-compile.md) — sandbox-executor subagent 补齐说明已过时（agent 已移除）。

> 前置依赖: Layer 2（Research Config Layer）已完成基本 agent/skills 结构修复
> 本文档补齐 Layer 2 设计文档中引用但当前分支缺失的 skills，并新增 sandbox-executor subagent。
> 缺失原因：Layer 2 设计文档基于 `feat/research-agent` 分支制定，但实际实现在新分支进行，导致 `feat/research-agent` 上已有的 skills 在新分支上缺失。

---

## 变更清单

| 变更项                | 类型            | feat/research-agent 状态                | 当前分支状态 | 操作                        |
| --------------------- | --------------- | --------------------------------------- | ------------ | --------------------------- |
| **paper-search**      | Skill           | 已存在（arXiv API + alphaxiv webfetch） | **存在**     | 无需端口                    |
| **docker**            | Skill           | 已存在（完整 Feynman docker 内容）      | **缺失**     | 从 feat/research-agent 端口 |
| **source-comparison** | Skill           | 已存在（mode-aware 实现）               | **缺失**     | 从 feat/research-agent 端口 |
| **paper-code-audit**  | Skill           | 已存在（mode-aware 实现）               | **缺失**     | 从 feat/research-agent 端口 |
| **sandbox-executor**  | Subagent (新增) | 不存在（原设计为 execute-docker skill） | **缺失**     | 新建 agent 定义文件         |

> **设计变更说明**：原 Layer 2 设计文档中的 `execute-docker` 是一个**工作流 skill**。经分析后改为 **sandbox-executor subagent**。理由：
>
> 1. 执行编排是一个独立的角色（准备 sandbox → 运行 → 收集 → 验证），不应让主 agent 分心
> 2. 执行输出可能很大，作为 subagent 不会污染主 agent context window
> 3. sandbox-executor 的 skill 需求很窄（docker + research-verification），角色清晰
> 4. 与研究系 subagent 角色框架一致：research-explorer 负探索，gpd-verifier 负验证，gpd-reviewer 负评审，**sandbox-executor 负执行**
> 5. 命名从 execute-docker 改为 sandbox-executor，因为 sandbox 有多种实现方式，docker 只是其中一种
> 6. sandbox-executor 需要 research-conventions MCP（读取约定状态确保执行环境与约定一致），但**只读不写**（convention lock 写入留给 gpd-verifier）

---

## 关于 category 字段

feat/research-agent 分支上的 skill frontmatter 包含 `category: Research` 字段。经分析：

- **来源**：社区版 OpenCode skill 格式标准，用于 UI 分组显示
- **Aether 核心代码**：Skill.Info schema 只认 `name` 和 `description`（`skill/index.ts:28-33`），`category` 不在 schema 中，解析时使用 `Info.pick({ name: true, description: true }).safeParse(md.data)`，`category` 被静默忽略
- **Config.Agent knownKeys**：`category` 不在白名单中，出现在 agent YAML frontmatter 时归入 `options`（无注入机制）
- **移除副作用**：零。`category` 不参与 skill 发现、注入、权限过滤等任何运行时流程
- **不移除需要什么**：将 `category` 加入 Skill.Info schema + UI 分组显示功能

**决策**：移除 `category` 字段，保持 frontmatter 洁。不移除也完全无害，但移除避免误解（让人以为 category 有实际功能）。

---

## 2.1.1 paper-search Skill

### 来源

已存在于 `.aether/skills/paper-search/SKILL.md`（原 `alpha-research` skill 经 Layer 3.13 规范更新为 `paper-search`）

### 适配要点

- 目录从 `.aether/skills/alpha-research/` → `.aether/skills/paper-search/`
- skill name 从 `alpha-research` → `paper-search`
- alpha CLI 命令全部移除（不存在），替换为 arXiv API 搜索 + alphaxiv webfetch 深度理解
- Frontmatter 无 `category` 字段（非 Skill.Info schema 字段）

### 文件

`.aether/skills/paper-search/SKILL.md`

### SKILL.md 核心功能（无 alpha CLI）

````md
---
name: paper-search
description: Search, read, and analyze research papers via arXiv API and alphaxiv webfetch. Use for academic paper search, full-text reading via alphaxiv overview, and citation extraction.
---

# Paper Search

Use arXiv API for search and alphaxiv webfetch for deep paper understanding.

## Search (arXiv API)

Search papers using the arXiv API:

```bash
curl "http://export.arxiv.org/api/query?search_query=all:transformer+scaling+laws&max_results=10"
```

## Deep Understanding (alphaxiv)

After obtaining arXiv IDs from search, for papers requiring deeper analysis:

1. Construct alphaxiv overview URL: `https://alphaxiv.org/overview/<arxiv_id>`
2. Use webfetch to retrieve the overview page
3. The overview provides structured: Key Findings, Methodology, Limitations, Broader Impact
4. Use overview content for research synthesis instead of relying solely on abstracts

Fallback: if alphaxiv overview is unavailable, use the arXiv abstract from search results.

## When to use

- Academic paper search, reading → paper-search skill (arXiv API + alphaxiv webfetch)
- Current topics (products, releases, docs) → `websearch`
- Mixed topics → combine both
````

---

## 2.1.2 docker Skill

### 来源

`feat/research-agent` 分支 `.opencode/skills/docker/SKILL.md`（完整 Feynman docker 内容）

### 适配要点

- 目录从 `.opencode/skills/` → `.aether/skills/`
- Frontmatter 移除 `category: Research`（非 Skill.Info schema 字段，被静默忽略）
- 内容无需修改，完整的 docker sandbox 指引（GPU、持久容器、base image、网络隔离）

### 文件

`.aether/skills/docker/SKILL.md`

### SKILL.md 内容（从 feat/research-agent 端口，移除 category）

````md
---
name: docker
description: Execute research code inside isolated Docker containers for safe replication, experiments, and benchmarks. Use when the user selects Docker as the execution environment or asks to run code safely, in isolation, or in a sandbox.
---

# Docker Sandbox

Run research code inside Docker containers while the agent stays on the host. The container gets the project files, runs the commands, and results sync back.

## When to use

- User selects "Docker Sandbox" as the execution environment for replication or experiments
- Running untrusted code from a paper's repository
- Experiments that install packages or modify system state
- Any time the user asks to run something "safely" or "isolated"

## Running commands in a container

For Python research code (most common):

```bash
docker run --rm -v "$(pwd)":/workspace -w /workspace python:3.11 bash -c "
  pip install -r requirements.txt &&
  python train.py
"
```
````

For projects with a Dockerfile:

```bash
docker build -t experiment .
docker run --rm -v "$(pwd)/results":/workspace/results experiment
```

For GPU workloads:

```bash
docker run --rm --gpus all -v "$(pwd)":/workspace -w /workspace pytorch/pytorch:latest bash -c "
  pip install -r requirements.txt &&
  python train.py
"
```

## Choosing the base image

| Research type  | Base image                                                     |
| -------------- | -------------------------------------------------------------- |
| Python ML/DL   | `pytorch/pytorch:latest` or `tensorflow/tensorflow:latest-gpu` |
| Python general | `python:3.11`                                                  |
| Node.js        | `node:20`                                                      |
| R / statistics | `rocker/r-ver:4`                                               |
| Julia          | `julia:1.10`                                                   |
| Multi-language | `ubuntu:24.04` with manual installs                            |

## Persistent containers

For iterative experiments (like autoresearch), create a named container instead of --rm:

```bash
docker create --name <name> -v "$(pwd)":/workspace -w /workspace python:3.11 tail -f /dev/null
docker start <name>
docker exec <name> bash -c "pip install -r requirements.txt"
docker exec <name> bash -c "python train.py"
```

This preserves installed packages across iterations. Clean up with:

```bash
docker stop <name> && docker rm <name>
```

## Notes

- The mounted workspace syncs results back to the host automatically
- Containers are network-enabled by default — add `--network none` for full isolation
- For GPU access, Docker must be configured with the NVIDIA Container Toolkit

````

---

## 2.1.3 source-comparison Skill

### 来源

`feat/research-agent` 分支 `.opencode/skills/source-comparison/SKILL.md`

### 适配要点

- 目录从 `.opencode/skills/` → `.aether/skills/`
- Frontmatter 移除 `category: Research`（非 Skill.Info schema 字段，被静默忽略）
- 内容无需修改，mode-aware 设计完整

### 文件

`.aether/skills/source-comparison/SKILL.md`

### SKILL.md 内容（从 feat/research-agent 端口，移除 category）

```md
---
name: source-comparison
description: Compare multiple sources on a topic and produce a grounded comparison matrix. Use when comparing papers, tools, approaches, or claims across sources.
---

# Source Comparison

Compare sources for: $@

Derive a short slug from the comparison topic (lowercase, hyphens, no filler words, ≤5 words). Use this slug for all output files.

## In Research Mode

If you are in research mode (the research agent), follow the full research workflow:

1. Classify intent as methodology-comparison in Phase 0 (Intent Gate).
2. Plan comparison dimensions and sources. Write plan to outputs/.plans/<slug>.md.
3. Dispatch researcher subagents to gather evidence for each source.
4. Build the comparison matrix covering: source, key claim, evidence type, caveats, confidence.
5. Dispatch verifier subagent for citation anchoring.
6. Deliver to outputs/<slug>-comparison.md with provenance sidecar.

## In Other Modes

If you are not in research mode (e.g., build or plan mode), do an inline comparison:

1. Use websearch/webfetch to gather source material directly.
2. Delegate literature search to research-explorer subagent (paper-search skill).
3. Build a comparison matrix: source, key claim, evidence type, caveats, confidence.
4. Distinguish agreement, disagreement, and uncertainty clearly.
5. Present the comparison inline. Optionally write to a file if the comparison is large.

## Comparison Matrix Format

| Source          | Key Claim | Evidence Type                   | Caveats | Confidence      |
| --------------- | --------- | ------------------------------- | ------- | --------------- |
| [1] Paper A     | ...       | primary/secondary/self-reported | ...     | high/medium/low |
| [2] Tool B docs | ...       | ...                             | ...     | ...             |

For quantitative metrics, generate charts if possible.
For method/architecture comparisons, use Mermaid diagrams.

End with a Sources section containing direct URLs for every source used.
````

---

## 2.1.4 paper-code-audit Skill

### 来源

`feat/research-agent` 分支 `.opencode/skills/paper-code-audit/SKILL.md`

### 适配要点

- 目录从 `.opencode/skills/` → `.aether/skills/`
- Frontmatter 移除 `category: Research`（非 Skill.Info schema 字段，被静默忽略）
- 内容无需修改，mode-aware 设计完整

### 文件

`.aether/skills/paper-code-audit/SKILL.md`

### SKILL.md 内容（从 feat/research-agent 端口，移除 category）

```md
---
name: paper-code-audit
description: Compare a paper's claims against its public codebase and identify mismatches, omissions, and reproducibility risks. Use for auditing papers, checking code-claim consistency, and verifying reproducibility.
---

# Paper-Code Audit

Audit the paper and codebase for: $@

Derive a short slug from the audit target (lowercase, hyphens, no filler words, ≤5 words).

## In Research Mode

If you are in research mode (the research agent), follow the full research workflow:

1. Classify intent in Phase 0 (Intent Gate).
2. Plan audit: identify paper claims and corresponding code. Write plan to outputs/.plans/<slug>.md.
3. Dispatch researcher subagents to:
   - Read the paper (delegate to research-explorer subagent with paper-search skill)
   - Inspect the code repo (use webfetch to read GitHub repo files)
4. Compare claimed methods, defaults, metrics, and data handling against actual code.
5. Call out: missing code, mismatches, ambiguous defaults, reproduction risks.
6. Dispatch verifier subagent for citation anchoring.
7. Deliver to outputs/<slug>-audit.md with provenance sidecar.

## In Other Modes

If you are not in research mode:

1. Use webfetch to read the paper (arxiv HTML or PDF).
2. Use webfetch to read the repo files directly.
3. Compare claims vs code inline.
4. Present findings inline or write to a file.

## Audit Dimensions

- **Method match**: Does the code implement what the paper describes?
- **Default divergence**: Do code defaults differ from paper-reported settings?
- **Metric consistency**: Are evaluation metrics computed the same way?
- **Data handling**: Is dataset processing consistent between paper description and code?
- **Missing code**: Are any claimed features or experiments not present in the repo?
- **Reproduction risk**: Can the results be reproduced from the code alone?

End with a Sources section containing paper URL and repository URL.
```

---

## 2.1.5 sandbox-executor Subagent（新增）

### 来源

全新创建。原 Layer 2 设计文档中的 `execute-docker` 是工作流 skill，经分析改为 **sandbox-executor subagent**。

### 设计决策

| 维度           | Skill 方案                                        | Subagent 方案（选定）                                     |
| -------------- | ------------------------------------------------- | --------------------------------------------------------- |
| 角色定位       | 主 agent 自行编排，skill 提供流程指引             | 独立角色：准备 sandbox → 执行 → 收集 → 验证               |
| context 影响   | 执行输出占用主 agent context window               | 隔离执行，主 agent 只看摘要 + 读 output_dir               |
| skill 需求     | 无额外 skill_refs（主 agent 自由使用所有 skills） | 精确 skill_refs: docker + research-verification           |
| permission     | 继承主 agent permission（过宽）                   | 精确 env_scope: docker/uv/python/pip/curl/git             |
| 命名           | execute-docker（强调 docker）                     | sandbox-executor（通用 sandbox 概念）                     |
| convention MCP | 不需要（主 agent 自己处理）                       | 需要 research-conventions（只读），确保执行环境与约定一致 |

**为什么不选 Skill 方案**：

1. 执行编排是独立角色，不应让主 agent 分心
2. 执行输出可能很大，占用主 agent context window
3. 主 agent 不是专门做执行编排的，流程指引只是 SKILL.md 文本

**为什么不选"调度 general subagent 加 docker skill"**：

1. general 不是研究系 agent，没有 env_scope 限制，权限过宽
2. general 没有 convention 意识

**与研究系 subagent 角色框架的对应**：

| 角色     | Subagent                         | 职责                                                       |
| -------- | -------------------------------- | ---------------------------------------------------------- |
| 探索     | research-explorer                | 文献搜索、证据收集、来源验证                               |
| 验证     | research-verifier / gpd-verifier | 合约验证、确定性计算、convention 检查                      |
| 评审     | gpd-reviewer                     | 方法论评审、错误模式筛查                                   |
| **执行** | **sandbox-executor**             | **sandbox 准备、计划执行、结果收集、acceptance test 对照** |

### 与主 agent 的关联机制

主 agent research.md 通过 `task: allow` permission + Mode Routing 文本声明可调度 sandbox-executor：

- HARD CONSTRAINTS: `task (research-explorer/gpd-verifier/gpd-reviewer/sandbox-executor)` ← 需更新
- Mode Routing: `**Experiment execution** → Dispatch sandbox-executor subagent via task tool.` ← 需更新

### 文件

`.aether/agent/sandbox-executor.md`（flat 结构，无前缀——通用执行器，非物理领域专用）

### Agent 定义内容（新建）

````md
---
description: Execute research plans in isolated sandbox environments and verify results against acceptance tests
color: "#059669"
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
  research_state_*: allow
skill_refs:
  - docker
  - research-verification
mcp:
  research-conventions: true
  research-state: true
env_scope:
  allowed_commands:
    - docker
    - uv
    - python
    - pip
    - curl
    - git
output_dir: ".aether/research"
fallback_models:
  - anthropic/claude-sonnet-4-5
---

<system-reminder>
# Sandbox Executor Role

Execute research plans in isolated sandbox environments and verify results against acceptance tests.

## Convention Awareness

Read convention state via research-conventions MCP before execution. Convention values (metric signature, natural units, etc.) affect numerical verification expectations. You **read** convention locks but **never write** them — convention lock mutations belong to gpd-verifier.

## Execution Protocol

### Step 1: Read Plan Contract

Read PLAN.md contract section. Extract:

- Execution commands (what to run)
- Acceptance tests (how to verify results)
- Deliverables (expected output files)
- Environment requirements (Python version, GPU needed, dependencies)

### Step 2: Prepare Sandbox

Use the docker skill to select base image and prepare container:

1. Match environment requirements to a base image (see docker skill image table)
2. For GPU workloads: use `--gpus all`
3. For iterative execution: create persistent container (`docker create`)
4. For single-run execution: use `docker run --rm`
5. Mount project directory: `-v "$(pwd)":/workspace -w /workspace`

### Step 3: Install Dependencies

```bash
docker exec <container> bash -c "pip install -r requirements.txt"
```
````

### Step 4: Execute Commands

Run each execution command from the plan contract:

```bash
docker exec <container> bash -c "<command>"
```

Capture stdout/stderr. Record execution time and resource usage if possible.

### Step 5: Collect Results

Copy output files from container to host:

```bash
docker cp <container>:/workspace/<output_path> ./<local_path>
```

For `--rm` containers, results in the mounted workspace sync automatically.

### Step 6: Verify Against Acceptance Tests

For each acceptance_test in the plan contract:

- If test is a script command: run it in the container
- If test is a numerical comparison: compare actual vs expected values
- If test is a file existence check: verify the file exists and is non-empty
- If test is a benchmark comparison: compare against known values

Record verdict for each test: PASS / FAIL / INCONCLUSIVE.

### Step 7: Report

Write execution report to `.aether/research/persistence/EXECUTION.md`:

```md
## Execution Report

**Container**: <image>, <mode (--rm or persistent)>
**Plan**: PLAN.md contract reference
**Conventions**: <current convention lock summary>
**Duration**: <execution time>

### Results

| Command | Status | Duration | Output |
| ------- | ------ | -------- | ------ |

### Acceptance Tests

| Test | Expected | Actual | Verdict |
| ---- | -------- | ------ | ------- |

### Summary

<pass_count>/<total_count> tests passed.
```

### Step 8: Cleanup

For persistent containers:

```bash
docker stop <container> && docker rm <container>
```

## Integrity

- Do not skip acceptance test verification
- Do not run commands outside sandbox when plan specifies isolated execution
- Do not leave containers running after execution (always cleanup)
- Do not assume results are correct without verification
- Do not write to convention lock (only read)
  </system-reminder>

```

---

## 验收测试

```

T2.1.1: paper-search SKILL.md 存在于 .aether/skills/paper-search/
T2.1.2: docker SKILL.md 存在于 .aether/skills/docker/，GPU/persistent container/base image 内容完整
T2.1.3: source-comparison SKILL.md 存在于 .aether/skills/source-comparison/，mode-aware 设计完整
T2.1.4: paper-code-audit SKILL.md 存在于 .aether/skills/paper-code-audit/，mode-aware 设计完整
T2.1.5: sandbox-executor.md 存在于 .aether/agent/sandbox-executor.md，subagent 定义完整
T2.1.6: sandbox-executor skill_refs 包含 docker + research-verification
T2.1.7: sandbox-executor env_scope 限制 bash 到 docker/uv/python/pip/curl/git
T2.1.8: sandbox-executor mcp 包含 research-conventions (只读) + research-state
T2.1.9: research-explorer skill_refs 包含 paper-search
T2.1.10: 所有端口 skill 的 frontmatter 无 category 字段
T2.1.11: 删除新增 skills 和 sandbox-executor 后，核心行为不变

```

---

## 实现顺序

| 步骤 | 操作 | 文件 |
|------|------|------|
| 2 | 从 feat/research-agent 端口 docker（移除 category） | `.aether/skills/docker/SKILL.md` |
| 3 | 从 feat/research-agent 端口 source-comparison（移除 category） | `.aether/skills/source-comparison/SKILL.md` |
| 4 | 从 feat/research-agent 端口 paper-code-audit（移除 category） | `.aether/skills/paper-code-audit/SKILL.md` |
| 5 | 新建 sandbox-executor subagent 定义 | `.aether/agent/sandbox-executor.md` |
```
