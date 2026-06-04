# /// script
# requires-python = ">=3.11"
# dependencies = ["requests>=2.31"]
# ///
#!/usr/bin/env python3
"""Download open-access research papers to local literatures folder.

Supports arXiv (direct PDF), Unpaywall (DOI → OA link), and
PubMed Central OA (DOI → PMC PDF). Failed downloads are logged
to unavailable.md with full metadata.

Run with: uv run download_paper.py [options]
"""

import argparse
import json
import re
import time
from datetime import date
from pathlib import Path
from typing import Optional

import requests

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "Aether-LiteratureDownloader/1.0"})


def sanitize_filename(name: str) -> str:
    cleaned = re.sub(r"[^\w\-.]", "_", name)
    return re.sub(r"_+", "_", cleaned).strip("_")


def build_filename(paper: dict, id_val: str) -> str:
    first = paper.get("first_author", paper.get("authors", "unknown"))
    if isinstance(first, str) and "," in first:
        first = first.split(",")[0].strip()
    if isinstance(first, list) and first:
        first = first[0]
    first = sanitize_filename(str(first))
    yr = str(paper.get("year", "0000"))
    sid = sanitize_filename(id_val)
    return f"{first}_{yr}_{sid}"


def load_index(output_dir: Path) -> list[dict]:
    idx = output_dir / "index.json"
    if idx.exists():
        return json.loads(idx.read_text(encoding="utf-8"))
    return []


def save_index(index: list[dict], output_dir: Path) -> None:
    idx = output_dir / "index.json"
    idx.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")


def is_already_downloaded(identifier: str, output_dir: Path) -> bool:
    for entry in load_index(output_dir):
        if entry.get("arxiv_id") == identifier or entry.get("doi") == identifier:
            return True
    return False


def append_unavailable(paper: dict, reason: str, output_dir: Path) -> None:
    uf = output_dir / "unavailable.md"
    header = "# Unavailable Literature\n\nPapers that could not be downloaded (paywall, no OA version, or network error).\n\n"
    if not uf.exists():
        uf.write_text(header, encoding="utf-8")
    title = paper.get("title", "Untitled")
    authors = paper.get("authors", "Unknown")
    journal = paper.get("journal", paper.get("source", "N/A"))
    year = paper.get("year", "N/A")
    url = paper.get("url", "")
    doi = paper.get("doi", "")
    arxiv = paper.get("arxiv_id", "")
    lines = [
        f"## {title}",
        f"- **Authors**: {authors}",
        f"- **Journal/Source**: {journal}",
        f"- **Year**: {year}",
    ]
    if doi:
        lines.append(f"- **DOI**: [{doi}](https://doi.org/{doi})")
    if arxiv:
        lines.append(f"- **arXiv**: [{arxiv}](https://arxiv.org/abs/{arxiv})")
    if url:
        lines.append(f"- **URL**: {url}")
    lines.append(f"- **Reason**: {reason}")
    lines.append("")
    content = uf.read_text(encoding="utf-8")
    content += "\n".join(lines) + "\n"
    uf.write_text(content, encoding="utf-8")


def download_arxiv_pdf(arxiv_id: str, output_dir: Path) -> Optional[str]:
    url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"
    try:
        resp = SESSION.get(url, timeout=60, stream=True)
        if resp.status_code != 200:
            return None
        fname = f"unknown_0000_{sanitize_filename(arxiv_id)}.pdf"
        dest = output_dir / fname
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        if dest.stat().st_size < 5000:
            dest.unlink()
            return None
        return fname
    except Exception:
        return None


def download_by_arxiv_id(arxiv_id: str, output_dir: Path, paper: dict) -> Optional[str]:
    if is_already_downloaded(arxiv_id, output_dir):
        print(f"  [skip] {arxiv_id} already in index")
        return None
    fname = download_arxiv_pdf(arxiv_id, output_dir)
    if fname:
        final = output_dir / (build_filename(paper, arxiv_id) + ".pdf")
        (output_dir / fname).rename(final)
        entry = {
            "arxiv_id": arxiv_id,
            "doi": paper.get("doi", ""),
            "title": paper.get("title", ""),
            "authors": paper.get("authors", ""),
            "year": paper.get("year", ""),
            "local_path": final.name,
            "download_source": "arxiv",
            "download_date": date.today().isoformat(),
            "relevance": paper.get("relevance", ""),
        }
        index = load_index(output_dir)
        index.append(entry)
        save_index(index, output_dir)
        print(f"  [ok] {arxiv_id} → {final.name}")
        return final.name
    append_unavailable(paper, "arXiv PDF download failed", output_dir)
    print(f"  [fail] {arxiv_id} arXiv PDF unavailable")
    return None


