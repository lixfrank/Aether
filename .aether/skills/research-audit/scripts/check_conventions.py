# /// script
# requires-python = ">=3.11"
# ///
#!/usr/bin/env python3
"""check_conventions.py — verify ASSERT_CONVENTION lines + convention completeness + cross-field consistency.

Usage: uv run check_conventions.py <research_state.md_path> <files_to_check...>
Output: JSON {ok, mismatches, critical_unset, cross_field_warnings}

Loads cross-field rules from domain convention skill (e.g. gpd-conventions/references/cross_field_rules.json).
Non-physics domains without a convention skill are skipped automatically.
"""

import json
import re
import sys
from pathlib import Path

CRITICAL_KEYS = {"metric_signature", "fourier_convention", "natural_units"}
ASSERT_PATTERN = re.compile(r"<!--\s*ASSERT_CONVENTION:\s*(\w+)=([^\s]+)\s*-->")
CONVENTION_SKILL_RELPATH = "skills/plugins/gpd/gpd-conventions/references"


def parse_conventions(content):
    m = re.search(
        r"^##\s*Conventions\s*\n(.+?)(?=\n##|\Z)", content, re.MULTILINE | re.DOTALL
    )
    if not m:
        return {}
    block = m.group(1)
    convs = {}
    for line in block.splitlines():
        cm = re.match(r"-\s*(\w+):\s*(.+)", line)
        if cm:
            convs[cm.group(1)] = cm.group(2).strip()
    return convs


def load_cross_field_rules(project_root):
    rules_path = (
        project_root / ".aether" / CONVENTION_SKILL_RELPATH / "cross_field_rules.json"
    )
    if not rules_path.exists():
        return None
    try:
        return json.loads(rules_path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def main():
    args = sys.argv[1:]
    if len(args) < 2:
        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "usage: check_conventions.py <state.md> <files...>",
                }
            )
        )
        sys.exit(1)

    state_path = Path(args[0])
    files_to_check = args[1:]

    if not state_path.exists():
        print(
            json.dumps(
                {
                    "ok": False,
                    "mismatches": [],
                    "critical_unset": [],
                    "cross_field_warnings": [],
                }
            )
        )
        sys.exit(1)

    content = state_path.read_text()
    conventions = parse_conventions(content)

    if not conventions:
        print(
            json.dumps(
                {
                    "ok": True,
                    "mismatches": [],
                    "critical_unset": [],
                    "cross_field_warnings": [],
                    "note": "no conventions set — skipped (non-physics domain or not yet set)",
                }
            )
        )
        sys.exit(0)

    mismatches = []
    for f in files_to_check:
        try:
            fcontent = Path(f).read_text()
        except (OSError, FileNotFoundError):
            continue
        for m in ASSERT_PATTERN.finditer(fcontent):
            key, val = m.group(1), m.group(2)
            expected = conventions.get(key)
            if expected and expected != val:
                mismatches.append(f"{f}:{key}:expected={expected}:actual={val}")

    critical_unset = [k for k in CRITICAL_KEYS if k not in conventions]

    cross_warnings = []
    project_root = Path(".")
    rules = load_cross_field_rules(project_root)
    if rules:
        for rule in rules if isinstance(rules, list) else rules.get("rules", []):
            keys = rule.get("keys", [])
            if all(k in conventions for k in keys):
                actual = "|".join(f"{k}={conventions[k]}" for k in keys)
                triggers = rule.get("trigger_combinations", [])
                if actual in triggers:
                    cross_warnings.append(
                        rule.get("warning", f"{' & '.join(keys)}: {actual}")
                    )

    ok = not mismatches and not critical_unset
    print(
        json.dumps(
            {
                "ok": ok,
                "mismatches": mismatches,
                "critical_unset": critical_unset,
                "cross_field_warnings": cross_warnings,
            }
        )
    )


if __name__ == "__main__":
    main()
