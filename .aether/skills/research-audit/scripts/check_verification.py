# /// script
# requires-python = ">=3.11"
# ///
#!/usr/bin/env python3
"""check_verification.py — verify resolved claims have verification records.

Usage: uv run check_verification.py <research_state.md_path>
Output: JSON {ok, unverified_claims}
"""

import json
import re
import sys
from pathlib import Path


def parse_questions_claims(content):
    m = re.search(
        r"^##\s*Questions\s*/\s*Claims\s*\n(.+?)(?=\n##|\Z)",
        content,
        re.MULTILINE | re.DOTALL,
    )
    if not m:
        return []
    block = m.group(1)
    claims = []
    for line in block.splitlines():
        cm = re.match(r"-\s*(Q[\w]+):\s*(.+?)\s*—\s*status:\s*(\w+)", line)
        if not cm:
            continue
        qid, desc, status = cm.group(1), cm.group(2), cm.group(3)
        ver = None
        vm = re.search(r"ver:\s*(\S+)", line)
        if vm:
            ver = vm.group(1).rstrip(",")
        claims.append({"id": qid, "status": status, "ver": ver})
    return claims


def main():
    args = sys.argv[1:]
    if len(args) < 1:
        print(
            json.dumps(
                {"ok": False, "error": "usage: check_verification.py <state.md>"}
            )
        )
        sys.exit(1)

    state_path = Path(args[0])
    research_root = state_path.resolve().parent.parent
    if not state_path.exists():
        print(
            json.dumps(
                {"ok": False, "unverified_claims": ["research_state.md not found"]}
            )
        )
        sys.exit(1)

    content = state_path.read_text()
    claims = parse_questions_claims(content)

    unverified = []
    for c in claims:
        if c["status"] != "resolved":
            continue
        if not c["ver"]:
            unverified.append(f"{c['id']}: no ver path")
            continue
        if not c["ver"].endswith("_VERIFICATION.md"):
            unverified.append(
                f"{c['id']}: ver path must end with _VERIFICATION.md (got {c['ver']})"
            )
            continue
        ver_path = research_root / c["ver"]
        if not ver_path.exists():
            unverified.append(f"{c['id']}: verification file not found ({c['ver']})")
            continue
        try:
            lines = ver_path.read_text().splitlines()
            if len(lines) < 30:
                unverified.append(
                    f"{c['id']}: verification file too short ({len(lines)} lines)"
                )
                continue
            text = "\n".join(lines)
            if not re.search(r"PASS|FAIL|PARTIAL", text, re.IGNORECASE):
                unverified.append(
                    f"{c['id']}: no verdict (PASS/FAIL/PARTIAL) in verification file"
                )
        except OSError as e:
            unverified.append(f"{c['id']}: cannot read verification file ({e})")

    ok = not unverified
    print(json.dumps({"ok": ok, "unverified_claims": unverified}))


if __name__ == "__main__":
    main()
