# newlayer-9: paper-search skill 修改

> 原 `.aether/skills/paper-search/SKILL.md` (264行) + 脚本目录
> 对应设计文档 §7.2 check_sources（registry 闭环 anti-fabrication）

---

## 修改原因与设计依据

**大方向**：paper-search 需与 check_sources.py 形成闭环——下载文献时写 registry.json，使 check_sources 能验证"正文引用 [src:id] → registry 有注册 → 磁盘有下载文件"，从确定性层面防止编造来源。
**设计依据**：design doc §7.2（结构 checker check_sources）、§9 约束 1（不编造来源）。
**具体决策理由**：

- 不改目录名/路径：`literatures/` 目录名保留，路径不变（`.aether/research/literatures/`）。功能变更是添加 `registry.json`，非改名
- registry.json 写入逻辑：download_paper.py 下载成功后追加条目到 registry.json（id/type/title/authors/year/file），使 check_sources 能按 id 查注册+查文件存在
- 保留 research-explorer 为标准搜索接口：research-explorer 提供集中搜索策略 + 跨库去重 + 干净接口，非 FSM 产物，有真实价值。删除的是 Path 1/2/3 分类和"NOT the intended usage pattern"禁止性语言，不是 research-explorer 本身

## 删除

| 段落                                                                                                                             | 理由              |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| "Invocation Protocol (D7)" 中 "Direct invocation by primary agent via skill tool is NOT the intended usage pattern" 的禁止性语言 | 过度限制          |
| "Path 1 / Path 2/3" 的调用区分（旧 Entry Gate 路径）                                                                             | 不再有 Entry Gate |

## 保留

- Mode 1 (Multi-Database Search): arXiv / INSPIRE-HEP / Semantic Scholar / PubMed / Crossref 搜索脚本
- Mode 2 (Paper Download): download_paper.py
- Mode 3 (Citation Extraction): extract_citations.py
- Mode 4 (Citation Discovery)
- 所有搜索/下载脚本本身（arxiv_search.py / inspire_search.py / s2_search.py / pubmed_search.py / download_paper.py / extract_citations.py）— 不变
- research-explorer 作为标准搜索接口 — 保留（集中搜索策略 + 跨库去重 + 干净接口）
- 下载目录 `literatures/` 路径不变

## 修改

### M1. 调用方式（删除禁止性语言，保留 research-explorer）

```markdown
# 旧

> Sole entry point: Other skills/agents must delegate to paper-search
> rather than directly calling alphaxiv...
> Invocation protocol (D7): paper-search skill is loaded and invoked by
> the research-explorer subagent. Primary agent/coordinator dispatches
> research-explorer... Direct invocation by primary agent via skill tool
> is NOT the intended usage pattern — it only applies in Path 1...

# 新

paper-search 是文献检索与下载的 skill。标准调用方式：经 research-explorer
subagent 调用（research-explorer 管理搜索策略 + 跨库去重）。搜索与下载脚本在
.aether/skills/paper-search/ 下，经 `uv run` 执行。

（删除 Path 1/2/3 区分和"NOT the intended usage pattern"禁止性语言。
research-explorer 仍是标准搜索接口，但不再用禁止性语言限制其他调用方式。）
```

### M2. registry.json 写入逻辑（关键：anti-fabrication 闭环）

download_paper.py 下载成功后，追加条目到 `literatures/registry.json`：

```python
# download_paper.py 新增逻辑
def update_registry(literatures_dir, paper_id, paper_type, title, authors, year, filename):
    registry_path = os.path.join(literatures_dir, "registry.json")
    # 读现有 registry
    registry = read_json(registry_path) or {"entries": []}
    # 去重: 按 id 检查是否已存在
    if any(e["id"] == paper_id for e in registry["entries"]):
        return  # 已注册, 跳过
    # 追加
    registry["entries"].append({
        "id": paper_id,
        "type": paper_type,  # "arxiv" | "doi"
        "title": title,
        "authors": authors,
        "year": year,
        "file": filename,
        "downloaded_at": iso_now()
    })
    write_json(registry_path, registry)
```

这使得 check_sources.py 能验证：正文引用 [src:2305.12345] → registry.json 有 id=2305.12345 → literatures/2305.12345.pdf 存在。无下载文件 = 编造风险。

---

## 对 newlayer-7 的影响

check_sources.py 的路径引用需同步更新：

- 旧：查 `persistence/sources/registry.json` + `sources/<id>.*`
- 新：查 `.aether/research/literatures/registry.json` + `literatures/<id>.*`

---

## 预期结果

- SKILL.md 从 264行 → ~250行（删 Path 分类 + 禁止性语言，加 registry 闭环说明）
- download_paper.py 新增 ~20行 registry 更新逻辑
- check_sources.py 验证引用→下载文件映射（路径指向 literatures/）
