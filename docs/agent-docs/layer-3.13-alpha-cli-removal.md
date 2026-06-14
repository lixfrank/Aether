# Layer 3.13: Alpha CLI 移除与 paper-search Skill 重构

> 前置依赖: Layer 0-3.12（所有已完成层）
> 改动范围: `.aether/` 内的 skills、MCP server、agent 配置、`docs/agent-docs/`、`packages/opencode/test/`。测试以外零核心源文件改动（`packages/opencode/src/` 无需修改）。

---

## 1. 问题分析

### 1.1 核心问题

SKILL.md 中引用的 `alpha` CLI 命令（`alpha status`, `alpha search`, `alpha get`, `alpha ask`, `alpha code`, `alpha annotate`, `alpha login`）**不存在**——无独立 CLI 工具可安装或使用。

### 1.2 调查事实

| 事实                                                | 证据                                                                |
| --------------------------------------------------- | ------------------------------------------------------------------- |
| `alpha` 命令不存在于 PATH                           | `which alpha` → not found                                           |
| 无 npm 包 `@anthropic/alpha`                        | PyPI/GitHub 404                                                     |
| 无 pip 包 `alpha`                                   | `pip show alpha` → not found                                        |
| `alphaxiv` PyPI 包 (v0.0.13) 存在                   | pypi.org/project/alphaxiv — 仅用于 compute 功能，非论文搜索/Q&A     |
| `alphaxiv` 命令名是 `alphaxiv`（非 `alpha`）        | PyPI 包安装后提供 `alphaxiv` 命令                                   |
| alphaxiv.org 无公开 REST API                        | `curl alphaxiv.org/api/*` → 404 或 HTML SPA                         |
| `install_registry.json` 中 `alpha_cli` 安装命令虚构 | `brew install alpha` / `npm install -g @anthropic/alpha` 都不存在   |
| MCP server.py 硬编码调用 `alpha status`             | L676: `_run_cmd(["alpha", "status"])` — 永远返回 fail/not_installed |

### 1.3 影响范围

| 类别                                                         | 文件数 | 运行时影响                                                                                          |
| ------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------- |
| `.aether/skills/alpha-research/SKILL.md`                     | 1      | **运行时** — SkillLoader 加载，43 处 alpha 引用                                                     |
| `.aether/skills/arxiv-search/` (废弃目录)                    | 2      | **运行时** — skill_refs 引用，需删除                                                                |
| `.aether/skills/paper-code-audit/SKILL.md`                   | 1      | **运行时** — 3 处 alpha 命令引用 (L19/20/31)                                                        |
| `.aether/skills/env-setup/SKILL.md`                          | 1      | **运行时** — 1 处 alpha login 引用 (L60)                                                            |
| `.aether/skills/env-setup/references/install_registry.json`  | 1      | **运行时** — health_check MCP 读取，13 行 alpha_cli 注册项 (L39-51)                                 |
| `.aether/skills/health-check/SKILL.md`                       | 1      | **运行时** — 3 处 alpha_cli 检查项 (L90/140/146)                                                    |
| `.aether/skills/literature-landscape-scan/SKILL.md`          | 1      | **运行时** — 6 处 alpha/alphaxiv 引用 (L10/60/69/70/84/85)                                          |
| `.aether/skills/literature-review/SKILL.md`                  | 1      | **运行时** — 2 处 alpha/alphaxiv 引用 (L59/74)                                                      |
| `.aether/skills/deep-research/SKILL.md`                      | 1      | **运行时** — 2 处 alpha/alphaxiv 引用 (L49/232)                                                     |
| `.aether/skills/research-audit/SKILL.md`                     | 1      | **运行时** — 5 处 alphaxiv 引用 (L98/99/152/166/224)                                                |
| `.aether/skills/research-audit-repair/SKILL.md`              | 1      | **运行时** — 5 处 alpha/alphaxiv 引用 (L7/53/66/68/127/129)                                         |
| `.aether/skills/research-audit-repair-reasoning/SKILL.md`    | 1      | **运行时** — 2 处 alpha/alphaxiv 引用 (L163/165)                                                    |
| `.aether/skills/source-comparison/SKILL.md`                  | 1      | **运行时** — 1 处 alpha CLI 引用 (L28)                                                              |
| `.aether/skills/literature-review/scripts/download_paper.py` | 1      | **运行时** — 需迁移到 paper-search                                                                  |
| `.aether/mcp/research-state/server.py`                       | 1      | **运行时** — 17 处 alpha 引用（5 个区域），虚构命令阻断下游层                                       |
| `.aether/agent/*.md`                                         | 3      | **运行时** — agent context 注入，9 处 (research.md 6, research-explorer.md 2, research-worker.md 1) |
| `packages/opencode/test/`                                    | 7      | **运行时** — 测试断言引用虚构 skill/命令，19 处                                                     |
| `docs/agent-docs/*.md` (排除本计划文档)                      | 12     | **非运行时，但必须修改** — 系统架构权威描述，含 ~150+ 处 alpha/alphaxiv/alpha_cli 引用              |

> docs 不被运行时系统读取，但它们是 agent 配置和 MCP 修改的设计依据、验收测试的参考标准。只有 `.aether/skills/*/SKILL.md` 和 `.aether/agent/*.md` 被运行时加载。

### 1.4 可用替代方案

| 方案                                  | 可用性                              | 功能范围                                       |
| ------------------------------------- | ----------------------------------- | ---------------------------------------------- |
| arXiv API (`arxiv_search.py`)         | 完全可用 — `uv run` 自动安装依赖    | 关键词搜索，arXiv category 过滤                |
| alphaxiv web overview                 | 部分可用 — webfetch 可获取部分 HTML | 结构化论文理解                                 |
| Semantic Scholar API (`s2_search.py`) | 本次实现 — 无认证，`requests`-only  | 全文搜索，引用数，领域分类，arXiv/DOI 交叉引用 |
| INSPIRE-HEP API (`inspire_search.py`) | 本次实现 — 无认证，`requests`-only  | 物理学搜索，SPIRES 语法，BibTeX                |
| PubMed API (`pubmed_search.py`)       | 本次实现 — 无认证，`requests`-only  | 生物医学搜索，MeSH 术语，PMID/DOI              |
| alphaxiv PyPI CLI                     | 不适用 — 仅用于 experiments/compute | 无 search/get/ask                              |

---

## 2. 设计决策

| #   | 决策                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 理由                                                                                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | 重命名 `alpha-research` skill 为 `paper-search`；删除 `.aether/skills/arxiv-search/` 废弃目录                                                                                                                                                                                                                                                                                                                                                                        | 旧名暗示依赖 alpha CLI；废弃目录仅含重定向文本和重复脚本                                                                                                                |
| D2  | 完全删除所有 `alpha` CLI 相关内容；env_scope allowed_commands `"alpha"` → `"uv"`；从 `install_registry.json` 移除 `alpha_cli`；从 MCP 区域 A 删除 `alpha_cli` 检测，**替换为** 4 个新增网络可达性检查（S2, PubMed, alphaxiv, Crossref；infrastructure 层原有的 3 个网络检测 arxiv/semantic_scholar/inspire_hep 保留不变，共 7 个）；所有 `alpha-research` → `paper-search` 重命名；所有 `alpha CLI` 功能描述 → webfetch/arxiv_search.py 替代；所有 docs/测试同步更新 | alpha CLI 不存在——虚构命令误导 agent、阻断 MCP 下游层、安装命令虚构；4 个新增网络检查确保 paper-search 所需 API 全部可达                                                |
| D3  | 保留 `arxiv_search.py` 和 alphaxiv webfetch                                                                                                                                                                                                                                                                                                                                                                                                                          | 实际可用                                                                                                                                                                |
| D4  | 新增 `inspire_search.py`、`s2_search.py`、`pubmed_search.py`、`extract_citations.py`；`download_paper.py` 从 literature-review 迁移到 paper-search（删除原文件），扩展 source-first 下载                                                                                                                                                                                                                                                                             | 覆盖物理/全学科/生物医学+引用提取；消除两套下载脚本重复维护                                                                                                             |
| D5  | 所有外部 skill/agent 的 alphaxiv/INSPIRE-HEP/Semantic Scholar/PubMed 直接引用 → 对 paper-search skill 的委托；**外部 skill 仅描述搜索意图和领域**（如"搜索 hep-ph dark matter"），paper-search 内部根据意图自动选择数据库和 Mode；引用链扩展严格限制（D21）；引用链限制规则权威定义在 SKILL.md §Mode 4                                                                                                                                                               | 论文搜索在 paper-search 内部自洽定义；外部不应指定具体数据库模式（避免 skill 间语义耦合）；bib 扩展呈指数增长                                                           |
| D6  | MCP 功能检测保留实际运行 arxiv_search.py 做健康测试（区域 D）；新增 INSPIRE-HEP/S2/PubMed 网络可达性检查                                                                                                                                                                                                                                                                                                                                                             | 功能检测确保 API 可用性；与现有 `network_arxiv` 检查对齐                                                                                                                |
| D7  | paper-search skill 必须通过 research-explorer subagent 调用，而非 primary agent 直接调用 skill tool。primary agent/coordinator 描述搜索意图，dispatch research-explorer subagent（skill_refs 含 paper-search），subagent 加载 paper-search skill 并执行搜索。这与现有文献搜索架构一致：deep-research/literature-review/literature-landscape-scan 均通过 research-explorer subagent 执行数据库搜索。                                                                  | 与现有 subagent 搜索架构对齐；primary agent 不直接加载 skill 执行搜索（仅协调）；research-explorer skill_refs 已含 paper-search（改名后），无需修改 skill_refs 列表内容 |

