---
name: arxiv-search
description: Searches arXiv for preprints and academic papers, retrieves abstracts, and filters by topic. Use when the user asks to find research papers, search arXiv, look up preprints, find academic articles in physics, math, CS, biology, statistics, or related fields. Supports alphaxiv deep understanding for structured paper summaries.
---

# arXiv Search Skill

## Search Stage

Run the bundled Python script using uv run with PEP 723 inline dependencies:

```bash
uv run [YOUR_SKILLS_DIR]/arxiv-search/arxiv_search.py "your search query" --max-papers N
```

- `query` (required): Search query string
- `--max-papers` (optional): Maximum results to retrieve (default: 10)

### Example

```bash
uv run .aether/skills/arxiv-search/arxiv_search.py "deep learning drug discovery" --max-papers 5
```

Returns title and abstract for each matching paper, sorted by relevance.

### arXiv Category Prefixes

Use category prefixes for domain-specific searches:

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

### Search Format Examples

```
"cat:hep-ph AND ti:\"dark matter\""
"cat:quant-ph AND ti:\"quantum computing\" AND au:\"preskill\""
"cat:cond-mat AND ti:\"topological insulator\""
```

## Deep Understanding (alphaxiv)

After obtaining arXiv IDs from search, for papers requiring deeper analysis:

1. Construct alphaxiv overview URL: `https://alphaxiv.org/overview/<arxiv_id>`
2. Use webfetch to retrieve the overview page
3. The overview provides structured sections: Key Findings, Methodology, Limitations, Broader Impact
4. Use overview content for research synthesis instead of relying solely on abstracts

**Fallback**: if alphaxiv overview is unavailable (network issues, new papers not yet indexed), use the arXiv abstract from search results.

### alphaxiv URL Construction

arXiv ID → alphaxiv overview URL mapping:

- arXiv ID `2501.12345` → `https://alphaxiv.org/overview/2501.12345`
- arXiv ID `hep-ph/0501234` (old format) → `https://alphaxiv.org/overview/hep-ph/0501234`

### alphaxiv Smart Search

For AI-enhanced discovery beyond keyword matching:

1. Use webfetch on `https://alphaxiv.org/search?q=<search_query>` to get alphaxiv's AI-boosted search results
2. This provides semantically relevant papers beyond exact keyword matches
3. Use as a supplement to arXiv API search, not a replacement

## When to Use Each Mode

| Mode                  | When                               | Action                            |
| --------------------- | ---------------------------------- | --------------------------------- |
| Quick search          | User needs paper list              | Run arxiv_search.py via uv run    |
| Deep understanding    | Need to understand specific papers | webfetch alphaxiv overview        |
| AI-enhanced discovery | Exploratory/broad search           | alphaxiv smart search + arXiv API |

## Dependencies

The arxiv_search.py script uses PEP 723 inline metadata to declare the `arxiv` dependency. `uv run` automatically installs dependencies — no manual pip install needed.
