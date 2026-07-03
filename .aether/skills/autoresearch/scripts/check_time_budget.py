# /// script
# requires-python = ">=3.11"
# ///
#!/usr/bin/env python3
"""check_time_budget.py — per-question time budget for autoresearch.

Tracks elapsed time per question. autoresearch calls `reset` when beginning
work on a question, and `check` after every subagent output verification.
The agent reads the time facts and decides what to do — this script does
not make decisions.

Usage:
  uv run check_time_budget.py <research_state.md_path> <qid> reset [--min M] [--max M]
  uv run check_time_budget.py <research_state.md_path> <qid> check

  M values are in MINUTES (integer). Defaults: min=60 (1h), max=1440 (24h).

Output (JSON):
  reset: {"qid","started_at","action":"reset","min_minutes","max_minutes"}
  check: {"qid","started_at","elapsed_minutes","min_minutes","max_minutes"}
    (started_at/elapsed_minutes null if not reset yet)

Config: --min/--max passed at `reset` are stored per-question in .timing.json.
`check` reads them from there; falls back to script defaults if absent.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_MIN_MINUTES = 60
DEFAULT_MAX_MINUTES = 1440
TIMING_FILENAME = ".timing.json"


def parse_active_workdir(content):
    m = re.search(
        r"^##\s*Active Workdir\s*\n(.+?)(?=\n##|\Z)",
        content,
        re.MULTILINE | re.DOTALL,
    )
    if not m:
        return None
    return m.group(1).strip()


def timing_path(state_path):
    content = state_path.read_text()
    workdir_rel = parse_active_workdir(content)
    research_root = state_path.parent.parent
    return (research_root / workdir_rel) / "execution" / TIMING_FILENAME


def load_timing(tfile):
    if not tfile.exists():
        return {"questions": {}}
    try:
        return json.loads(tfile.read_text())
    except (OSError, json.JSONDecodeError):
        return {"questions": {}}


def save_timing(tfile, data):
    tfile.parent.mkdir(parents=True, exist_ok=True)
    tfile.write_text(json.dumps(data, indent=2))


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def resolve_budget(entry):
    min_m = entry.get("min_minutes", DEFAULT_MIN_MINUTES)
    max_m = entry.get("max_minutes", DEFAULT_MAX_MINUTES)
    return int(min_m), int(max_m)


def do_reset(state_path, qid, min_minutes, max_minutes):
    tfile = timing_path(state_path)
    eff_min = min_minutes if min_minutes is not None else DEFAULT_MIN_MINUTES
    eff_max = max_minutes if max_minutes is not None else DEFAULT_MAX_MINUTES
    if eff_min > eff_max:
        print(
            json.dumps(
                {
                    "qid": qid,
                    "action": "error",
                    "error": f"min({eff_min}) > max({eff_max})",
                }
            )
        )
        return
    data = load_timing(tfile)
    questions = data.setdefault("questions", {})
    entry = {"started_at": now_iso()}
    if min_minutes is not None:
        entry["min_minutes"] = min_minutes
    if max_minutes is not None:
        entry["max_minutes"] = max_minutes
    questions[qid] = entry
    save_timing(tfile, data)
    print(
        json.dumps(
            {
                "qid": qid,
                "started_at": entry["started_at"],
                "action": "reset",
                "min_minutes": eff_min,
                "max_minutes": eff_max,
            }
        )
    )


def do_check(state_path, qid):
    tfile = timing_path(state_path)
    data = load_timing(tfile)
    questions = data.get("questions", {})
    entry = questions.get(qid)
    if not entry or not entry.get("started_at"):
        print(
            json.dumps(
                {
                    "qid": qid,
                    "started_at": None,
                    "elapsed_minutes": None,
                    "min_minutes": DEFAULT_MIN_MINUTES,
                    "max_minutes": DEFAULT_MAX_MINUTES,
                }
            )
        )
        return

    min_m, max_m = resolve_budget(entry)
    started = entry["started_at"]
    try:
        start_dt = datetime.fromisoformat(started)
    except ValueError:
        print(
            json.dumps(
                {
                    "qid": qid,
                    "started_at": started,
                    "elapsed_minutes": None,
                    "min_minutes": min_m,
                    "max_minutes": max_m,
                }
            )
        )
        return

    elapsed_sec = (datetime.now(timezone.utc) - start_dt).total_seconds()
    print(
        json.dumps(
            {
                "qid": qid,
                "started_at": started,
                "elapsed_minutes": round(elapsed_sec / 60, 1),
                "min_minutes": min_m,
                "max_minutes": max_m,
            }
        )
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("state_path")
    parser.add_argument("qid")
    parser.add_argument("action", choices=("reset", "check"))
    parser.add_argument("--min", type=int, dest="min_minutes")
    parser.add_argument("--max", type=int, dest="max_minutes")
    args = parser.parse_args()

    state_path = Path(args.state_path)
    if not state_path.exists():
        print(
            json.dumps(
                {
                    "qid": args.qid,
                    "action": "error",
                    "error": "research_state.md not found",
                }
            )
        )
        sys.exit(1)

    if args.action == "reset":
        do_reset(state_path, args.qid, args.min_minutes, args.max_minutes)
    else:
        do_check(state_path, args.qid)


if __name__ == "__main__":
    main()