---

## 3. paper-search Skill 规格

### 3.1 目录操作

```bash
mv .aether/skills/alpha-research .aether/skills/paper-search
rm -rf .aether/skills/arxiv-search
```

### 3.2 SKILL.md — 完整重写

**frontmatter**: `name: paper-search`, description 概述 4 个 Mode + source-first + 默认下载目录。

**必须包含的结构**:

| Section                                           | 内容要点                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **sole entry point 声明**                         | "Other skills/agents must delegate to paper-search rather than directly calling alphaxiv, INSPIRE-HEP, S2, or PubMed."                                                                                                                                                                                                       |
| **Mode 1: Multi-Database Search**                 | 1a arXiv (arxiv_search.py, category prefixes, search format examples), 1b INSPIRE-HEP (inspire_search.py, SPIRES syntax, rate limit 15 req/5s), 1c Semantic Scholar (s2_search.py, 无认证), 1d PubMed (pubmed_search.py, MeSH, rate limit 3 req/s); Search Mode Selection 表 (Domain → Recommended modes)                    |
| **Mode 2: Paper Download**                        | source-first policy (tex 优先于 PDF); download_paper.py 的 --arxiv/--doi/--batch/--output/--prefer-source/--prefer-pdf 参数; 每论文子目录输出结构 (source.tar.gz, main.tex, paper.pdf, references.bib, meta.json); index.json (含 has_source/source_files/tex_path/bib_path); unavailable.md; 使用 read 工具读本地 .tex/.pdf |
| **Mode 3: Citation Extraction**                   | extract_citations.py 的 --paper-dir/--arxiv/--output/--include-non-arxiv/--format json                                                                                                                                                                                                                                       | batch 参数; json 输出格式 (source_paper, citations, stats); 边缘情况 (no .bib → error, old arXiv IDs → correct); arXiv ID 提取优先级 (eprint+archiveprefix → eprint+eprinttype → bare eprint+regex → url 含 arxiv.org → journal 含 arXiv:); DOI 提取 (doi 字段 → url 中 doi.org/) |
| **Mode 4: Citation Discovery (STRICTLY LIMITED)** | 仅从 2-3 篇已确认高度相关的核心论文扩展; depth ≤1（depth=2 仅对奠基性工作）; 每轮 5-15 篇; >20 篇立即停止; 每个被引论文必须先获取摘要判断相关性; workflow: Search → screen → identify core → download source → extract citations → screen by abstract → download relevant                                                    |
| **alphaxiv Web Overview**                         | 仅内部使用: overview URL + smart search URL; "External skills/agents should delegate to paper-search rather than calling alphaxiv directly."                                                                                                                                                                                 |
| **Usage Decision Flow**                           | 6 条规则 (search → download → alphaxiv → extract → discover → smart search)                                                                                                                                                                                                                                                  |
| **Default Download Directory**                    | Path 1 `.aether/literatures`, Path 2 `.aether/research/notepads/<slug>/literatures`, Path 3 `.aether/research/literatures`                                                                                                                                                                                                   |
| **Dependencies**                                  | 6 个脚本的 PEP 723 依赖表                                                                                                                                                                                                                                                                                                    |

**删除内容**（相对于原 alpha-research/SKILL.md）: `alpha status` 命令 (L15)、Alpha CLI Mode section (L18-31)、Mode Selection (L10-17)、Mode Decision Flow (L80-89)、AlphaXiv Account Setup (L92-109)、alpha login 流程 (L97-100)、Alpha CLI Mode Examples (L127-134)、CLI authed row (L114)、"Do NOT silently skip alpha CLI mode" (L91)

**SKILL.md 骨架模板**（执行时的最小结构要求）:

```markdown
---
name: paper-search
description: |
  Multi-database paper search, download (source-first), citation extraction,
  and citation discovery (strictly limited). Four modes: (1) Multi-Database
  Search, (2) Paper Download, (3) Citation Extraction, (4) Citation Discovery.
  Default download directory varies by Path (1/2/3).
---

# paper-search Skill

> **Sole entry point**: Other skills/agents must delegate to paper-search
> rather than directly calling alphaxiv, INSPIRE-HEP, Semantic Scholar, or
> PubMed APIs. paper-search decides which database(s) to use based on the
> search intent and domain described by the caller.
>
> **Invocation protocol (D7)**: paper-search skill is loaded and invoked by
> the research-explorer subagent. Primary agent/coordinator dispatches
> research-explorer with a search intent description; research-explorer
> loads paper-search skill and executes the appropriate mode. Direct
> invocation by primary agent via skill tool is NOT the intended usage
> pattern — it only applies in Path 1 (Quick Lookup) where the primary
> agent is the research agent itself and uses paper-search for a single
> factual lookup.

## Invocation Protocol

External skills/agents describe **search intent + domain** only (e.g. "search
hep-ph dark matter", "find papers on cancer immunotherapy"). paper-search
internally selects the appropriate database(s) and modes. Do NOT specify
Mode 1b/1c/1d from outside — paper-search routes automatically.

**Path 1 (Quick Lookup)**: Primary research agent directly invokes paper-search
skill for a single factual question. No subagent dispatch.

**Path 2/3 (Literature review / Research project)**: Coordinator dispatches
research-explorer subagent. research-explorer loads paper-search skill and
executes searches. Coordinator does NOT directly invoke paper-search.

## Mode 1: Multi-Database Search

### 1a arXiv Search

[arxiv_search.py usage, category prefixes, format examples]

### 1b INSPIRE-HEP Search

[inspire_search.py usage, SPIRES syntax, rate limit 15 req/5s]

### 1c Semantic Scholar Search

[s2_search.py usage, no auth required]

### 1d PubMed Search

[pubmed_search.py usage, MeSH terms, rate limit 3 req/s]

### Search Mode Selection

| Domain      | Recommended databases |
| ----------- | --------------------- |
| Physics     | arXiv + INSPIRE-HEP   |
| CS          | arXiv + S2            |
| Biomedical  | PubMed + S2           |
| Cross-field | S2 + arXiv            |

## Mode 2: Paper Download

[source-first policy, download_paper.py params, output structure, index.json]

## Mode 3: Citation Extraction

[extract_citations.py params, output format, edge cases]

## Mode 4: Citation Discovery (STRICTLY LIMITED)

[depth ≤1, 5-15 per round, >20 stop, workflow]

## alphaxiv Web Overview (internal only)

[overview URL + smart search URL; "External skills delegate to paper-search."]

## Usage Decision Flow

[6 rules: search → download → alphaxiv → extract → discover → smart search]

## Default Download Directory

| Path | Directory                                    |
| ---- | -------------------------------------------- |
| 1    | .aether/literatures                          |
| 2    | .aether/research/notepads/<slug>/literatures |
| 3    | .aether/research/literatures                 |

## Dependencies

[6 scripts PEP 723 dependency table]
```

### 3.3 新增脚本规格