def _unpaywall_url(doi: str) -> Optional[str]:
    url = f"https://api.unpaywall.org/v2/{doi}?email=aether@opencode.ai"
    try:
        resp = SESSION.get(url, timeout=15)
        if resp.status_code != 200:
            return None
        data = resp.json()
        best = data.get("best_oa_location") or {}
        url_for_pdf = best.get("url_for_pdf") or best.get("url")
        return url_for_pdf if url_for_pdf else None
    except Exception:
        return None


def _pmc_oa_url(doi: str) -> Optional[str]:
    url = f"https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id={doi}"
    try:
        resp = SESSION.get(url, timeout=15)
        if resp.status_code != 200:
            return None
        text = resp.text
        m = re.search(r"<link\s+format=\"pdf\"\s+href=\"([^\"]+)\"", text)
        if m:
            return m.group(1)
        return None
    except Exception:
        return None


def _download_pdf_from_url(pdf_url: str, dest: Path) -> bool:
    try:
        resp = SESSION.get(pdf_url, timeout=60, stream=True, allow_redirects=True)
        if resp.status_code != 200:
            return False
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        return dest.stat().st_size >= 5000
    except Exception:
        return False


def download_by_doi(doi: str, output_dir: Path, paper: dict) -> Optional[str]:
    if is_already_downloaded(doi, output_dir):
        print(f"  [skip] DOI {doi} already in index")
        return None
    if paper.get("arxiv_id"):
        result = download_by_arxiv_id(paper["arxiv_id"], output_dir, paper)
        if result:
            return result

    pdf_url = _unpaywall_url(doi)
    if not pdf_url:
        pdf_url = _pmc_oa_url(doi)

    if not pdf_url:
        append_unavailable(paper, "No open-access PDF found (paywall or restricted)", output_dir)
        print(f"  [fail] DOI {doi} no OA PDF available")
        return None

    tmp = output_dir / f"_tmp_{sanitize_filename(doi)}.pdf"
    if not _download_pdf_from_url(pdf_url, tmp):
        if tmp.exists():
            tmp.unlink()
        append_unavailable(paper, f"OA link found but download failed ({pdf_url})", output_dir)
        print(f"  [fail] DOI {doi} download from OA link failed")
        return None

    final = output_dir / (build_filename(paper, doi) + ".pdf")
    tmp.rename(final)
    src = "unpaywall" if "unpaywall" in pdf_url.lower() else "pmc_oa"
    entry = {
        "arxiv_id": paper.get("arxiv_id", ""),
        "doi": doi,
        "title": paper.get("title", ""),
        "authors": paper.get("authors", ""),
        "year": paper.get("year", ""),
        "local_path": final.name,
        "download_source": src,
        "download_date": date.today().isoformat(),
        "relevance": paper.get("relevance", ""),
    }
    index = load_index(output_dir)
    index.append(entry)
    save_index(index, output_dir)
    print(f"  [ok] DOI {doi} → {final.name}")
    return final.name


def download_batch(papers: list[dict], output_dir: Path) -> dict:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = {"downloaded": [], "failed": [], "skipped": []}
    for p in papers:
        arxiv = p.get("arxiv_id", "")
        doi = p.get("doi", "")
        if arxiv:
            result = download_by_arxiv_id(arxiv, output_dir, p)
            if result:
                report["downloaded"].append({"id": arxiv, "path": result})
            else:
                report["failed"].append({"id": arxiv, "type": "arxiv"})
        elif doi:
            result = download_by_doi(doi, output_dir, p)
            if result:
                report["downloaded"].append({"id": doi, "path": result})
            else:
                report["failed"].append({"id": doi, "type": "doi"})
        else:
            append_unavailable(p, "No arXiv ID or DOI provided", output_dir)
            report["skipped"].append(p.get("title", "unknown"))
            print(f"  [skip] no identifier for: {p.get('title', 'unknown')}")
        time.sleep(0.5)
    print(f"\n  Downloaded: {len(report['downloaded'])}")
    print(f"  Failed: {len(report['failed'])}")
    print(f"  Skipped: {len(report['skipped'])}")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description="Download open-access papers")
    parser.add_argument("--arxiv", help="arXiv ID to download")
    parser.add_argument("--doi", help="DOI to download")
    parser.add_argument("--batch", help="JSON file with list of papers to download")
    parser.add_argument("--output", default=".aether/research/literatures", help="Output directory")
    parser.add_argument("--relevance", default="", help="Relevance tag (included/key/representative)")
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.batch:
        papers = json.loads(Path(args.batch).read_text(encoding="utf-8"))
        for p in papers:
            if args.relevance:
                p["relevance"] = args.relevance
        report = download_batch(papers, output_dir)
        rp = output_dir / "download_report.json"
        rp.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"Report saved to: {rp}")
    elif args.arxiv:
        paper = {"arxiv_id": args.arxiv, "relevance": args.relevance}
        download_by_arxiv_id(args.arxiv, output_dir, paper)
    elif args.doi:
        paper = {"doi": args.doi, "relevance": args.relevance}
        download_by_doi(args.doi, output_dir, paper)
    else:
        parser.print_help()


if __name__ == "__main__":
    main()