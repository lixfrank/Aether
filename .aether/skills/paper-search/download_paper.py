# /// script
# requires-python = ">=3.11"
# dependencies = ["requests>=2.31"]
# ///
#!/usr/bin/env python3
"""Download open-access research papers with source-first policy.

Supports arXiv (source tarball + PDF), Unpaywall (DOI -> OA link), and
PubMed Central OA (DOI -> PMC PDF). Each paper is saved in its own
subdirectory with source.tar.gz, main.tex, paper.pdf, references.bib,
meta.json, and index.json tracking has_source/source_files/tex_path/bib_path.

Run with: uv run download_paper.py [options]
"""

import argparse
import json
import re
import shutil
import tarfile
import tempfile
import time
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

import requests

SESSION = requests.Session()
SESSION.headers.update({"User-Agent": "Aether-PaperDownloader/2.0"})


def update_registry(
    literatures_dir, paper_id, paper_type, title, authors, year, filename
):
    """Append entry to literatures/registry.json for source verification.

    Enables check_sources.py to verify: citation [src:id] → registry has id → file exists.
    """
    registry_path = Path(literatures_dir) / "registry.json"
    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        registry = {"entries": []}
    if any(e.get("id") == paper_id for e in registry.get("entries", [])):
        return
    if isinstance(authors, str):
        authors = [authors] if authors else []
    elif not isinstance(authors, list):
        authors = list(authors) if authors else []
    try:
        year = int(year)
    except (ValueError, TypeError):
        pass
    registry.setdefault("entries", []).append(
        {
            "id": paper_id,
            "type": paper_type,
            "title": title,
            "authors": authors,
            "year": year,
            "file": filename,
            "downloaded_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    registry_path.write_text(
        json.dumps(registry, indent=2, ensure_ascii=False), encoding="utf-8"
    )


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


def _extract_source_tarball(arxiv_id: str, paper_dir: Path) -> dict:
    """Download and extract arXiv source tarball (e-format).

    Returns dict with has_source, source_files, tex_path, bib_path.
    """
    source_url = f"https://arxiv.org/e-print/{arxiv_id}"
    try:
        resp = SESSION.get(source_url, timeout=60, stream=True)
        if resp.status_code != 200:
            return {
                "has_source": False,
                "source_files": [],
                "tex_path": None,
                "bib_path": None,
            }

        tmp_tar = paper_dir / "_source_tmp.tar.gz"
        with open(tmp_tar, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)

        if tmp_tar.stat().st_size < 1000:
            tmp_tar.unlink()
            return {
                "has_source": False,
                "source_files": [],
                "tex_path": None,
                "bib_path": None,
            }

        shutil.copy2(tmp_tar, paper_dir / "source.tar.gz")

        try:
            with tarfile.open(tmp_tar, "r:gz") as tar:
                tar.extractall(paper_dir / "source_extracted")
        except tarfile.TarError:
            try:
                with tarfile.open(tmp_tar, "r") as tar:
                    tar.extractall(paper_dir / "source_extracted")
            except tarfile.TarError:
                tmp_tar.unlink(missing_ok=True)
                return {
                    "has_source": False,
                    "source_files": [],
                    "tex_path": None,
                    "bib_path": None,
                }

        tmp_tar.unlink(missing_ok=True)

        extracted = paper_dir / "source_extracted"
        tex_files = list(extracted.rglob("*.tex"))
        bib_files = list(extracted.rglob("*.bib"))

        main_tex = None
        for tf in tex_files:
            name = tf.name.lower()
            if (
                name in ("main.tex", "paper.tex", "article.tex")
                or tf.stat().st_size
                > max((f.stat().st_size for f in tex_files), default=0) * 0.5
            ):
                main_tex = tf
                break
        if not main_tex and tex_files:
            main_tex = max(tex_files, key=lambda f: f.stat().st_size)

        if main_tex:
            shutil.copy2(main_tex, paper_dir / "main.tex")

        main_bib = None
        if bib_files:
            main_bib = max(bib_files, key=lambda f: f.stat().st_size)
            shutil.copy2(main_bib, paper_dir / "references.bib")

        source_files = [str(f.relative_to(extracted)) for f in tex_files + bib_files]

        return {
            "has_source": True,
            "source_files": source_files,
            "tex_path": "main.tex" if main_tex else None,
            "bib_path": "references.bib" if main_bib else None,
        }

    except Exception:
        return {
            "has_source": False,
            "source_files": [],
            "tex_path": None,
            "bib_path": None,
        }


def download_arxiv_pdf(arxiv_id: str, paper_dir: Path) -> Optional[str]:
    url = f"https://arxiv.org/pdf/{arxiv_id}.pdf"
    try:
        resp = SESSION.get(url, timeout=60, stream=True)
        if resp.status_code != 200:
            return None
        dest = paper_dir / "paper.pdf"
        with open(dest, "wb") as f:
            for chunk in resp.iter_content(chunk_size=8192):
                f.write(chunk)
        if dest.stat().st_size < 5000:
            dest.unlink()
            return None
        return "paper.pdf"
    except Exception:
        return None


def download_by_arxiv_id(
    arxiv_id: str,
    output_dir: Path,
    paper: dict,
    prefer_source: bool = True,
    prefer_pdf: bool = False,
) -> Optional[str]:
    if is_already_downloaded(arxiv_id, output_dir):
        print(f"  [skip] {arxiv_id} already in index")
        return None

    paper_dir = output_dir / arxiv_id
    paper_dir.mkdir(parents=True, exist_ok=True)

    source_info = {
        "has_source": False,
        "source_files": [],
        "tex_path": None,
        "bib_path": None,
    }
    pdf_name = None

    if prefer_source and not prefer_pdf:
        source_info = _extract_source_tarball(arxiv_id, paper_dir)
        pdf_name = download_arxiv_pdf(arxiv_id, paper_dir)
    elif prefer_pdf:
        pdf_name = download_arxiv_pdf(arxiv_id, paper_dir)
        if not pdf_name:
            source_info = _extract_source_tarball(arxiv_id, paper_dir)
    else:
        source_info = _extract_source_tarball(arxiv_id, paper_dir)
        pdf_name = download_arxiv_pdf(arxiv_id, paper_dir)

    if not pdf_name and not source_info["has_source"]:
        shutil.rmtree(paper_dir, ignore_errors=True)
        append_unavailable(paper, "arXiv PDF and source unavailable", output_dir)
        print(f"  [fail] {arxiv_id} arXiv PDF+source unavailable")
        return None

    meta = {
        "arxiv_id": arxiv_id,
        "doi": paper.get("doi", ""),
        "title": paper.get("title", ""),
        "authors": paper.get("authors", ""),
        "year": paper.get("year", ""),
        "download_date": date.today().isoformat(),
        "relevance": paper.get("relevance", ""),
    }
    (paper_dir / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    entry = {
        "arxiv_id": arxiv_id,
        "doi": paper.get("doi", ""),
        "title": paper.get("title", ""),
        "authors": paper.get("authors", ""),
        "year": paper.get("year", ""),
        "download_source": "arxiv",
        "download_date": date.today().isoformat(),
        "relevance": paper.get("relevance", ""),
        "has_source": source_info["has_source"],
        "source_files": source_info["source_files"],
        "tex_path": source_info["tex_path"],
        "bib_path": source_info["bib_path"],
    }
    if pdf_name:
        entry["pdf_path"] = pdf_name

    index = load_index(output_dir)
    index.append(entry)
    save_index(index, output_dir)
    file_path = f"{paper_dir.name}/{pdf_name}" if pdf_name else paper_dir.name
    update_registry(
        output_dir,
        arxiv_id,
        "arxiv",
        paper.get("title", ""),
        paper.get("authors", ""),
        paper.get("year", ""),
        file_path,
    )
    print(f"  [ok] {arxiv_id} → {paper_dir.name}")
    return paper_dir.name


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
        m = re.search(r'<link\s+format="pdf"\s+href="([^"]+)"', text)
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


def download_by_doi(
    doi: str,
    output_dir: Path,
    paper: dict,
    prefer_source: bool = True,
    prefer_pdf: bool = False,
) -> Optional[str]:
    if is_already_downloaded(doi, output_dir):
        print(f"  [skip] DOI {doi} already in index")
        return None
    if paper.get("arxiv_id"):
        result = download_by_arxiv_id(
            paper["arxiv_id"],
            output_dir,
            paper,
            prefer_source=prefer_source,
            prefer_pdf=prefer_pdf,
        )
        if result:
            return result

    paper_dir = output_dir / sanitize_filename(doi)
    paper_dir.mkdir(parents=True, exist_ok=True)

    pdf_url = _unpaywall_url(doi)
    if not pdf_url:
        pdf_url = _pmc_oa_url(doi)

    if not pdf_url:
        shutil.rmtree(paper_dir, ignore_errors=True)
        append_unavailable(
            paper, "No open-access PDF found (paywall or restricted)", output_dir
        )
        print(f"  [fail] DOI {doi} no OA PDF available")
        return None

    tmp = paper_dir / "_tmp.pdf"
    if not _download_pdf_from_url(pdf_url, tmp):
        if tmp.exists():
            tmp.unlink()
        shutil.rmtree(paper_dir, ignore_errors=True)
        append_unavailable(
            paper, f"OA link found but download failed ({pdf_url})", output_dir
        )
        print(f"  [fail] DOI {doi} download from OA link failed")
        return None

    final = paper_dir / "paper.pdf"
    tmp.rename(final)

    src = "unpaywall" if "unpaywall" in pdf_url.lower() else "pmc_oa"

    meta = {
        "doi": doi,
        "arxiv_id": paper.get("arxiv_id", ""),
        "title": paper.get("title", ""),
        "authors": paper.get("authors", ""),
        "year": paper.get("year", ""),
        "download_date": date.today().isoformat(),
        "relevance": paper.get("relevance", ""),
    }
    (paper_dir / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False), encoding="utf-8"
    )

    entry = {
        "arxiv_id": paper.get("arxiv_id", ""),
        "doi": doi,
        "title": paper.get("title", ""),
        "authors": paper.get("authors", ""),
        "year": paper.get("year", ""),
        "download_source": src,
        "download_date": date.today().isoformat(),
        "relevance": paper.get("relevance", ""),
        "has_source": False,
        "source_files": [],
        "tex_path": None,
        "bib_path": None,
        "pdf_path": "paper.pdf",
    }

    index = load_index(output_dir)
    index.append(entry)
    save_index(index, output_dir)
    update_registry(
        output_dir,
        doi,
        "doi",
        paper.get("title", ""),
        paper.get("authors", ""),
        paper.get("year", ""),
        f"{paper_dir.name}/paper.pdf",
    )
    print(f"  [ok] DOI {doi} → {paper_dir.name}")
    return paper_dir.name


def download_batch(
    papers: list[dict],
    output_dir: Path,
    prefer_source: bool = True,
    prefer_pdf: bool = False,
) -> dict:
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    report = {"downloaded": [], "failed": [], "skipped": []}
    for p in papers:
        arxiv = p.get("arxiv_id", "")
        doi = p.get("doi", "")
        if arxiv:
            result = download_by_arxiv_id(
                arxiv, output_dir, p, prefer_source=prefer_source, prefer_pdf=prefer_pdf
            )
            if result:
                report["downloaded"].append({"id": arxiv, "path": result})
            else:
                report["failed"].append({"id": arxiv, "type": "arxiv"})
        elif doi:
            result = download_by_doi(
                doi, output_dir, p, prefer_source=prefer_source, prefer_pdf=prefer_pdf
            )
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
    parser = argparse.ArgumentParser(
        description="Download open-access papers (source-first)"
    )
    parser.add_argument("--arxiv", help="arXiv ID to download")
    parser.add_argument("--doi", help="DOI to download")
    parser.add_argument("--batch", help="JSON file with list of papers to download")
    parser.add_argument(
        "--output", default=".aether/research/literatures", help="Output directory"
    )
    parser.add_argument(
        "--relevance", default="", help="Relevance tag (included/key/representative)"
    )
    parser.add_argument(
        "--prefer-source",
        action="store_true",
        default=True,
        help="Prefer source tarball over PDF (default)",
    )
    parser.add_argument(
        "--prefer-pdf", action="store_true", help="Prefer PDF over source tarball"
    )
    args = parser.parse_args()

    output_dir = Path(args.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    if args.batch:
        papers = json.loads(Path(args.batch).read_text(encoding="utf-8"))
        for p in papers:
            if args.relevance:
                p["relevance"] = args.relevance
        report = download_batch(
            papers,
            output_dir,
            prefer_source=args.prefer_source,
            prefer_pdf=args.prefer_pdf,
        )
        rp = output_dir / "download_report.json"
        rp.write_text(
            json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        print(f"Report saved to: {rp}")
    elif args.arxiv:
        paper = {"arxiv_id": args.arxiv, "relevance": args.relevance}
        download_by_arxiv_id(
            args.arxiv,
            output_dir,
            paper,
            prefer_source=args.prefer_source,
            prefer_pdf=args.prefer_pdf,
        )
    elif args.doi:
        paper = {"doi": args.doi, "relevance": args.relevance}
        download_by_doi(
            args.doi,
            output_dir,
            paper,
            prefer_source=args.prefer_source,
            prefer_pdf=args.prefer_pdf,
        )
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
