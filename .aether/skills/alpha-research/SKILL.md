---
name: alpha-research
description: Search, read, and query research papers via the alpha CLI (alphaXiv-backed). Use for academic paper search, full-text reading, paper Q&A, code repository inspection, and annotation management.
---

# Alpha Research CLI

Use the `alpha` CLI via bash for all paper research operations.

## Auth Check (CRITICAL — do this FIRST)

Before using any alpha command, check authentication:

```bash
alpha status
```

If the response indicates no authentication (or the command fails with an auth error):

1. Tell the user: "The alpha CLI requires an alphaXiv account for paper search, reading, and Q&A. You can set up access by running `alpha login`, or I can guide you through the process."
2. Wait for the user's response before proceeding.
3. If the user explicitly declines ("I don't want to create an account" / "skip alpha" / "use arxiv instead" / "no"):
   → Fall back to the `arxiv-search` skill for paper search (limited: titles and abstracts only, no full text, no Q&A, no annotations).
   → For paper reading beyond abstracts, use `webfetch` on arxiv HTML pages where available.
4. If the user agrees:
   → Guide them through `alpha login` and then continue with alpha CLI.

Do NOT silently skip alpha and use arxiv-search without asking. Only fall back when the user explicitly declines.

## Commands

| Command                              | Description                                                                                                                                     |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `alpha search "<query>"`             | Search papers. Prefer `--mode semantic` by default; use `--mode keyword` only for exact-term lookup and `--mode agentic` for broader retrieval. |
| `alpha get <arxiv-id-or-url>`        | Fetch paper content and any local annotation                                                                                                    |
| `alpha get --full-text <arxiv-id>`   | Get raw full text instead of AI report                                                                                                          |
| `alpha ask <arxiv-id> "<question>"`  | Ask a question about a paper's PDF                                                                                                              |
| `alpha code <github-url> [path]`     | Read files from a paper's GitHub repo. Use `/` for overview                                                                                     |
| `alpha annotate <paper-id> "<note>"` | Save a persistent annotation on a paper                                                                                                         |
| `alpha annotate --clear <paper-id>`  | Remove an annotation                                                                                                                            |
| `alpha annotate --list`              | List all annotations                                                                                                                            |

## Auth Setup

```bash
alpha login
```

This opens an authentication flow with alphaXiv. Once authenticated, `alpha status` will show the account info.

## Examples

```bash
alpha search "transformer scaling laws"
alpha search --mode agentic "efficient attention mechanisms for long context"
alpha get 2106.09685
alpha ask 2106.09685 "What optimizer did they use?"
alpha code https://github.com/karpathy/nanoGPT src/model.py
alpha annotate 2106.09685 "Key paper on LoRA - revisit for adapter comparison"
```

## When to use

- Academic paper search, reading, Q&A → `alpha` CLI
- Current topics (products, releases, docs) → `websearch`
- Mixed topics → combine both

## Fallback Behavior

When alpha is unavailable (user declined account):

- Paper search: use `/arxiv-search` skill
- Paper abstracts: `webfetch` on `https://arxiv.org/abs/<id>`
- Paper full text (HTML): `webfetch` on `https://arxiv.org/html/<id>` (available for many papers)
- Paper Q&A: NOT available without alpha — read the full text yourself and answer based on content
- Code inspection: `webfetch` on GitHub repo pages (limited, no file-level access)
- Annotations: NOT available without alpha
