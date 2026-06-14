# /// script
# requires-python = ">=3.11"
# dependencies = ["arxiv>=2.1"]
# ///
#!/usr/bin/env python3
"""arXiv Search.

Searches the arXiv preprint repository for research papers.
Run with: uv run arxiv_search.py "query" --max-papers N
"""

import argparse
import json
import sys


def query_arxiv(query: str, max_papers: int = 10) -> str:
    try:
        import arxiv  # type: ignore[import-not-found]
    except ImportError:
        return json.dumps(
            {
                "error": "arxiv package not installed. Run with 'uv run' for automatic dependency installation."
            }
        )

    try:
        client = arxiv.Client()
        search = arxiv.Search(
            query=query, max_results=max_papers, sort_by=arxiv.SortCriterion.Relevance
        )
        results = []
        for paper in client.results(search):
            results.append(
                {
                    "title": paper.title,
                    "authors": ", ".join(a.name for a in paper.authors[:5])
                    + (" et al." if len(paper.authors) > 5 else ""),
                    "summary": paper.summary,
                    "arxiv_id": paper.get_short_id()
                    if hasattr(paper, "get_short_id")
                    else paper.entry_id.split("/")[-1],
                    "pdf_url": paper.pdf_url,
                    "published": str(paper.published.date()) if paper.published else "",
                    "categories": [str(c) for c in paper.categories]
                    if paper.categories
                    else [],
                }
            )
        if not results:
            return json.dumps({"error": "no_results"})
        return json.dumps(results, indent=2, ensure_ascii=False)
    except arxiv.ArxivError as e:
        msg = str(e).lower()
        if "429" in msg or "rate" in msg or "too many" in msg:
            return json.dumps({"error": "rate_limited", "retry_after": 5})
        if "5" in msg and any(
            c in msg
            for c in ["server", "internal", "unavailable", "timeout", "gateway"]
        ):
            return json.dumps({"error": "HTTP 5xx"})
        return json.dumps({"error": str(e)})
    except json.JSONDecodeError:
        return json.dumps({"error": "json_parse_failed"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def main() -> None:
    parser = argparse.ArgumentParser(description="Search arXiv for research papers")
    parser.add_argument("query", type=str, help="Search query string")
    parser.add_argument(
        "--max-papers", type=int, default=10, help="Maximum results (default: 10)"
    )
    args = parser.parse_args()
    result = query_arxiv(args.query, max_papers=args.max_papers)
    print(result)


if __name__ == "__main__":
    main()
