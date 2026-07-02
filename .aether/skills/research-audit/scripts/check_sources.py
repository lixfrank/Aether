# /// script
# requires-python = ">=3.11"
# ///
#!/usr/bin/env python3
"""check_sources.py — verify [src:id] citations have downloaded files in registry.

Usage: uv run check_sources.py <file1> <file2> ...
Output: JSON {ok, cited_without_source, missing_files}
"""

import json
import re
import sys
from pathlib import Path

LITERATURES_DIR = Path(".aether/research/literatures")
SRC_PATTERN = re.compile(r"\[src:([^\]]+)\]")


def load_registry():
    reg = LITERATURES_DIR / "registry.json"
    if not reg.exists():
        return None
    try:
        return json.loads(reg.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def main():
    files = sys.argv[1:]
    if not files:
        print(json.dumps({"ok": False, "error": "usage: check_sources.py <files...>"}))
        sys.exit(1)

    registry = load_registry()
    reg_ids = set()
    if registry and "entries" in registry:
        reg_ids = {e.get("id", "") for e in registry["entries"]}

    cited = set()
    for f in files:
        try:
            content = Path(f).read_text()
            cited.update(SRC_PATTERN.findall(content))
        except (OSError, FileNotFoundError):
            pass

    cited_without_source = []
    missing_files = []

    for sid in sorted(cited):
        in_reg = sid in reg_ids
        file_exists = any(LITERATURES_DIR.glob(f"{sid}*"))
        if not in_reg and not file_exists:
            cited_without_source.append(sid)
        elif in_reg and not file_exists:
            missing_files.append(sid)

    ok = not cited_without_source and not missing_files
    print(
        json.dumps(
            {
                "ok": ok,
                "cited_without_source": cited_without_source,
                "missing_files": missing_files,
            }
        )
    )


if __name__ == "__main__":
    main()
