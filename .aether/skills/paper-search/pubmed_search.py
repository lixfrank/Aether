# /// script
# requires-python = ">=3.11"
# dependencies = ["requests>=2.31"]
# ///
#!/usr/bin/env python3
"""PubMed Search.

Searches PubMed for biomedical research papers.
Run with: uv run pubmed_search.py "query" --max-papers N
"""

import argparse
import json
import sys
import time
import xml.etree.ElementTree as ET


def query_pubmed(query: str, max_papers: int = 10) -> str:
    """Query PubMed for papers using ESearch + EFetch.

    Parameters
    ----------
    query : str
        Search query. Supports MeSH terms, boolean operators.
        Examples: "cancer therapy", "diabetes[MeSH Terms]",
                  "aspirin AND cardiovascular"
    max_papers : int
        Maximum number of papers to retrieve (default: 10).
    """
    import requests  # type: ignore[import-not-found]

    base = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"

    try:
        search_url = f"{base}/esearch.fcgi"
        search_params = {
            "db": "pubmed",
            "term": query,
            "retmax": max_papers,
            "retmode": "json",
            "sort": "relevance",
        }
        resp = requests.get(search_url, params=search_params, timeout=30)
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", 3))
            return json.dumps({"error": "rate_limited", "retry_after": retry_after})
        if resp.status_code >= 500:
            return json.dumps({"error": f"HTTP {resp.status_code}"})
        if resp.status_code != 200:
            return json.dumps({"error": f"HTTP {resp.status_code}"})

        search_data = resp.json()
        ids = search_data.get("esearchresult", {}).get("idlist", [])
        if not ids:
            return "No papers found on PubMed."

        time.sleep(0.35)

        fetch_url = f"{base}/efetch.fcgi"
        fetch_params = {
            "db": "pubmed",
            "id": ",".join(ids),
            "retmode": "xml",
            "rettype": "abstract",
        }
        resp = requests.get(fetch_url, params=fetch_params, timeout=30)
        if resp.status_code == 429:
            retry_after = int(resp.headers.get("Retry-After", 3))
            return json.dumps({"error": "rate_limited", "retry_after": retry_after})
        if resp.status_code >= 500:
            return json.dumps({"error": f"HTTP {resp.status_code}"})

        root = ET.fromstring(resp.text)
        results = []
        for article in root.findall(".//PubmedArticle"):
            medline = article.find(".//MedlineCitation")
            art = medline.find(".//Article") if medline else None
            if not art:
                continue

            pmid_el = medline.find(".//PMID")
            pmid = pmid_el.text if pmid_el is not None else ""

            title_el = art.find(".//ArticleTitle")
            title = title_el.text if title_el is not None else ""

            authors_el = art.findall(".//Author")
            author_names = []
            for a in authors_el[:5]:
                last = a.find("LastName")
                fore = a.find("ForeName")
                if last is not None and fore is not None:
                    author_names.append(f"{last.text} {fore.text}")
                elif last is not None:
                    author_names.append(last.text)
            if len(authors_el) > 5:
                author_names.append("et al.")

            journal_el = art.find(".//Journal/ISOAbbreviation")
            journal = journal_el.text if journal_el is not None else ""

            year_el = art.find(".//Journal/JournalIssue/PubDate/Year")
            year = year_el.text if year_el is not None else ""

            doi_el = article.find(".//ArticleIdList/ArticleId[@IdType='doi']")
            doi = doi_el.text if doi_el is not None else ""

            abstract_parts = art.findall(".//Abstract/AbstractText")
            abstract = " ".join((p.text or "") for p in abstract_parts if p.text)

            result = {
                "pmid": pmid,
                "title": title,
                "authors": ", ".join(author_names),
                "journal": journal,
                "year": year,
                "doi": doi,
                "abstract": abstract,
            }
            results.append(result)

        return json.dumps(results, indent=2, ensure_ascii=False)

    except ET.ParseError:
        return json.dumps({"error": "json_parse_failed"})
    except json.JSONDecodeError:
        return json.dumps({"error": "json_parse_failed"})
    except Exception as e:
        return json.dumps({"error": str(e)})


def main() -> None:
    parser = argparse.ArgumentParser(description="Search PubMed for biomedical papers")
    parser.add_argument("query", type=str, help="Search query (supports MeSH terms)")
    parser.add_argument(
        "--max-papers", type=int, default=10, help="Maximum results (default: 10)"
    )
    args = parser.parse_args()

    result = query_pubmed(args.query, max_papers=args.max_papers)
    print(result)

    if "--rate-limit-test" in sys.argv:
        time.sleep(0.35)


if __name__ == "__main__":
    main()
