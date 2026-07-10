# /// script
# requires-python = ">=3.11"
# ///
#!/usr/bin/env python3
"""check_qn_artifacts.py — execution专用, Qn驱动验证三文件存在非空.

Usage: uv run check_qn_artifacts.py <research_state.md_path> <Qn1> <Qn2> ...
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
                    "error": "usage: check_qn_artifacts.py <state.md> <Qn1> <Qn2> ...",
                }
            )
        )
        sys.exit(1)

    state_path = Path(args[0])
    qn_ids = args[1:]

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

    suffixes = ["_REASONING.md", "_EXECUTION.md", "_VERIFICATION.md"]

    missing = []
    empty = []

    for qn in qn_ids:
        for suffix in suffixes:
            fname = f"execution/{qn}{suffix}"
            full = workdir / fname
            if not full.exists():
                missing.append(fname)
            elif full.stat().st_size == 0:
                empty.append(fname)

    persistence_dir = research_root / "persistence"
    violations = []
    allowed = {"research_state.md", "ENVIRONMENT.md"}
    if persistence_dir.exists():
        for p in persistence_dir.iterdir():
            if p.is_file() and p.name not in allowed:
                violations.append(str(p.relative_to(research_root)))

    notepads = research_root / "notepads"
    outside = []
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
