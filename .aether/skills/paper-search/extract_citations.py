# /// script
# requires-python = ">=3.11"
# dependencies = ["bibtexparser>=1.4", "requests>=2.31"]
# ///
#!/usr/bin/env python3
"""Citation Extraction from .bib files.

Extracts citations from a paper's references.bib file, identifying
arXiv IDs and DOIs for downstream discovery.
Run with: uv run extract_citations.py --paper-dir DIR --format json
"""

import argparse
import json
import re
import sys
from pathlib import Path


def _extract_arxiv_id(entry: dict) -> str:
    """Extract arXiv ID from a BibTeX entry using priority rules.

    Priority: eprint+archiveprefix → eprint+eprinttype → bare eprint+regex
    → url containing arxiv.org → journal containing 'arXiv:'
    """
    eprint = entry.get("eprint", "")
    archiveprefix = entry.get("archiveprefix", "")
    eprinttype = entry.get("eprinttype", "")
    url = entry.get("url", "")
    journal = entry.get("journal", "")

    if eprint and archiveprefix and "arxiv" in archiveprefix.lower():
        return eprint

    if eprint and eprinttype and "arxiv" in eprinttype.lower():
        return eprint

    if eprint and re.match(r"\d{4}\.\d{4,5}", eprint):
        return eprint

    if url and "arxiv.org" in url:
        m = re.search(r"(?:abs|pdf)/(\d{4}\.\d{4,5})", url)
        if m:
            return m.group(1)

    if journal and "arXiv:" in journal:
        m = re.search(r"arXiv:(\d{4}\.\d{4,5})", journal)
        if m:
            return m.group(1)

    return ""


def _extract_doi(entry: dict) -> str:
    """Extract DOI from a BibTeX entry.

    Priority: doi field → url containing doi.org/
    """
    doi = entry.get("doi", "")
    if doi:
        return doi

    url = entry.get("url", "")
    if url and "doi.org" in url:
        m = re.search(r"doi\.org/(10\.\d{4,9}/[^\s]+)", url)
        if m:
            return m.group(1)

    return ""


def extract_citations(paper_dir: Path, include_non_arxiv: bool = False) -> dict:
    """Extract citations from references.bib in a paper directory.

    Parameters
    ----------
    paper_dir : Path
        Directory containing references.bib and meta.json.
    include_non_arxiv : bool
        If True, include citations without arXiv IDs or DOIs.
    """
    try:
        import bibtexparser  # type: ignore[import-not-found]
    except ImportError:
        return {
            "error": "bibtexparser not installed. Run with 'uv run extract_citations.py' for automatic dependency installation."
        }

    bib_path = paper_dir / "references.bib"
    if not bib_path.exists():
        return {"error": f"No references.bib found in {paper_dir}"}

    meta_path = paper_dir / "meta.json"
    source_paper = {}
    if meta_path.exists():
        try:
            source_paper = json.loads(meta_path.read_text(encoding="utf-8"))
        except json.JSONDecodeError:
            pass

    try:
        bib_content = bib_path.read_text(encoding="utf-8")
        bib_db = bibtexparser.loads(bib_content)
    except Exception as e:
        return {"error": f"Failed to parse .bib: {e}"}

    citations = []
    for entry in bib_db.entries:
        arxiv_id = _extract_arxiv_id(entry)
        doi = _extract_doi(entry)
        title = entry.get("title", "")
        authors = entry.get("author", "")
        year = entry.get("year", "")

        if not include_non_arxiv and not arxiv_id and not doi:
            continue

        citation = {
            "arxiv_id": arxiv_id,
            "doi": doi,
            "title": title,
            "authors": authors,
            "year": year,
            "entry_type": entry.get("ENTRYTYPE", ""),
        }
        citations.append(citation)

    with_arxiv = sum(1 for c in citations if c["arxiv_id"])
    with_doi = sum(1 for c in citations if c["doi"])

    return {
        "source_paper": source_paper,
        "citations": citations,
        "stats": {
            "total": len(citations),
            "with_arxiv_id": with_arxiv,
            "with_doi": with_doi,
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Extract citations from .bib files")
    parser.add_argument(
        "--paper-dir", type=str, help="Paper directory containing references.bib"
    )
    parser.add_argument(
        "--arxiv", type=str, help="arXiv ID (auto-locate paper directory)"
    )
    parser.add_argument(
        "--output", type=str, default=None, help="Output directory for JSON result"
    )
    parser.add_argument(
        "--include-non-arxiv",
        action="store_true",
        help="Include citations without arXiv IDs",
    )
    parser.add_argument(
        "--format", choices=["json"], default="json", help="Output format"
    )
    args = parser.parse_args()

    if args.paper_dir:
        paper_dir = Path(args.paper_dir)
    elif args.arxiv:
        default_dir = Path(args.output or ".aether/research/literatures") / args.arxiv
        paper_dir = default_dir
    else:
        parser.print_help()
        sys.exit(1)

    result = extract_citations(paper_dir, include_non_arxiv=args.include_non_arxiv)

    if args.output:
        out = Path(args.output)
        out.mkdir(parents=True, exist_ok=True)
        out_file = out / f"citations_{args.arxiv or paper_dir.name}.json"
        out_file.write_text(
            json.dumps(result, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"Citations saved to: {out_file}")
    else:
        print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
