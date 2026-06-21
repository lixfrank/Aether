#!/bin/bash
# Backup repair target files before dispatching repair worker.
# Usage: backup_repair.sh <phase> <round>
#   phase: audit_1 | audit_2 | audit_3 | debate
#   round: repair round number (1, 2, 3...)
#
# Backs up to <file>.pre_audit_repair_round<round> (audit) or <file>.pre_repair_round<round> (debate).
# Files are determined by phase — this script is the single source of truth for backup file lists.
# Exit code 0 = all files backed up; 1 = error.

set -euo pipefail

phase="$1"
round="$2"
base=".aether/research"

if [ -z "$phase" ] || [ -z "$round" ]; then
  echo "Usage: backup_repair.sh <phase> <round>" >&2
  exit 1
fi

# Resolve notepads slug (single slug directory expected)
slug_dir=$(ls -d "$base"/notepads/*/ 2>/dev/null | head -1)
if [ -z "$slug_dir" ]; then
  echo "ERROR: no notepads slug directory found under $base/notepads/" >&2
  exit 1
fi
slug_dir="${slug_dir%/}"  # strip trailing slash

backup_file() {
  local src="$1"
  local suffix="$2"
  if [ -f "$src" ]; then
    cp "$src" "${src}${suffix}"
  fi
}

case "$phase" in
  audit_1)
    suffix=".pre_audit_repair_round${round}"
    backup_file "$base/persistence/ROADMAP.md" "$suffix"
    backup_file "$slug_dir/research_analysis.md" "$suffix"
    ;;
  audit_2)
    suffix=".pre_audit_repair_round${round}"
    backup_file "$base/persistence/ROADMAP.md" "$suffix"
    backup_file "$slug_dir/research_analysis.md" "$suffix"
    backup_file "$slug_dir/landscape_map.md" "$suffix"
    ;;
  audit_3)
    suffix=".pre_audit_repair_round${round}"
    backup_file "$slug_dir/framing_reasoning.md" "$suffix"
    backup_file "$base/persistence/PLAN.md" "$suffix"
    backup_file "$slug_dir/research_questions.md" "$suffix"
    backup_file "$base/persistence/ROADMAP.md" "$suffix"
    backup_file "$slug_dir/landscape_map.md" "$suffix"
    ;;
  debate)
    suffix=".pre_repair_round${round}"
    backup_file "$base/persistence/PLAN.md" "$suffix"
    ;;
  *)
    echo "ERROR: unknown phase '$phase'. Must be audit_1|audit_2|audit_3|debate" >&2
    exit 1
    ;;
esac

echo "OK: backed up $phase repair files (round $round)"
