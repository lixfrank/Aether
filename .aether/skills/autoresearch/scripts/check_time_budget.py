# /// script
# requires-python = ">=3.11"
# ///
#!/usr/bin/env python3
"""check_time_budget.py — per-question time budget for autoresearch.

Single control for "how long to keep trying on a question". Replaces fixed
retry caps (cycle max 3, file-verification max 2). autoresearch calls `reset`
when beginning work on a question (or re-examining a resolved one), and `check`
after every subagent output verification (file verification or verdict).

Usage:
  uv run check_time_budget.py <research_state.md_path> <qid> reset [--min M] [--max M]
  uv run check_time_budget.py <research_state.md_path> <qid> check

  M values are in MINUTES (integer). Defaults: min=60 (1h), max=1440 (24h).

Output (JSON):
  reset: {"qid","started_at","action":"reset","min_minutes","max_minutes"}
  check: {"qid","started_at","elapsed_minutes","zone","action",
          "remaining_to_min_minutes","remaining_to_max_minutes","min_minutes","max_minutes"}
    zone:   below_min | between | above_max | not_started
    action: must_continue | self_judge | hard_stop | error

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
    if not workdir_rel:
        return None
    research_root = state_path.parent.parent
    workdir = research_root / workdir_rel
    return workdir, workdir / "execution" / TIMING_FILENAME


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
    workdir, tfile = timing_path(state_path)
    if not tfile:
        print(json.dumps({"qid": qid, "action": "error", "error": "no Active Workdir"}))
        return
    if (
        min_minutes is not None
        and max_minutes is not None
        and min_minutes > max_minutes
    ):
        print(
            json.dumps(
                {
                    "qid": qid,
                    "action": "error",
                    "error": f"min({min_minutes}) > max({max_minutes})",
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
    final_min, final_max = resolve_budget(entry)
    print(
        json.dumps(
            {
                "qid": qid,
                "started_at": entry["started_at"],
                "action": "reset",
                "min_minutes": final_min,
                "max_minutes": final_max,
            }
        )
    )


def do_check(state_path, qid):
    workdir, tfile = timing_path(state_path)
    if not tfile:
        print(json.dumps({"qid": qid, "action": "error", "error": "no Active Workdir"}))
        return
    data = load_timing(tfile)
    questions = data.get("questions", {})
    entry = questions.get(qid)
    if not entry or not entry.get("started_at"):
        print(
            json.dumps(
                {
                    "qid": qid,
                    "zone": "not_started",
                    "action": "error",
                    "error": "no timing record, call reset first",
                }
            )
        )
        return

    min_m, max_m = resolve_budget(entry)
    if min_m > max_m:
        print(
            json.dumps(
                {"qid": qid, "action": "error", "error": f"min({min_m}) > max({max_m})"}
            )
        )
        return

    started = entry["started_at"]
    try:
        start_dt = datetime.fromisoformat(started)
    except ValueError:
        print(json.dumps({"qid": qid, "action": "error", "error": "bad started_at"}))
        return
    elapsed_sec = (datetime.now(timezone.utc) - start_dt).total_seconds()
    min_sec = min_m * 60
    max_sec = max_m * 60

    if elapsed_sec < min_sec:
        zone, action = "below_min", "must_continue"
    elif elapsed_sec < max_sec:
        zone, action = "between", "self_judge"
    else:
        zone, action = "above_max", "hard_stop"

    rem_min = round((min_sec - elapsed_sec) / 60, 1)
    rem_max = round((max_sec - elapsed_sec) / 60, 1)

    print(
        json.dumps(
            {
                "qid": qid,
                "started_at": started,
                "elapsed_minutes": round(elapsed_sec / 60, 1),
                "zone": zone,
                "action": action,
                "remaining_to_min_minutes": rem_min,
                "remaining_to_max_minutes": rem_max,
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
