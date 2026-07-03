---
name: paper-search
owner: research
description: |
  Multi-database paper search, download (source-first), citation extraction,
  and citation discovery (strictly limited). Four modes: (1) Multi-Database
  Search, (2) Paper Download, (3) Citation Extraction, (4) Citation Discovery.
  Downloads write to literatures/registry.json for source verification.
---

# paper-search Skill

paper-search 是文献检索与下载的 skill。标准调用方式：经 research-explorer
subagent 调用（research-explorer 管理搜索策略 + 跨库去重）。搜索与下载脚本在
.aether/skills/paper-search/ 下，经 `uv run` 执行。

## Invocation Protocol

External skills/agents describe **search intent + domain** only (e.g. "search
hep-ph dark matter", "find papers on cancer immunotherapy"). paper-search
internally selects the appropriate database(s) and modes.

## Mode 1: Multi-Database Search

### 1a arXiv Search

```bash
uv run .aether/skills/paper-search/arxiv_search.py "your search query" --max-papers N
```

- `query` (required): Search query string, supports arXiv category prefixes and field tags
- `--max-papers` (optional): Maximum results to retrieve (default: 10)

**arXiv Category Prefixes**:

- `cat:hep-ph` — High Energy Physics - Phenomenology
- `cat:hep-th` — High Energy Physics - Theory
- `cat:gr-qc` — General Relativity and Quantum Cosmology
- `cat:cond-mat` — Condensed Matter
- `cat:quant-ph` — Quantum Physics
- `cat:math-ph` — Mathematical Physics
- `cat:astro-ph` — Astrophysics
- `cat:cs.LG` — Machine Learning (CS)
- `cat:stat.ML` — Machine Learning (Statistics)
- `cat:q-bio` — Quantitative Biology

**Search Format Examples**:

```
"cat:hep-ph AND ti:\"dark matter\""
"cat:quant-ph AND ti:\"quantum computing\" AND au:\"preskill\""
"cat:cond-mat AND ti:\"topological insulator\""
```

### 1b INSPIRE-HEP Search

```bash
uv run .aether/skills/paper-search/inspire_search.py "query" --max-papers N
```

- `query` (required): Supports SPIRES syntax:
  - `find a witten` — search by author
  - `find t "dark matter"` — search by title
  - `find k "supersymmetry"` — search by keyword
  - `find eprint 2406.01705` — search by arXiv ID
- `--max-papers` (optional): Maximum results (default: 10)
- Rate limit: ~15 requests per 5 seconds

### 1c Semantic Scholar Search

```bash
uv run .aether/skills/paper-search/s2_search.py "query" --max-papers N
```

- `query` (required): Search query string
- `--max-papers` (optional): Maximum results (default: 10)
- No authentication required
- Returns: title, abstract, year, citationCount, arxiv_id, doi, fieldsOfStudy

### 1d PubMed Search

```bash
uv run .aether/skills/paper-search/pubmed_search.py "query" --max-papers N
```

- `query` (required): Supports MeSH terms and boolean operators
  - `"cancer therapy"` — basic search
  - `"diabetes[MeSH Terms]"` — MeSH term search
  - `"aspirin AND cardiovascular"` — boolean search
- `--max-papers` (optional): Maximum results (default: 10)
- Rate limit: ~3 requests per second
- Returns: pmid, title, authors, journal, year, doi, abstract

### Search Mode Selection

| Domain      | Recommended databases |
| ----------- | --------------------- |
| Physics     | arXiv + INSPIRE-HEP   |
| CS          | arXiv + S2            |
| Biomedical  | PubMed + S2           |
| Cross-field | S2 + arXiv            |

## Mode 2: Paper Download

```bash
uv run .aether/skills/paper-search/download_paper.py [options]
```

**source-first policy**: Source tarball (tex + bib) is preferred over PDF. When source is available, the download directory contains extracted `.tex` and `.bib` files alongside the PDF.

**Parameters**:

- `--arxiv <ID>` — Download by arXiv ID
- `--doi <DOI>` — Download by DOI
- `--batch <JSON_FILE>` — Batch download from JSON list
- `--output <DIR>` — Output directory (default: `.aether/research/literatures`)
- `--relevance <TAG>` — Relevance tag (included/key/representative)
- `--prefer-source` — Prefer source tarball over PDF (default behavior)
- `--prefer-pdf` — Prefer PDF only (no source extraction)

**Per-paper subdirectory output structure** (when source available):

```
<output_dir>/<arxiv_id>/
  source.tar.gz       # Original arXiv source tarball
  source_extracted/   # Extracted source files
  main.tex            # Largest/main .tex file
  paper.pdf           # PDF version
  references.bib      # Largest .bib file
  meta.json           # Paper metadata
```

**registry.json** (in output root) tracks all downloads for source verification.
Each successful download appends an entry with fields:

- `id` — arXiv ID or DOI
- `type` — "arxiv" | "doi"
- `title` — Paper title
- `authors` — Authors
- `year` — Publication year
- `file` — Relative path from literatures/ to downloaded file (e.g. `2305.12345/paper.pdf`)
- `downloaded_at` — ISO 8601 timestamp

Dedup: by `id` — if already registered, skip.

This enables check_sources.py to verify: citation `[src:2305.12345]` → registry.json has `id=2305.12345` → `literatures/2305.12345/` exists.

**index.json** (in output root) also tracks downloads with fields:

- `has_source` — Whether source tarball was extracted
- `source_files` — List of .tex/.bib files found
- `tex_path` — Path to main.tex (relative to subdirectory)
- `bib_path` — Path to references.bib (relative to subdirectory)

**unavailable.md** logs papers that could not be downloaded.

**Reading downloaded files**: Use the `read` tool to inspect `.tex` and `.pdf` files in the local directory after download.

## Mode 3: Citation Extraction

```bash
uv run .aether/skills/paper-search/extract_citations.py [options]
```

**Parameters**:

- `--paper-dir <DIR>` — Paper directory containing `references.bib`
- `--arxiv <ID>` — arXiv ID (auto-locates paper directory)
- `--output <DIR>` — Output directory for JSON result
- `--include-non-arxiv` — Include citations without arXiv IDs or DOIs
- `--format json` — Output format (default: json)

**JSON output format**:

```json
{
  "source_paper": { ... },
  "citations": [
    { "arxiv_id": "...", "doi": "...", "title": "...", "authors": "...", "year": "..." }
  ],
  "stats": { "total": N, "with_arxiv_id": M, "with_doi": K }
}
```

**Edge cases**:

- No `.bib` found → returns `{"error": "No references.bib found"}`, run Mode 2 download first
- Old arXiv IDs (e.g. `hep-th/9901001`) → handled by regex fallback
- arXiv ID extraction priority: `eprint+archiveprefix` → `eprint+eprinttype` → bare `eprint+regex` → `url` containing `arxiv.org` → `journal` containing `arXiv:`
- DOI extraction priority: `doi` field → `url` containing `doi.org/`

## Mode 4: Citation Discovery (STRICTLY LIMITED)

**Purpose**: Expand from 2-3 confirmed highly relevant core papers to discover additional related work.

**Strict limits**:

- Only start from 2-3 core papers confirmed as highly relevant
- depth ≤ 1 (depth=2 only for foundational/seminal works)
- 5-15 papers per round
- > 20 papers → stop immediately
- Every cited paper must first be screened by abstract for relevance before downloading

**Workflow**:

1. Search (Mode 1) → obtain core papers
2. Screen abstracts → identify 2-3 highly relevant core papers
3. Download source (Mode 2) → get `references.bib`
4. Extract citations (Mode 3) → obtain citation list
5. Screen by abstract → filter for relevance (skip irrelevant)
6. Download relevant → only papers that pass abstract screening

**DO NOT**:

- Start citation discovery from >3 core papers
- Go beyond depth=1 unless the paper is foundational (depth=2 requires explicit justification)
- Download >15 papers per round
- Continue if total cited papers exceeds 20

## alphaxiv Web Overview (internal only)

For papers requiring deeper understanding, alphaxiv overview provides structured AI-generated summaries:

- Overview URL: `https://alphaxiv.org/overview/<arxiv_id>`
- Smart Search URL: `https://alphaxiv.org/search?q=<search_query>`

Use webfetch to retrieve overview pages. alphaxiv overview provides: Key Findings, Methodology, Limitations, Broader Impact.

If alphaxiv overview is unavailable, fallback to arXiv abstract from search results.

## Usage Decision Flow

1. **Search** → Use Mode 1 (select database by domain)
2. **Download** → Use Mode 2 (source-first by default, writes registry.json)
3. **Understand** → Use alphaxiv web overview (internal) for structured summary
4. **Extract** → Use Mode 3 (requires .bib from Mode 2 download)
5. **Discover** → Use Mode 4 (strictly limited, depth ≤1)
6. **Smart search** → Use alphaxiv Smart Search as supplement to Mode 1

## Default Download Directory

`.aether/research/literatures` — shared across all phases.

## Dependencies

All scripts use PEP 723 inline metadata. `uv run` automatically installs dependencies — no manual pip install needed.

| Script               | PEP 723 dependencies                  |
| -------------------- | ------------------------------------- |
| arxiv_search.py      | `arxiv>=2.1`                          |
| inspire_search.py    | `requests>=2.31`                      |
| s2_search.py         | `requests>=2.31`                      |
| pubmed_search.py     | `requests>=2.31`                      |
| extract_citations.py | `bibtexparser>=1.4`, `requests>=2.31` |
| download_paper.py    | `requests>=2.31`                      |