| 脚本                   | API                                             | 认证 | PEP 723 依赖                          | 返回字段                                                           |
| ---------------------- | ----------------------------------------------- | ---- | ------------------------------------- | ------------------------------------------------------------------ |
| `inspire_search.py`    | `inspirehep.net/api/literature`                 | 无   | `requests>=2.31`                      | title, authors, arxiv_id, doi, citation_count, abstract, date      |
| `s2_search.py`         | `api.semanticscholar.org/graph/v1/paper/search` | 无   | `requests>=2.31`                      | title, abstract, year, citationCount, arxiv_id, doi, fieldsOfStudy |
| `pubmed_search.py`     | `eutils.ncbi.nlm.nih.gov` (ESearch+EFetch)      | 无   | `requests>=2.31`                      | pmid, title, authors, journal, year, doi, abstract                 |
| `extract_citations.py` | 本地 .bib 解析                                  | 无   | `bibtexparser>=1.4`, `requests>=2.31` | source_paper, citations[], stats (见 §3.2 Mode 3)                  |

**通用错误处理**（所有脚本共用）: 429 → `{"error": "rate_limited", "retry_after": N}`, 5xx → `{"error": "HTTP N"}`, JSON 解析失败 → `{"error": "json_parse_failed"}`, timeout=30 由顶层 try/except 捕获

### 3.4 download_paper.py — 从 literature-review 迁移

**操作**: `.aether/skills/literature-review/scripts/download_paper.py` → `.aether/skills/paper-search/download_paper.py`，删除原文件。

**扩展**: arXiv 下载从仅 PDF → source tarball 优先 (提取 .tex/.bib)；输出从平铺 → 每论文子目录；index.json 新增 has_source/source_files/tex_path/bib_path；新增 --prefer-source/--prefer-pdf 参数。

**调用方路径更新** (5 处):

| 调用方                                  | 原路径                                                  | 新路径                                         |
| --------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| literature-review/SKILL.md L93          | `.../literature-review/scripts/download_paper.py`       | `.../paper-search/download_paper.py`           |
| deep-research/SKILL.md L79              | 同上                                                    | 同上                                           |
| literature-landscape-scan/SKILL.md L107 | 同上                                                    | 同上                                           |
| research-audit/SKILL.md _(如有引用)_    | 同上                                                    | 同上                                           |
| server.py L1022                         | `"download_paper.py"` in literature-review scripts list | 从 literature-review scripts list 中删除此条目 |

---

## 4. Skill 外部改动清单

> paper-search 内部文件改动见 §3。以下仅列其他 skill 的逐行改动。

### 4.1 `.aether/skills/paper-code-audit/SKILL.md`

| 行号 | 原文                                                                | 改为                                                          |
| ---- | ------------------------------------------------------------------- | ------------------------------------------------------------- |
| L19  | `use alpha get / alpha ask for detailed Q&A`                        | `use webfetch alphaxiv overview for structured understanding` |
| L20  | `use alpha code for file-level inspection`                          | `use webfetch to read GitHub repo files`                      |
| L31  | `Use alpha code (if available) or webfetch to read the repo files.` | `Use webfetch to read the repo files directly.`               |

### 4.2 `.aether/skills/env-setup/SKILL.md`

| 行号 | 原文                                               | 改为                                                           |
| ---- | -------------------------------------------------- | -------------------------------------------------------------- |
| L60  | `they need to run manual_step (e.g., alpha login)` | `they need to run manual_step (e.g., web-based account setup)` |

### 4.3 `.aether/skills/env-setup/references/install_registry.json`

**操作**: 删除 `alpha_cli` 注册项（L39-51），仅保留 `uv`, `git`, `git_init` 三项。

### 4.4 `.aether/skills/health-check/SKILL.md`

| 行号 | 原文                                                       | 改为                                                                                                         |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| L90  | `"alpha_cli": { "status": "...", "authenticated": bool },` | **删除**整行，infrastructure checks 仅保留 uv/git/network                                                    |
| L140 | `alpha_cli → "partial"`                                    | **删除** alpha_cli 行，追加 `paper_search_scripts → true` (paper-search 脚本无需认证，全部 PEP 723 自动安装) |
| L146 | `alpha_cli → low`                                          | **删除** alpha_cli 行，追加 `paper_search_scripts → high` (论文搜索是 research agent 核心功能)               |

### 4.5 `.aether/skills/literature-landscape-scan/SKILL.md`

| 行号 | 原文                                                                       | 改为                                                                    |
| ---- | -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| L10  | `Integrates with alpha-research, alphaxiv, and research-question-framing.` | `Integrates with paper-search and research-question-framing.`           |
| L60  | `Physics: arXiv, INSPIRE-HEP, alphaxiv`                                    | `Physics: paper-search skill (arXiv + INSPIRE-HEP + alphaxiv overview)` |
| L69  | `Use alpha-research skill (no-login mode)`                                 | `Use paper-search skill`                                                |
| L70  | `alphaxiv Smart Search: For AI-enhanced discovery`                         | `Use paper-search skill for broader coverage`                           |
| L84  | `Use alphaxiv overview for structured understanding`                       | `Use paper-search skill for structured understanding`                   |
| L85  | `Fallback to arXiv abstract if alphaxiv overview unavailable`              | `Fallback to arXiv abstract via paper-search skill`                     |
| L107 | `uv run .aether/skills/literature-review/scripts/download_paper.py`        | `uv run .aether/skills/paper-search/download_paper.py`                  |

### 4.6 `.aether/skills/deep-research/SKILL.md`

| 行号 | 原文                                                                  | 改为                                                                 |
| ---- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| L49  | `use alpha-research skill for initial search, then alphaxiv overview` | `use paper-search skill for initial search and deeper understanding` |
| L79  | `uv run .aether/skills/literature-review/scripts/download_paper.py`   | `uv run .aether/skills/paper-search/download_paper.py`               |
| L232 | `alphaxiv overview: verify claims against original paper`             | `paper-search skill: verify claims against original paper`           |

### 4.7 `.aether/skills/literature-review/SKILL.md`

| 行号 | 原文                                                                | 改为                                                                                                                                                       |
| ---- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| L59  | `arXiv (alpha-research skill), INSPIRE-HEP, alphaxiv overview`      | `委托 research-explorer subagent (paper-search skill) 搜索所有学术数据库`; 生物医学数据库 (PubMed, bioRxiv) 暂不在 paper-search scope 内，待未来需要时补充 |
| L74  | `Deep Understanding (alphaxiv)`                                     | `Deep Understanding (paper-search skill via research-explorer)`                                                                                            |
| L93  | `uv run .aether/skills/literature-review/scripts/download_paper.py` | `uv run .aether/skills/paper-search/download_paper.py`                                                                                                     |

### 4.8 `.aether/skills/research-audit/SKILL.md`

| 行号 | 原文                                                                           | 改为                                                                            |
| ---- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| L98  | `Local copy unavailable → web search + alphaxiv overview`                      | `Local copy unavailable → paper-search skill`                                   |
| L99  | `verification_source: local \| web_search \| alphaxiv`                         | `verification_source: local \| paper_search \| web_search`                      |
| L152 | 同上                                                                           | 同上                                                                            |
| L166 | 同上                                                                           | 同上                                                                            |
| L224 | `Original paper comparison (via literatures/ local copy or alphaxiv overview)` | `Original paper comparison (via literatures/ local copy or paper-search skill)` |

### 4.9 `.aether/skills/research-audit-repair/SKILL.md`

| 行号 | 原文                                                                            | 改为                                                                |
| ---- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| L7   | `alpha-research skill for targeted literature search`                           | `paper-search skill for targeted literature search`                 |
| L53  | `search for supporting reference (alpha-research skill + web search)`           | `search for supporting reference (paper-search skill + web search)` |
| L66  | `Use alpha-research skill for targeted literature search`                       | `Use paper-search skill for targeted literature search`             |
| L68  | `optionally use alphaxiv overview for deeper understanding`                     | `optionally use paper-search skill for deeper understanding`        |
| L127 | `alpha-research skill for targeted arXiv/Semantic Scholar/INSPIRE-HEP searches` | `paper-search skill for targeted literature searches`               |
| L129 | `alphaxiv overview for deeper paper understanding`                              | `paper-search skill for deeper paper understanding`                 |

### 4.10 `.aether/skills/research-audit-repair-reasoning/SKILL.md`

