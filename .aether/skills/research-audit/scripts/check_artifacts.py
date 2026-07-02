# /// script
# requires-python = ">=3.11"
# ///
#!/usr/bin/env python3
"""check_artifacts.py — verify expected files exist, non-empty, in workdir, persistence whitelist.

Usage: uv run check_artifacts.py <research_state.md_path> <expected_file1> <expected_file2> ...
Output: JSON {ok, missing, empty, outside_workdir, persistence_violations}
"""

import json
import re
import sys
from pathlib import Path


def parse_active_workdir(state_path):
    content = Path(state_path).read_text()
    m = re.search(
        r"^##\s*Active Workdir\s*\n(.+?)(?=\n##|\Z)", content, re.MULTILINE | re.DOTALL
    )
    if not m:
        return None
    return m.group(1).strip()


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "usage: check_artifacts.py <state.md> <files...>",
                }
            )
        )
        sys.exit(1)

    state_path = Path(args[0])
    expected_files = args[1:]

    if not state_path.exists():
        print(
            json.dumps(
                {
                    "ok": False,
                    "missing": [str(state_path)],
                    "empty": [],
                    "outside_workdir": [],
                    "persistence_violations": [],
                }
            )
        )
        sys.exit(1)

    workdir_rel = parse_active_workdir(str(state_path))
    research_root = state_path.parent.parent
    workdir = research_root / workdir_rel if workdir_rel else research_root

    missing = []
    empty = []
    outside = []

    for f in expected_files:
        full = workdir / f
        if not full.exists():
            missing.append(str(f))
        elif full.stat().st_size == 0:
            empty.append(str(f))

    persistence_dir = research_root / "persistence"
    violations = []
    allowed = {"research_state.md", "ENVIRONMENT.md"}
    if persistence_dir.exists():
        for p in persistence_dir.iterdir():
            if p.is_file() and p.name not in allowed:
                violations.append(str(p.relative_to(research_root)))

    notepads = research_root / "notepads"
    if workdir_rel and notepads.exists():
        for p in notepads.rglob("*"):
            if p.is_file():
                rel = p.relative_to(research_root)
                if not str(rel).startswith(workdir_rel):
                    outside.append(str(rel))

    ok = not missing and not empty and not outside and not violations
    print(
        json.dumps(
            {
                "ok": ok,
                "missing": missing,
                "empty": empty,
                "outside_workdir": outside,
                "persistence_violations": violations,
            }
        )
    )


if __name__ == "__main__":
    main()
