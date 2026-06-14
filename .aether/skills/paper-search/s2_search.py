# /// script
# requires-python = ">=3.11"
# dependencies = ["requests>=2.31"]
# ///
#!/usr/bin/env python3
"""Semantic Scholar Search.

Searches Semantic Scholar for research papers across all disciplines.
Run with: uv run s2_search.py "query" --max-papers N
"""

import argparse
import json
import sys


def query_s2(query: str, max_papers: int = 10) -> str:
    """Query Semantic Scholar for papers.

    Parameters
    ----------
    query : str
        Search query string.
    max_papers : int
        Maximum number of papers to retrieve (default: 10).
    """
    import requests  # type: ignore[import-not-found]

    url = "https://api.semanticscholar.org/graph/v1/paper/search"
    fields = "title,abstract,year,citationCount,arxivId,doi,fieldsOfStudy,authors"
    params = {"query": query, "limit": max_papers, "fields": fields}

    try:
        resp = requests.get(url, params=params, timeout=30)
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", 5))
            return json.dumps({"error": "rate_limited", "retry_after": retry_after})
        if resp.status_code >= 500:
            return json.dumps({"error": f"HTTP {resp.status_code}"})
        if resp.status_code != 200:
            return json.dumps({"error": f"HTTP {resp.status_code}"})

        data = resp.json()
        papers = data.get("data", [])
        if not papers:
            return "No papers found on Semantic Scholar."

        results = []
        for p in papers:
            author_names = [a.get("name", "") for a in (p.get("authors") or [])[:5]]
            if len(p.get("authors") or []) > 5:
                author_names.append("et al.")

            result = {
                "title": p.get("title", ""),
                "abstract": p.get("abstract", ""),
                "year": p.get("year"),
                "citationCount": p.get("citationCount", 0),
                "arxiv_id": p.get("arxivId", ""),
                "doi": p.get("doi", ""),
                "fieldsOfStudy": p.get("fieldsOfStudy", []),
                "authors": ", ".join(author_names),
            }
            results.append(result)

        return json.dumps(results, indent=2, ensure_ascii=False)

    except json.JSONDecodeError:
        return json.dumps({"error": "json_parse_failed"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def main() -> None:
    parser = argparse.ArgumentParser(description="Search Semantic Scholar for papers")
    parser.add_argument("query", type=str, help="Search query string")
    parser.add_argument(
        "--max-papers", type=int, default=10, help="Maximum results (default: 10)"
    )
    args = parser.parse_args()

    result = query_s2(args.query, max_papers=args.max_papers)
    print(result)


if __name__ == "__main__":
    main()
