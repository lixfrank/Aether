---
name: alpha-research
description: Search, read, and query research papers. Two modes: (1) alpha CLI mode — semantic search, full text, paper Q&A, code inspection, annotations (requires alphaXiv login); (2) no-login mode — keyword search with category filtering, title + abstract only. Use for all academic paper operations.
---

# Alpha Research

Unified skill for academic paper search, reading, Q&A, and annotation. Operates in two modes depending on authentication status.

## Mode Selection (CRITICAL — do this FIRST)

Before any paper operation, check alpha CLI authentication:

```bash
alpha status
```

### Alpha CLI Mode (authenticated)

If `alpha status` shows a valid account → use **alpha CLI mode** (full capabilities):

| Command                              | Description                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `alpha search "<query>"`             | Search papers. Prefer `--mode semantic` by default; use `--mode keyword` for exact-term lookup and `--mode agentic` for broader retrieval. |
| `alpha get <arxiv-id-or-url>`        | Fetch paper content and any local annotation                                                                                               |
| `alpha get --full-text <arxiv-id>`   | Get raw full text instead of AI report                                                                                                     |
| `alpha ask <arxiv-id> "<question>"`  | Ask a question about a paper's PDF                                                                                                         |
| `alpha code <github-url> [path]`     | Read files from a paper's GitHub repo. Use `/` for overview                                                                                |
| `alpha annotate <paper-id> "<note>"` | Save a persistent annotation on a paper                                                                                                    |
| `alpha annotate --clear <paper-id>`  | Remove an annotation                                                                                                                       |
| `alpha annotate --list`              | List all annotations                                                                                                                       |

### No-Login Mode (arXiv API search)

If `alpha status` indicates no authentication, or the user has not yet set up an account → use **no-login mode** (limited: titles and abstracts only, no full text, no Q&A, no annotations):

```bash
uv run .aether/skills/alpha-research/arxiv_search.py "your search query" --max-papers N
```

- `query` (required): Search query string, supports arXiv category prefixes and field tags
- `--max-papers` (optional): Maximum results to retrieve (default: 10)

**arXiv Category Prefixes** for domain-specific searches:

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

**Deep Understanding (alphaxiv web)** — available without login:

After obtaining arXiv IDs from search, for papers requiring deeper analysis:

1. Construct alphaxiv overview URL: `https://alphaxiv.org/overview/<arxiv_id>`
2. Use webfetch to retrieve the overview page
3. The overview provides structured sections: Key Findings, Methodology, Limitations, Broader Impact
4. Use overview content for research synthesis instead of relying solely on abstracts
5. Fallback: if alphaxiv overview is unavailable, use the arXiv abstract from search results

**alphaxiv Smart Search** — AI-enhanced discovery without login:

1. Use webfetch on `https://alphaxiv.org/search?q=<search_query>` for semantically relevant papers
2. Use as supplement to arXiv API keyword search, not a replacement

### Mode Decision Flow

1. Run `alpha status`
2. Authenticated → alpha CLI mode
3. Not authenticated → tell the user:

   "The alpha CLI requires an alphaXiv account for full-text reading, paper Q&A, code inspection, and annotations. You can set up access by running `alpha login` — see account setup guide below. For now, I'll use the no-login mode (titles and abstracts only)."

4. If user explicitly declines alphaXiv account → stay in no-login mode
5. If user agrees to set up account → guide through `alpha login` (see below), then switch to alpha CLI mode

Do NOT silently skip alpha CLI mode without informing the user of the capability difference.

## AlphaXiv Account Setup

To unlock full capabilities (full text, Q&A, code inspection, annotations), create a free alphaXiv account:

1. Run `alpha login` — this opens an authentication flow with alphaXiv
2. If the browser doesn't open automatically, visit https://alphaxiv.org and create an account, then link it via `alpha login`
3. After authentication, `alpha status` will show your account info
4. Once authenticated, all alpha CLI commands are available

**Account benefits**:

- Full paper text (not just abstracts)
- AI-powered paper Q&A
- GitHub code repository inspection
- Persistent annotations across sessions
- Semantic search (meaning-based, not just keywords)

## When to Use Each Mode

| Mode                  | When                                   | Action                           |
| --------------------- | -------------------------------------- | -------------------------------- |
| Alpha CLI (authed)    | Need full text, Q&A, code, annotations | alpha CLI commands               |
| No-login (no auth)    | Quick paper list, no account needed    | arxiv_search.py via uv run       |
| alphaxiv web          | Deep understanding without login       | webfetch alphaxiv overview       |
| alphaxiv smart search | Exploratory/broad semantic discovery   | alphaxiv.org/search via webfetch |

## No-Login Mode Examples

```bash
uv run .aether/skills/alpha-research/arxiv_search.py "deep learning drug discovery" --max-papers 5
uv run .aether/skills/alpha-research/arxiv_search.py "cat:hep-ph AND ti:dark matter" --max-papers 20
```

## Alpha CLI Mode Examples

```bash
alpha search "transformer scaling laws"
alpha search --mode agentic "efficient attention mechanisms for long context"
alpha get 2106.09685
alpha ask 2106.09685 "What optimizer did they use?"
alpha code https://github.com/karpathy/nanoGPT src/model.py
alpha annotate 2106.09685 "Key paper on LoRA - revisit for adapter comparison"
```

## When to Use (General)

- Academic paper search, reading, Q&A → this skill (alpha-research)
- Current topics (products, releases, docs) → websearch
- Mixed topics → combine both

## Dependencies

The arxiv_search.py script uses PEP 723 inline metadata to declare the `arxiv` dependency. `uv run` automatically installs dependencies — no manual pip install needed.