| 行号 | 原文                                                                            | 改为                                                  |
| ---- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| L163 | `alpha-research skill for targeted arXiv/Semantic Scholar/INSPIRE-HEP searches` | `paper-search skill for targeted literature searches` |
| L165 | `alphaxiv overview for deeper paper understanding`                              | `paper-search skill for deeper paper understanding`   |

### 4.11 `.aether/skills/source-comparison/SKILL.md`

| 行号 | 原文                                               | 改为                                 |
| ---- | -------------------------------------------------- | ------------------------------------ |
| L28  | `If alpha CLI is available (alpha-research skill)` | `If paper-search skill is available` |

---

## 5. MCP Server 改动清单

### 5.1 `.aether/mcp/research-state/server.py`

| 区域                                    | 位置             | 操作                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A** — alpha_cli 检测 → 网络可达性替换 | L676-699 (24 行) | **删除 alpha_cli 整段（24 行）**；原有的 `network_semantic_scholar` 合并到 `network_s2`（同一 API `api.semanticscholar.org`），新增 `network_pubmed` (eutils.ncbi.nlm.nih.gov), `network_alphaxiv` (alphaxiv.org), `network_crossref` (api.crossref.org)；infrastructure 层从 `uv + git + alpha_cli + 3 network` 变为 `uv + git + 6 network (arxiv, s2, inspire_hep, pubmed, alphaxiv, crossref)`；删除 alpha CLI 行后，对应的 `issues.append` 也删除                                                                        |
| **B** — skill 映射                      | L825             | `"research_worker_alpha_research": "alpha-research"` → `"research_worker_paper_search": "paper-search"`                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **C** — 脚本存在性                      | L1044-1055       | `alpha_research_scripts` (单条目) → `paper_search_scripts` + `download_paper_script` + `inspire_search_script` + `s2_search_script` + `pubmed_search_script` + `extract_citations_script` (6 条目，路径均指向 `.aether/skills/paper-search/`，循环检查 exists/missing)                                                                                                                                                                                                                                                       |
| **D** — 功能检测                        | L1176-1198       | **逐行改动**: (1) L1176-1177: 脚本路径从 `project_dir / ".aether" / "skills" / "alpha-research" / "arxiv_search.py"` → `project_dir / ".aether" / "skills" / "paper-search" / "arxiv_search.py"`; (2) L1179-1196: `uv run` 命令保持不变（仅路径变），但键名从 `"alpha_search"` → `"paper_search"` (L1188/L1190/L1192/L1198); (3) L1196: issues 消息从 `"alpha-research arxiv_search failed"` → `"paper-search arxiv_search failed"`; (4) L1197-1198: 错误分支中 `"script not found"` 消息保持不变但键名改为 `"paper_search"` |
| **E** — docstring                       | L1217, L1220     | `infrastructure: uv, alpha CLI, network reachability (3 endpoints)` → `infrastructure: uv, git, network reachability (6 endpoints: arxiv, s2, inspire_hep, pubmed, alphaxiv, crossref)`；`runtime: ... alpha search` → `runtime: ... paper-search arxiv_search`                                                                                                                                                                                                                                                              |
| **literature-review scripts**           | L1022            | 从 literature-review scripts 存在性检查列表中删除 `"download_paper.py"` 条目（区域 C 已覆盖）                                                                                                                                                                                                                                                                                                                                                                                                                                |

---

## 6. Agent 配置改动清单

### 6.1 `.aether/agent/research.md`（6 处）

| 行号  | 原文                                                   | 改为                                                                                                                                              |
| ----- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| L65   | `alpha-research skill, no subagents, no state machine` | `paper-search skill (直接调用，Path 1 only), no subagents, no state machine`                                                                      |
| L97   | `Use alpha-research skill directly.`                   | `Use paper-search skill directly. (Path 1: primary agent 直接调用 paper-search; Path 2/3: dispatch research-explorer subagent 加载 paper-search)` |
| L528  | `alpha-research skill for targeted literature search`  | `paper-search skill for targeted literature search`                                                                                               |
| L578  | 同上                                                   | 同上                                                                                                                                              |
| L711  | 同上                                                   | 同上                                                                                                                                              |
| L1553 | `Do NOT use SymPy verification, alpha search`          | `Do NOT use SymPy verification`                                                                                                                   |

### 6.2 `.aether/agent/research-explorer.md`（2 处）

| 行号 | 原文                                                          | 改为                                            |
| ---- | ------------------------------------------------------------- | ----------------------------------------------- |
| L21  | `- alpha-research`                                            | `- paper-search`                                |
| L54  | `use both websearch and the alpha CLI (alpha-research skill)` | `use both websearch and the paper-search skill` |

### 6.3 `.aether/agent/research-worker.md`（1 处）

| 行号 | 原文               | 改为             |
| ---- | ------------------ | ---------------- |
| L28  | `- alpha-research` | `- paper-search` |

> 以下 `.aether/agent/` 文件不含 alpha CLI 引用，无需改动: `gpd-reviewer.md`, `gpd-verifier.md`, `local-executor.md`, `research-verifier.md`

---

## 7. 测试文件改动清单

> 改动限于 `packages/opencode/test/`，`packages/opencode/src/` 无需修改。

### 7.1 `packages/opencode/test/layer-2/fixture.ts`（2 处）

| 行号 | 原文                                                       | 改为                                                    |
| ---- | ---------------------------------------------------------- | ------------------------------------------------------- |
| L45  | `allowed_commands: ["alpha", "curl", "rg", "grep", "git"]` | `allowed_commands: ["uv", "curl", "rg", "grep", "git"]` |
| L68  | `skill_refs: ["alpha-research", "arxiv-search"]`           | `skill_refs: ["paper-search"]`                          |

### 7.2 `packages/opencode/test/layer-2/skills-and-file-loading.test.ts`（9 处）

| 行号 | 原文                                                                      | 改为                                                                                                    |
| ---- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| L11  | `test("T2.1.1: alpha-research SKILL.md exists with auth-first design"`    | `test("T2.1.1: paper-search SKILL.md exists with arXiv mode design"`                                    |
| L12  | `Bun.file(path.join(projectRoot, "alpha-research", "SKILL.md")).text()`   | `Bun.file(path.join(projectRoot, "paper-search", "SKILL.md")).text()`                                   |
| L13  | `expect(content).toContain("name: alpha-research")`                       | `expect(content).toContain("name: paper-search")`                                                       |
| L14  | `expect(content).toContain("Mode Selection")`                             | `expect(content).toContain("arXiv Search")`                                                             |
| L15  | `expect(content).toContain("alpha status")`                               | `expect(content).toContain("arxiv_search.py")`                                                          |
| L37  | `skillDirs = ["alpha-research", "source-comparison", "paper-code-audit"]` | `skillDirs = ["paper-search", "source-comparison", "paper-code-audit"]`                                 |
| L68  | `- alpha`                                                                 | `- uv`                                                                                                  |
| L90  | `Permission.evaluate("bash", "alpha test", r!.permission)`                | `Permission.evaluate("bash", "uv run .aether/skills/paper-search/arxiv_search.py test", r!.permission)` |
| L118 | `- alpha-research`                                                        | `- paper-search`                                                                                        |
| L136 | `expect(e?.skillRefs).toEqual(["alpha-research", "arxiv-search"])`        | `expect(e?.skillRefs).toEqual(["paper-search"])`                                                        |

### 7.3 `packages/opencode/test/layer-2/research-primary.test.ts`（1 处）

| 行号 | 原文                                                         | 改为                                                                                                      |
| ---- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| L48  | `Permission.evaluate("bash", "alpha search", r!.permission)` | `Permission.evaluate("bash", "uv run .aether/skills/paper-search/arxiv_search.py search", r!.permission)` |

### 7.4 `packages/opencode/test/layer-2/config-load-order.test.ts`（2 处）

| 行号 | 原文                                                                    | 改为                                                                  |
| ---- | ----------------------------------------------------------------------- | --------------------------------------------------------------------- |
| L166 | `skill_refs: ["alpha-research", "deep-research"]`                       | `skill_refs: ["paper-search", "deep-research"]`                       |
| L180 | `expect(agent?.skillRefs).toEqual(["alpha-research", "deep-research"])` | `expect(agent?.skillRefs).toEqual(["paper-search", "deep-research"])` |

### 7.5 `packages/opencode/test/layer-2/research-subagents.test.ts`（1 处）

