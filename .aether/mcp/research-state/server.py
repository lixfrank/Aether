# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.0", "pydantic>=2.0", "filelock>=3.0"]
# ///
"""MCP server for research project state management.

Provides atomic state advancement, health checks, and progress tracking.
State stored in .aether/research/persistence/state.json.
"""

import json
import os
from pathlib import Path
from typing import Any

from filelock import FileLock
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("research-state")

DEFAULT_STATE_DIR = ".aether/research/persistence"


def _resolve_project_dir(project_dir: str) -> Path:
    if project_dir:
        return Path(project_dir).resolve()
    return Path.cwd().resolve()


def _state_path(project_dir: Path) -> Path:
    return project_dir / DEFAULT_STATE_DIR / "state.json"


def _ensure_state_file(project_dir: Path) -> Path:
    sp = _state_path(project_dir)
    sp.parent.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(sp) + ".lock")
    with lock:
        if not sp.exists():
            sp.write_text(json.dumps({
                "phase": "exploration",
                "plan_number": "0",
                "conventions": {},
                "project_contract": {},
                "progress": {"completed_plans": [], "total_plans": 0},
            }, indent=2))
    return sp


def _read_state(project_dir: Path) -> dict:
    sp = _ensure_state_file(project_dir)
    lock = FileLock(str(sp) + ".lock")
    with lock:
        return json.loads(sp.read_text())


def _write_state(project_dir: Path, state: dict) -> None:
    sp = _state_path(project_dir)
    lock = FileLock(str(sp) + ".lock")
    with lock:
        sp.write_text(json.dumps(state, indent=2))


@mcp.tool()
def get_state(project_dir: str) -> dict[str, Any]:
    """Return structured project state from state.json"""
    pd = _resolve_project_dir(project_dir)
    return _read_state(pd)


@mcp.tool()
def advance_plan(phase: str, plan_number: str, project_dir: str) -> dict[str, Any]:
    """Atomically advance project to next plan in state.json"""
    pd = _resolve_project_dir(project_dir)
    state = _read_state(pd)
    old_phase = state.get("phase", "")
    old_plan = state.get("plan_number", "")
    state.setdefault("progress", {})
    state["progress"].setdefault("completed_plans", [])
    state["progress"]["completed_plans"].append({"phase": old_phase, "plan": old_plan})
    state["phase"] = phase
    state["plan_number"] = plan_number
    _write_state(pd, state)
    return {
        "previous": {"phase": old_phase, "plan": old_plan},
        "current": {"phase": phase, "plan": plan_number},
        "progress": state["progress"],
    }


@mcp.tool()
def validate_state(project_dir: str) -> dict[str, Any]:
    """Validate state.json schema, conventions, phase format"""
    pd = _resolve_project_dir(project_dir)
    state = _read_state(pd)
    errors = []
    if not state.get("phase"):
        errors.append("missing phase")
    if not state.get("plan_number"):
        errors.append("missing plan_number")
    conventions = state.get("conventions", {})
    if not isinstance(conventions, dict):
        errors.append("conventions must be a dict")
    return {"valid": len(errors) == 0, "errors": errors, "state": state}


@mcp.tool()
def get_progress(project_dir: str) -> dict[str, Any]:
    """Return computed progress summary"""
    pd = _resolve_project_dir(project_dir)
    state = _read_state(pd)
    progress = state.get("progress", {})
    completed = progress.get("completed_plans", [])
    total = progress.get("total_plans", 0)
    return {
        "completed_count": len(completed),
        "total_plans": total,
        "current_phase": state.get("phase", ""),
        "current_plan": state.get("plan_number", ""),
        "percentage": (len(completed) / max(total, 1)) * 100 if total else 0,
    }


@mcp.tool()
def run_health_check(project_dir: str, fix: bool = False) -> dict[str, Any]:
    """Full project health dashboard: structure, storage, state validity, conventions, config"""
    pd = _resolve_project_dir(project_dir)
    persistence_dir = pd / DEFAULT_STATE_DIR
    issues = []
    checks = {}

    sp = persistence_dir / "state.json"
    checks["state_file_exists"] = sp.exists()
    if not sp.exists():
        issues.append("state.json missing")
        if fix:
            _ensure_state_file(pd)
            checks["state_file_created"] = True

    state_md = persistence_dir / "STATE.md"
    checks["state_md_exists"] = state_md.exists()
    if not state_md.exists():
        issues.append("STATE.md missing")

    roadmap = persistence_dir / "ROADMAP.md"
    checks["roadmap_exists"] = roadmap.exists()
    if not roadmap.exists():
        issues.append("ROADMAP.md missing")

    if sp.exists():
        state = _read_state(pd)
        checks["state_valid"] = bool(state.get("phase"))
        checks["conventions_count"] = len(state.get("conventions", {}))

    return {
        "healthy": len(issues) == 0,
        "issues": issues,
        "checks": checks,
        "project_dir": str(pd),
    }


if __name__ == "__main__":
    mcp.run()