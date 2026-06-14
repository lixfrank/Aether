# /// script
# requires-python = ">=3.11"
# dependencies = ["requests>=2.31"]
# ///
#!/usr/bin/env python3
"""INSPIRE-HEP Search.

Searches the INSPIRE-HEP high-energy physics literature database.
Run with: uv run inspire_search.py "query" --max-papers N
"""

import argparse
import json
import sys
import time


def query_inspire(query: str, max_papers: int = 10) -> str:
    """Query INSPIRE-HEP for papers.

    Parameters
    ----------
    query : str
        Search query. Supports SPIRES syntax:
        - find a witten -> search by author
        - find t "dark matter" -> search by title
        - find k "supersymmetry" -> search by keyword
        - find eprint 2406.01705 -> search by arXiv ID
    max_papers : int
        Maximum number of papers to retrieve (default: 10).
    """
    import requests  # type: ignore[import-not-found]

    url = "https://inspirehep.net/api/literature"
    params = {"q": query, "size": max_papers, "sort": "mostrecent"}

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
        hits = data.get("hits", {}).get("hits", [])
        if not hits:
            return "No papers found on INSPIRE-HEP."

        results = []
        for hit in hits:
            md = hit.get("metadata", {})
            arxiv_eprints = md.get("arxiv_eprints", [])
            arxiv_id = arxiv_eprints[0].get("value", "") if arxiv_eprints else ""
            dois = md.get("dois", [])
            doi = dois[0].get("value", "") if dois else ""
            authors = md.get("authors", [])
            author_names = [a.get("full_name", "") for a in authors[:5]]
            if len(authors) > 5:
                author_names.append("et al.")

            result = {
                "title": md.get("titles", [{}])[0].get("title", ""),
                "authors": ", ".join(author_names),
                "arxiv_id": arxiv_id,
                "doi": doi,
                "citation_count": md.get("citation_count", 0),
                "abstract": md.get("abstracts", [{}])[0].get("value", ""),
                "date": md.get("creation_date", ""),
            }
            results.append(result)

        return json.dumps(results, indent=2, ensure_ascii=False)

    except json.JSONDecodeError:
        return json.dumps({"error": "json_parse_failed"})
    except requests.exceptions.Timeout:
        return json.dumps({"error": "timeout"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Search INSPIRE-HEP for physics papers"
    )
    parser.add_argument("query", type=str, help="Search query (supports SPIRES syntax)")
    parser.add_argument(
        "--max-papers", type=int, default=10, help="Maximum results (default: 10)"
    )
    args = parser.parse_args()

    result = query_inspire(args.query, max_papers=args.max_papers)
    print(result)

    if "--rate-limit-test" in sys.argv:
        time.sleep(0.35)


if __name__ == "__main__":
    main()