| 行号 | 原文                                                               | 改为                                             |
| ---- | ------------------------------------------------------------------ | ------------------------------------------------ |
| L22  | `expect(e?.skillRefs).toEqual(["alpha-research", "arxiv-search"])` | `expect(e?.skillRefs).toEqual(["paper-search"])` |

### 7.6 `packages/opencode/test/layer-0/permission-intersection.test.ts`（2 处）

| 行号 | 原文                                                        | 改为                                                                                                     |
| ---- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| L48  | `env_scope: { allowed_commands: ["docker", "alpha"] }`      | `env_scope: { allowed_commands: ["docker", "uv"] }`                                                      |
| L52  | `Permission.evaluate("bash", "alpha test", result).action)` | `Permission.evaluate("bash", "uv run .aether/skills/paper-search/arxiv_search.py test", result).action)` |

### 7.7 `packages/opencode/test/layer-1/denied-tools.test.ts`（2 处）

| 行号 | 原文                                                | 改为                                                                                             |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| L78  | `bash: { "*": "deny", "alpha*": "allow" }`          | `bash: { "*": "deny", "uv*": "allow" }`                                                          |
| L81  | `Permission.evaluate("bash", "alpha test", merged)` | `Permission.evaluate("bash", "uv run .aether/skills/paper-search/arxiv_search.py test", merged)` |

> `packages/opencode/test/` 中其他测试文件的 "alpha" 是通用测试数据（模拟名、`\alpha` LaTeX、版本号等），不引用 alpha CLI，无需改动。

### 7.8 额外实现改进：RESEARCH_AGENT_TEST skip guard（14 个测试文件）

实际实现中，除 §7.1-7.7 列出的 7 个文件外，另有 14 个测试文件添加了 `RESEARCH_AGENT_TEST !== "1"` skip guard，防止在 CI 环境（无 .aether/skills 目录）中测试失败。这些文件本身不含 alpha CLI 引用，改动仅是添加 skip 条件：

| 文件                                            | 改动                                                                  |
| ----------------------------------------------- | --------------------------------------------------------------------- |
| `layer-0/agent-info-extensions.test.ts`         | 添加 `skipIf(skip)`                                                   |
| `layer-0/discipline-compile.test.ts`            | 添加 `skipIf(skip)`                                                   |
| `layer-0/discipline-schema-edges.test.ts`       | 添加 `skipIf(skip)`                                                   |
| `layer-0/permission-intersection-edges.test.ts` | 添加 `skipIf(skip)`                                                   |
| `layer-0/skill-refs-injection.test.ts`          | 添加 `skipIf(skip)`                                                   |
| `layer-0/subagent-permission-flow.test.ts`      | 添加 `skipIf(skip)`                                                   |
| `layer-1/fallback-models.test.ts`               | 添加 `skipIf(skip)`                                                   |
| `layer-1/mcp-path-expansion.test.ts`            | 添加 `skipIf(skip)`                                                   |
| `layer-1/mcp-per-agent.test.ts`                 | 添加 `skipIf(skip)`                                                   |
| `layer-1/output-dir.test.ts`                    | 添加 `skipIf(skip)`                                                   |
| `layer-1/prompt-with-fallback.test.ts`          | 添加 `skipIf(skip)`                                                   |
| `layer-1/seed-default-assets.test.ts`           | 添加 `skipIf(skip)`                                                   |
| `layer-1/skill-refs-url.test.ts`                | 添加 `skipIf(skip)` + `.opencode/skill/` → `.aether/skills/` 路径更新 |
| `layer-2/config-paths-order.test.ts`            | 添加 `skipIf(skip)`                                                   |

其中 `skill-refs-url.test.ts` 除 skip guard 外还更新了 6 处技能路径（`.opencode/skill/` → `.aether/skills/`），与其他层的 skill 目录迁移一致。

---

## 8. Docs 文档改动清单

12 个 `docs/agent-docs/*.md` 含 alpha/alpha-research 引用，需逐一更新。

**不需要修改的 docs**: layer-3.4, layer-3.5, layer-3.7, layer-3.8, layer-3.12, layer-3.14, layer-3.15, layer-4, layer-5

### 8.1 `layer-0-core-security.md`（8 处）

| 行号 | 原文                                                                   | 改为                                                             |
| ---- | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| L86  | `bash, "alpha*", **allow**`                                            | `bash, "uv*", **allow**`                                         |
| L87  | `bash, "alpha*", **allow**` / `bash, alpha*, allow`                    | `bash, "uv*", **allow**` / `bash, uv*, allow`                    |
| L106 | `bash,"alpha*",allow},{bash,"*",deny}` → `alpha* allow + blanket deny` | `bash,"uv*",allow},{bash,"*",deny}` → `uv* allow + blanket deny` |
| L218 | `allowed_commands:["alpha","docker"]` → `alpha*,allow`                 | `allowed_commands:["uv","docker"]` → `uv*,allow, docker*,allow`  |
| L223 | `Permission.evaluate("bash","alpha run...") = allow`                   | `Permission.evaluate("bash","uv run ...") = allow`               |
| L452 | `skill_refs:["alpha-research"]`                                        | `skill_refs:["paper-search"]`                                    |
| L453 | `allowed_commands:["alpha","docker"]`                                  | `allowed_commands:["uv","docker"]`                               |
| L521 | `skillRefs=["alpha-research"]`                                         | `skillRefs=["paper-search"]`                                     |

### 8.2 `layer-1-agent-infrastructure.md`（1 处）

| 行号 | 原文                                                              | 改为                                                           |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------------- |
| L345 | `research agent（bash restricted）看到 alpha/docker 的 bash 工具` | `research agent（bash restricted）看到 uv/docker 的 bash 工具` |

### 8.3 `layer-2-research-config.md`（9 处）

| 行号 | 原文                                                                                  | 改为                                                                               |
| ---- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| L10  | `env_scope 编译后自动生成 ... {bash, "alpha*", allow}`                                | `{bash, "uv*", allow}`                                                             |
| L90  | `alpha` in allowed commands                                                           | 移除 `alpha`，加 `uv`                                                              |
| L102 | `bash (alpha/curl/rg/grep/git/docker only via env_scope)`                             | `bash (uv/curl/rg/grep/git via env_scope)`                                         |
| L110 | `Use alpha-research skill directly`                                                   | `Use paper-search skill directly`                                                  |
| L176 | `alpha-research` skill_refs                                                           | `paper-search`                                                                     |
| L195 | `use both websearch and alpha CLI for mixed topics`                                   | `use both websearch and paper-search skill for mixed topics`                       |
| L477 | 行含 `alpha-research \| .aether/skills/alpha-research/SKILL.md \| 已存在，auth-first` | 行改为 `paper-search \| .aether/skills/paper-search/SKILL.md \| 已存在，arXiv API` |
| L478 | 行含 `arxiv-search \| merged into alpha-research`                                     | 行改为 `arxiv-search \| merged into paper-search`                                  |
| L497 | `env_scope.allowed_commands 生效（bash 限制到 alpha/docker 等`                        | `env_scope.allowed_commands 生效（bash 限制到 uv/curl 等`                          |

### 8.4 `layer-2.1-missing-skills-recovery.md`（17+ 处）

| 行号范围 | 原文                                                                             | 改为                                                                              |
| -------- | -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| L15      | 行含 `alpha-research \| 已存在（完整 auth-first 实现） \| 缺失`                  | 行改为 `paper-search \| 已存在（arXiv API + alphaxiv webfetch） \| 存在`          |
| L46-122  | 整个 §2.1.1 alpha-research Skill                                                 | 重写为 §2.1.1 paper-search Skill，删除所有 alpha CLI 命令描述                     |
| L294     | `If alpha CLI is available (alpha-research skill), use it for academic sources.` | `Delegate literature search to research-explorer subagent (paper-search skill).`  |
| L351     | `Read the paper (use alpha get / alpha ask for detailed Q&A)`                    | `Read the paper (delegate to research-explorer subagent with paper-search skill)` |
| L352     | `Inspect the code repo (use alpha code for file-level inspection)`               | `Inspect the code repo (use webfetch to read GitHub repo files)`                  |
| L363     | `Use alpha code (if available) or webfetch to read the repo files.`              | `Use webfetch to read the repo files directly.`                                   |
| L588     | `alpha-research SKILL.md 存在于 .aether/skills/alpha-research/`                  | `paper-search SKILL.md 存在于 .aether/skills/paper-search/`                       |
| L596     | `research-explorer skill_refs 包含 alpha-research`                               | `research-explorer skill_refs 包含 paper-search`                                  |
| L608     | `从 feat/research-agent 端口 alpha-research（移除 category）`                    | _(删除此行，alpha CLI 不存在无法端口)_                                            |

### 8.5 `layer-3.2-gap-analysis.md`（1 处）

| 行号 | 原文                                            | 改为                                       |
| ---- | ----------------------------------------------- | ------------------------------------------ |
| L502 | `alpha-research skill 已包含 arxiv-search 模式` | `paper-search skill 已包含 arXiv API 模式` |

### 8.6 `layer-3-research-infrastructure.md`（2 处）

| 行号 | 原文                                          | 改为                                   |
| ---- | --------------------------------------------- | -------------------------------------- |
| L598 | `alpha-research skill（arxiv-search 子模式）` | `paper-search skill（arXiv API 模式）` |
| L598 | `alpha-research 已包含 arxiv-search 子模式`   | `paper-search 已包含 arXiv API 模式`   |

### 8.7 `layer-3.1-research-skills-supplement.md`（~30 处）

| 行号 | 原文                                                                                                | 改为                                                                                                                    |
| ---- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| L17  | `通用 research skills 完善 + 目录规范化 + alphaxiv 集成`                                            | `通用 research skills 完善 + 目录规范化 + paper-search skill 重构（移除 alpha CLI）`                                    |
| L51  | `skill_refs: [deep-research, alpha-research, literature-landscape-scan, research-question-framing]` | `skill_refs: [deep-research, paper-search, literature-landscape-scan, research-question-framing]`                       |
| L92  | `Use alpha-research skill directly`                                                                 | `Use paper-search skill directly`                                                                                       |
| L127 | `原则 4: alphaxiv 集成`                                                                             | `原则 4: paper-search skill 重构`                                                                                       |
| L129 | `alphaXiv (https://alphaxiv.org) 是 arXiv 的 AI-enhanced 前端`                                      | _(保留事实描述，但删除"alphaxiv 集成"作为独立设计原则的表述，改为"paper-search skill 内部包含 alphaxiv webfetch 功能")_ |
| L134 | `alphaxiv.org/abs/XXXX.XXXXX`                                                                       | _(保留 URL，但标注为 paper-search 内部使用)_                                                                            |
| L136 | `alphaxiv.org/overview/XXXX.XXXXX`                                                                  | _(同上)_                                                                                                                |
| L140 | `alphaXiv overview 页面提供 AI 生成的结构化论文总结`                                                | _(保留事实，但改为"paper-search skill 的 alphaxiv overview 模式提供 AI 生成的结构化论文总结")_                          |
| L144 | `在 alpha-research skill 中增加 alphaxiv 集成`                                                      | `在 paper-search skill 中包含 alphaxiv webfetch 模式`                                                                   |
| L147 | `webfetch https://alphaxiv.org/overview/<arxiv_id>`                                                 | _(保留 URL，标注为 paper-search 内部使用)_                                                                              |
| L175 | `alpha-research/SKILL.md -> 包含 arxiv-search 子模式 + alphaxiv 集成`                               | `paper-search/SKILL.md -> 包含 arXiv API 模式 + alphaxiv webfetch`                                                      |
| L241 | `源评估含 arXiv/alphaxiv`                                                                           | `源评估含 arXiv/paper-search skill`                                                                                     |
| L249 | `物理文献源评估补充（alphaxiv overview 优先）`                                                      | `物理文献源评估补充（paper-search skill 优先）`                                                                         |
| L259 | `需增加物理数据库指引（arXiv, INSPIRE-HEP, alphaxiv）`                                              | `需增加物理数据库指引（委托 paper-search skill）`                                                                       |
| L267 | `arXiv API -> alphaxiv overview 深度理解、INSPIRE-HEP`                                              | `arXiv API -> paper-search skill 深度理解、INSPIRE-HEP（均通过 paper-search）`                                          |
| L327 | `arXiv -> alphaxiv overview 深度理解`                                                               | `arXiv -> paper-search skill 深度理解`                                                                                  |
| L329 | `alphaxiv 集成: 搜索获取 arXiv ID 列表后，用 alphaxiv overview 快速理解论文内容`                    | `paper-search skill: 搜索获取 arXiv ID 列表后，用 alphaxiv overview 快速理解论文内容`                                   |
| L367 | `3.8 alpha-research alphaxiv 集成（含 arxiv-search 子模式）`                                        | `3.8 paper-search skill（含 arXiv API 模式 + alphaxiv webfetch）`                                                       |
| L371 | `alpha-research SKILL.md: 提供 alpha CLI 全功能操作`                                                | `paper-search SKILL.md: 提供 arXiv API + alphaxiv webfetch + 多数据库搜索`                                              |
| L375 | `合并 arxiv-search 为 alpha-research 的子模式，并增加 alphaxiv 集成`                                | _(重写整段：删除 alpha CLI 模式描述，改为 paper-search skill 的 4 个 Mode)_                                             |
| L377 | `alpha CLI 模式（需要 alphaXiv 登录）`                                                              | _(删除，alpha CLI 不存在)_                                                                                              |
| L379 | `webfetch https://alphaxiv.org/overview/<arxiv_id>`                                                 | _(保留 URL，标注为 paper-search 内部使用)_                                                                              |
| L380 | `alphaxiv overview 内容`                                                                            | `paper-search skill alphaxiv overview 模式`                                                                             |
| L381 | `alphaxiv overview 不可用时`                                                                        | `alphaxiv overview 不可用时（paper-search skill 内部 fallback）`                                                        |
| L382 | `alphaxiv 的 "Smart" 搜索`                                                                          | `paper-search skill 的 alphaxiv Smart Search 模式`                                                                      |
| L387 | `Deep Understanding (alphaxiv)`                                                                     | `Deep Understanding (paper-search skill)`                                                                               |
| L391 | `Construct alphaxiv overview URL: https://alphaxiv.org/overview/<arxiv_id>`                         | _(保留 URL，标注为 paper-search 内部使用)_                                                                              |
| L396 | `if alphaxiv overview is unavailable`                                                               | `if alphaxiv overview is unavailable (paper-search skill handles fallback internally)`                                  |
| L429 | `literature-landscape-scan SKILL.md 增强为完整程序（搜索策略+结构化输出+alphaxiv+质量标准）`        | `literature-landscape-scan SKILL.md 增强为完整程序（搜索策略+结构化输出+paper-search+质量标准）`                        |
| L431 | `alpha-research SKILL.md 包含 arxiv-search 子模式 + alphaxiv 集成指引`                              | `paper-search SKILL.md 包含 arXiv API 模式 + alphaxiv webfetch 指引`                                                    |
| L448 | `alpha-research 合并: 合并 arxiv-search 为子模式，增加 alphaxiv 集成`                               | `paper-search 重构: 移除 alpha CLI，保留 arXiv API + alphaxiv webfetch + 新增多数据库搜索`                              |

> **注**: L129-147 (§原则 4) 和 L367-397 (§3.8) 中大量 `alphaxiv` URL 和事实描述属于可保留的真实内容（alphaxiv.org 确实存在），仅需将"集成"表述改为"paper-search 内部使用"。但 `alpha CLI 模式` (L377) 和 `alpha CLI 全功能操作` (L371) 等虚构命令描述必须整段删除。

### 8.8 `layer-3.3-context-isolation.md`（6 处）

| 行号  | 原文                                                     | 改为                                                   |
| ----- | -------------------------------------------------------- | ------------------------------------------------------ |
| L271  | `alpha-research skill 在 coordinator session 内直接调用` | `paper-search skill 在 coordinator session 内直接调用` |
| L329  | `alpha-research` skill_refs                              | `paper-search`                                         |
| L332  | `alpha` in allowed commands                              | 移除 `alpha`，改为 `uv`                                |
| L351  | `skill_refs 仅含 alpha-research`                         | `skill_refs 仅含 paper-search`                         |
| L352  | `alpha CLI、uv、docker 等命令均需要`                     | `uv、curl 等命令需要`                                  |
| L1234 | `Path 1 仍使用 alpha-research skill`                     | `Path 1 仍使用 paper-search skill`                     |

### 8.9 `layer-3.6-health-check.md`（~35 处）

| 行号     | 原文                                                                                             | 改为                                                                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| L33      | `alpha CLI 未认证，在 phase_analysis 调用 alpha-research 时才发现降级到 no-login mode`           | _(删除 alpha CLI 未认证场景；paper-search skill 无认证依赖)_                                                                                    |
| L54      | `alpha CLI 未认证 \| phase_analysis`                                                             | _(删除此行)_                                                                                                                                    |
| L103     | `alpha CLI \| alpha status \| 返回认证状态 \| alpha-research skill（CLI mode）`                  | _(整行删除，不替换为网络检测——网络检测是独立的检测项)_                                                                                          |
| L104     | `alpha-research no-login mode, webfetch`                                                         | `paper-search skill (arXiv API mode)`                                                                                                           |
| L185     | `research-worker: alpha-research \| 查找 .aether/skills/alpha-research/SKILL.md`                 | `research-worker: paper-search \| 查找 .aether/skills/paper-search/SKILL.md`                                                                    |
| L196     | `alpha-research scripts \| 查找 arxiv_search.py`                                                 | `paper-search scripts \| 查找 arxiv_search.py + inspire_search.py + s2_search.py + pubmed_search.py + extract_citations.py + download_paper.py` |
| L209     | `alpha-research arxiv_search \| uv run .aether/skills/alpha-research/arxiv_search.py`            | `paper-search arxiv_search \| uv run .aether/skills/paper-search/arxiv_search.py`                                                               |
| L259     | `runtime: MCP tool calls, all 9 SymPy scripts dry-run, alpha search`                             | `runtime: MCP tool calls, all 9 SymPy scripts dry-run, paper-search arxiv_search`                                                               |
| L292     | `"alpha_cli": { "status": "pass", "authenticated": true },`                                      | _(删除，infrastructure checks 仅保留 uv/git/network)_                                                                                           |
| L311     | `"research_worker_alpha_research": { "status": "pass", "path": ".../alpha-research/SKILL.md" },` | `"research_worker_paper_search": { "status": "pass", "path": ".../paper-search/SKILL.md" },`                                                    |
| L512     | `"alpha_cli": { "status": "pass", "authenticated": true }`                                       | _(删除)_                                                                                                                                        |
| L726     | `alpha CLI 未认证 \| 论文搜索降级为 title+abstract only \| alpha-research skill \| partial \| …` | _(删除此行，alpha CLI 不存在)_                                                                                                                  |
| L747     | `infrastructure.fail(alpha_cli) -> 论文搜索降级`                                                 | _(删除此行)_                                                                                                                                    |
| L845-856 | 整个 `alpha_cli` registry 条目 (13 行)                                                           | _(整段删除)_                                                                                                                                    |
| L872     | `manual_step: alpha login`                                                                       | _(删除)_                                                                                                                                        |
| L906     | `alpha CLI 未认证（priority: low, partial）`                                                     | _(删除此行和下行的 alpha CLI 描述)_                                                                                                             |
| L907     | `alpha CLI 可提升论文搜索质量（全文阅读），安装后需手动 alpha login`                             | _(删除)_                                                                                                                                        |
| L923     | `alpha CLI: 请执行 `alpha login``                                                                | _(删除)_                                                                                                                                        |
| L1027    | `result = subprocess.run(["alpha", "status"], ...)`                                              | _(删除 alpha CLI 检测逻辑)_                                                                                                                     |
| L1029    | `checks["alpha_cli"] = "account" in result.stdout.lower()`                                       | _(删除)_                                                                                                                                        |
| L1030    | `checks["alpha_authenticated"] = checks["alpha_cli"]`                                            | _(删除)_                                                                                                                                        |
| L1032    | `checks["alpha_cli_available"] = False`                                                          | _(删除)_                                                                                                                                        |
| L1268    | `"alpha_cli": { "status": "pass", "authenticated": true }`                                       | _(删除)_                                                                                                                                        |
| L1174    | `phase_analysis -> alpha-research skill`                                                         | `phase_analysis -> paper-search skill`                                                                                                          |
| L1306    | `alpha_cli 区分 not_installed/not_authenticated`                                                 | _(删除)_                                                                                                                                        |
| L1365    | `alpha_cli 区分 not_installed vs not_authenticated`                                              | _(删除)_                                                                                                                                        |

**新增检查项**（infrastructure Layer 1 中追加）:

| 检测项                   | 检测方法                                     | 预期结果 | 失败分类    |
| ------------------------ | -------------------------------------------- | -------- | ----------- |
| **网络可达（alphaxiv）** | `_check_network("https://alphaxiv.org")`     | HTTP 200 | unreachable |
| **网络可达（Crossref）** | `_check_network("https://api.crossref.org")` | HTTP 200 | unreachable |

> **注**: network_arxiv, network_semantic_scholar, network_inspire_hep 已存在于 Layer 3.6 原文中。本次改动将 network_semantic_scholar 合并为 network_s2（同一 API `api.semanticscholar.org`），新增 network_pubmed, network_alphaxiv, network_crossref。Docker 检测项（docker_cli, docker_daemon）已被 Layer 3.9 superseded 声明移除，不在本层改动范围内。

### 8.10 `layer-3.9-remove-sandbox-add-local-compile.md`（9 处）

| 行号 | 原文                                                             | 改为                                                     |
| ---- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| L357 | `Do NOT use SymPy verification, alpha search, Docker containers` | `Do NOT use SymPy verification, Docker containers`       |
| L361 | `Do NOT use SymPy verification, alpha search`                    | `Do NOT use SymPy verification`                          |
| L749 | `infrastructure: uv, docker, alpha CLI, network`                 | `infrastructure: uv, network`                            |
| L753 | `infrastructure: uv, alpha CLI, network`                         | `infrastructure: uv, network`                            |
| L774 | `allowed_commands: ["alpha", "curl", ...]`                       | `allowed_commands: ["uv", "curl", "rg", ...]`            |
| L777 | 同上                                                             | 同上                                                     |
| L799 | `skillDirs = ["alpha-research", ...]`                            | `skillDirs = ["paper-search", ...]`                      |
| L802 | 同上                                                             | 同上                                                     |
| L809 | `env_scope: allowed_commands: -alpha - docker`                   | `env_scope: allowed_commands: -uv`                       |
| L812 | `env_scope: allowed_commands: -alpha`                            | `env_scope: allowed_commands: -uv`                       |
| L823 | `Permission.evaluate("bash", "alpha test", ...)`                 | 删除或替换为 `Permission.evaluate("bash", "uv run ...")` |

### 8.11 `layer-3.10-audit-phase.md`（5 处）

| 行号 | 原文                                                     | 改为                                                       |
| ---- | -------------------------------------------------------- | ---------------------------------------------------------- |
| L517 | `alpha-research skill for targeted literature search`    | `paper-search skill for targeted literature search`        |
| L538 | 同上                                                     | 同上                                                       |
| L551 | `web search 和 alpha-research skill`                     | `web search 和 paper-search skill`                         |
| L755 | `本地副本不可用时 → web search + alphaxiv overview 核实` | `本地副本不可用时 → web search + paper-search skill 核实`  |
| L756 | `verification_source: local \| web_search \| alphaxiv`   | `verification_source: local \| paper_search \| web_search` |

### 8.12 `layer-3.11-framing-reasoning-audit.md`（1 处）

| 行号 | 原文                                                  | 改为                                                |
| ---- | ----------------------------------------------------- | --------------------------------------------------- |
| L899 | `alpha-research skill for targeted literature search` | `paper-search skill for targeted literature search` |

### 8.13 `research-agent-v2-overview.md`（1 处）

| 行号 | 原文                                    | 改为                                  |
| ---- | --------------------------------------- | ------------------------------------- |
| L57  | `research-explorer 仅见 alpha-research` | `research-explorer 仅见 paper-search` |

### 8.14 `research-agent-runtime-design.md`（1 处）

| 行号 | 原文                                           | 改为                                         |
| ---- | ---------------------------------------------- | -------------------------------------------- |
| L100 | `Path 1: Quick lookup \| alpha-research skill` | `Path 1: Quick lookup \| paper-search skill` |

---

## 9. 验收清单

### 9.1 功能验收

- [ ] `uv run .aether/skills/paper-search/arxiv_search.py "test query" --max-papers 1` 成功返回结果
- [ ] `uv run .aether/skills/paper-search/inspire_search.py "E.Witten.1" --max-papers 1` 成功返回 INSPIRE-HEP 结果
- [ ] `uv run .aether/skills/paper-search/s2_search.py "dark matter" --max-papers 1` 成功返回 S2 结果
- [ ] `uv run .aether/skills/paper-search/pubmed_search.py "cancer therapy" --max-papers 1` 成功返回 PubMed 结果
- [ ] 各脚本 429 响应时返回 `{"error": "rate_limited", "retry_after": N}` 而非崩溃
- [ ] `uv run .aether/skills/paper-search/download_paper.py --arxiv 2406.01705 --output .aether/literatures` 成功下载（source tarball + PDF）
- [ ] `uv run .aether/skills/paper-search/download_paper.py --arxiv 2406.01705 --prefer-pdf` 下载 PDF only
- [ ] `uv run .aether/skills/paper-search/extract_citations.py --arxiv 2406.01705 --output .aether/literatures --format json` 成功提取引用
- [ ] 下载目录包含 `.tex` 和 `.bib` 文件（当 source 可用时），`index.json` 包含 `has_source`, `source_files`

### 9.2 引用消除验收

- [ ] 不存在任何 `alpha` 命令调用（`alpha status/search/get/ask/code/annotate/login`）
- [ ] 所有外部 skill/agent 中无 alphaxiv/INSPIRE-HEP/S2/PubMed 直接引用（统一委托 paper-search skill）
- [ ] research.md L65/L97 明确 Path 1 直接调用 paper-search skill、Path 2/3 通过 research-explorer subagent 调用（D7 invocation protocol）
- [ ] `.aether/agent/research-explorer.md` skill_refs 包含 `paper-search`（原 `alpha-research` 改名后自动满足）
- [ ] `.aether/skills/paper-search/SKILL.md` frontmatter `name: paper-search`，包含 Mode 1-4、D21 引用链限制、D19 sole entry point 声明
- [ ] `.aether/skills/alpha-research/` 和 `.aether/skills/arxiv-search/` 目录已不存在
- [ ] `.aether/skills/literature-review/scripts/download_paper.py` 已删除，所有调用方路径已更新
- [ ] 所有 skill SKILL.md 中 `alpha-research` → `paper-search`，无 alpha CLI 引用
- [ ] `install_registry.json` 无 `alpha_cli` 条目
- [ ] MCP server.py 区域 A alpha_cli 检测整段删除，原有的 network_semantic_scholar 合并为 network_s2（同一 API），新增 network_pubmed/alphaxiv/crossref（共 6 个 endpoint）；区域 C 覆盖 6 个 paper-search 脚本；区域 D 保留功能检测（键名 paper_search，路径 paper-search/）；区域 E docstring 更新
- [ ] `grep -E 'alpha_cli|alpha_search|alpha_research_scripts|research_worker_alpha_research|"alpha-research"|"alpha"' .aether/mcp/research-state/server.py` 返回 0 结果（仅排除 \alpha LaTeX 和无关 alpha）
- [ ] `.aether/agent/research.md` 6 处、`research-explorer.md` 2 处、`research-worker.md` 1 处 → `paper-search`
- [ ] 所有 21 个测试文件更新完成（§7.1-7.7 alpha 替换 + §7.8 skip guard），`RESEARCH_AGENT_TEST=1 bun test packages/opencode` 全部通过
- [ ] 所有 `docs/agent-docs/*.md` 中 `alpha-research` → `paper-search`，`alpha_cli` → 删除，env_scope `"alpha"` → `"uv"`
- [ ] env_scope 编译规则: `allowed_commands: ["uv"]` 编译为 `{bash, "uv*", allow}`，覆盖 `uv run .aether/skills/paper-search/*.py` 命令族

---

## 附录 A: 全局搜索替换映射

| 搜索模式                                                                                                      | 替换为                              | 适用范围                   |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------- | -------------------------- |
| `alpha-research`                                                                                              | `paper-search`                      | 所有 .md, .py, .json, .ts  |
| `.aether/skills/alpha-research/`                                                                              | `.aether/skills/paper-search/`      | 所有文件                   |
| `.aether/skills/arxiv-search/`                                                                                | _(删除整个目录)_                    | —                          |
| `arxiv-search` in skill_refs                                                                                  | _(删除)_                            | 测试 fixture               |
| `alpha status` / `alpha search` / `alpha get` / `alpha ask` / `alpha code` / `alpha annotate` / `alpha login` | 按文件类型策略替换（见下方策略表）  | 所有文件                   |
| `alpha_cli`                                                                                                   | _(整段删除，不替换)_                | server.py, SKILL.md, docs  |
| `alpha_research_scripts`                                                                                      | `paper_search_scripts`              | server.py                  |
| `alpha_search`                                                                                                | `paper_search`                      | server.py                  |
| `research_worker_alpha_research`                                                                              | `research_worker_paper_search`      | server.py                  |
| `"alpha"` (env_scope)                                                                                         | `"uv"` (编译为 `uv*` glob allow)    | env_scope allowed_commands |
| `alpha CLI` / `alpha CLI mode` / `alpha CLI (authed)`                                                         | _(删除)_                            | 所有文档                   |
| `alphaxiv overview` / `alphaxiv Smart Search` (外部引用)                                                      | `paper-search skill`                | 所有外部 skill/agent       |
| `INSPIRE-HEP` / `Semantic Scholar` / `PubMed` (外部直接引用)                                                  | `paper-search skill`                | 所有外部 skill/agent       |
| `verification_source: alphaxiv`                                                                               | `verification_source: paper_search` | research-audit             |

> alphaxiv 作为 web 服务 URL 在 paper-search SKILL.md 内部保留。外部 skill/agent 的 alphaxiv 引用必须替换为 paper-search skill 委托。网络健康检查 URL 保留（仅检查可达性）。

**alpha 命令替换策略表**（按文件类型）:

| 文件类型                     | `alpha` 命令替换策略                                                                                 | 示例                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| SKILL.md (paper-search 内部) | 删除所有 alpha CLI 命令描述；保留 arxiv_search.py / alphaxiv URL 作为内部功能                        | `alpha search "..."` → `uv run arxiv_search.py "..."`                                                                            |
| SKILL.md (外部 skill)        | 删除 alpha 命令引用；替换为 paper-search skill 委托意图描述                                          | `use alpha get / alpha ask` → `delegate to research-explorer subagent (paper-search skill)`                                      |
| server.py                    | 删除 alpha CLI 检测逻辑（区域 A）；脚本路径和键名重命名（区域 C/D/E）；新增网络可达检查              | `alpha_research_scripts` → `paper_search_scripts`; `alpha_search` → `paper_search`                                               |
| .ts 测试文件                 | 删除/替换 alpha 命令断言；skill_refs 替换；allowed_commands 替换                                     | `"alpha-research"` → `"paper-search"`; `Permission.evaluate("bash", "alpha test")` → `Permission.evaluate("bash", "uv run ...")` |
| .md agent 配置               | 删除 alpha 命令引用；替换为 paper-search skill 委托                                                  | `alpha-research skill` → `paper-search skill`                                                                                    |
| .md docs (架构文档)          | 删除虚构命令描述；替换 env_scope / skill_refs；保留可验证的真实事实（alphaxiv.org 存在但无 CLI/API） | `alpha CLI mode` → 删除; `alphaxiv 集成` → `paper-search skill（含 alphaxiv webfetch）`                                          |

## 附录 B: 不改动的文件

- `.aether/skills/gpd-*`（4 个物理插件）
- `.aether/skills/research-verification/SKILL.md`（无 alpha CLI 引用）
- `.aether/skills/debate-*`（不引用 alpha）
- `.aether/skills/autoresearch/SKILL.md`（不引用 alpha CLI）
- `.aether/skills/literature-review/references/database_strategies.md`（`alphafold` 是生物学词汇）
- `.aether/skills/literature-review/scripts/` 其他脚本（generate_pdf.py 等，不含 alpha）
- `.aether/mcp/research-conventions/server.py`（不检查 alpha）
- `packages/opencode/src/`（核心源代码，alpha 仅出现在 `\alpha` LaTeX、model status、排序注释）
- `packages/opencode/test/` 其他测试文件（"alpha" 为通用测试数据）
- `.agents/`, `.opencode/`, `AGENTS.md`
