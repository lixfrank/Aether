# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.0", "pydantic>=2.0", "filelock>=3.0"]
# ///
"""MCP server for research convention lock management.

Provides atomic convention locking with file-lock protection.
Domain-specific defaults loaded from skill references via skill_resolve_path.
"""

import json
import os
import re
from pathlib import Path
from typing import Any

from filelock import FileLock
from mcp.server.fastmcp import FastMCP

mcp = FastMCP("research-conventions")

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
            sp.write_text(json.dumps({"conventions": {}, "project_contract": {}}, indent=2))
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


SKILL_DIRS = []


def _init_skill_dirs():
    global SKILL_DIRS
    home = Path.home()
    candidates = [
        home / ".aether" / "skill",
        home / ".opencode" / "skills",
        home / ".claude" / "skills",
        home / ".agents" / "skills",
    ]
    cwd = Path.cwd()
    candidates.extend([
        cwd / ".aether" / "skill",
        cwd / ".opencode" / "skills",
    ])
    for d in candidates:
        if d.exists():
            SKILL_DIRS.append(d)


_init_skill_dirs()


def _find_skill_dir(skill_name: str) -> Path | None:
    for base in SKILL_DIRS:
        for skill_md in base.rglob("SKILL.md"):
            try:
                content = skill_md.read_text()
                if content.startswith("---"):
                    end = content.find("---", 3)
                    if end != -1:
                        frontmatter = content[3:end]
                        for line in frontmatter.splitlines():
                            if line.strip().startswith("name:"):
                                name = line.split(":", 1)[1].strip().strip('"').strip("'")
                                if name == skill_name:
                                    return skill_md.parent
            except Exception:
                continue
    return None


@mcp.tool()
def convention_lock_status(project_dir: str) -> dict[str, Any]:
    """Return current convention lock state from state.json.
    Convention keys are domain-specific — physics uses metric_signature,
    fourier_convention, etc; other domains define their own convention schema."""
    pd = _resolve_project_dir(project_dir)
    state = _read_state(pd)
    return {"conventions": state.get("conventions", {}), "project_dir": str(pd)}


@mcp.tool()
def convention_set(key: str, value: str, project_dir: str) -> dict[str, Any]:
    """Atomically set a convention value. Convention keys are defined by
    the domain's convention schema. Physics keys: natural_units, metric_signature,
    fourier_convention, gauge_choice, renormalization_scheme, coupling_convention,
    spin_basis, state_normalization, coordinate_system, index_positioning,
    time_ordering, commutation_convention. Uses file-lock for atomic write."""
    pd = _resolve_project_dir(project_dir)
    state = _read_state(pd)
    state.setdefault("conventions", {})
    state["conventions"][key] = value
    _write_state(pd, state)
    return {"conventions": state["conventions"], "key": key, "value": value}


@mcp.tool()
def convention_check(file_content: str, project_dir: str) -> dict[str, Any]:
    """Check ASSERT_CONVENTION headers in file_content against current lock"""
    pd = _resolve_project_dir(project_dir)
    state = _read_state(pd)
    locked = state.get("conventions", {})
    pattern = re.compile(r<!--\s*ASSERT_CONVENTION:\s*(.*?)\s*-->)
    matches = pattern.findall(file_content)
    results = []
    for match in matches:
        pairs = [p.strip() for p in match.split(",")]
        for pair in pairs:
            if "=" in pair:
                k, v = pair.split("=", 1)
                k = k.strip()
                v = v.strip()
                expected = locked.get(k)
                status = "consistent" if expected == v else ("mismatch" if expected else "unlocked")
                results.append({"key": k, "value": v, "expected": expected, "status": status})
    return {"results": results, "all_consistent": all(r["status"] == "consistent" for r in results)}


@mcp.tool()
def assert_convention_validate(file_path: str, project_dir: str) -> dict[str, Any]:
    """Validate all ASSERT_CONVENTION lines in a file against current lock"""
    pd = _resolve_project_dir(project_dir)
    try:
        content = Path(file_path).read_text()
    except Exception as e:
        return {"error": str(e), "file_path": file_path}
    return convention_check(content, str(pd))


@mcp.tool()
def subfield_defaults(domain: str) -> dict[str, Any]:
    """Return default conventions for a domain.
    Loads defaults from skill references via skill_resolve_path.
    Physics defaults loaded from gpd-conventions/references/convention_defaults/physics.json.
    Other domain defaults loaded from corresponding skill data."""
    skill_dir = _find_skill_dir(f"{domain}-conventions") or _find_skill_dir("gpd-conventions")
    if not skill_dir:
        return {"defaults": {}, "domain": domain, "source": "no skill found"}
    defaults_file = skill_dir / "references" / "convention_defaults" / f"{domain}.json"
    if not defaults_file.exists():
        defaults_file = skill_dir / "references" / "convention_defaults.json"
    if not defaults_file.exists():
        return {"defaults": {}, "domain": domain, "source": f"skill found at {skill_dir} but no defaults file"}
    try:
        return {"defaults": json.loads(defaults_file.read_text()), "domain": domain, "source": str(defaults_file)}
    except Exception as e:
        return {"defaults": {}, "domain": domain, "source": f"error reading {defaults_file}: {e}"}


@mcp.tool()
def skill_resolve_path(skill_name: str, relative_path: str = "") -> dict[str, Any]:
    """Resolve the absolute path to a skill directory or a specific file within it.
    Scans known skill directories for a skill matching the given name
    (from SKILL.md frontmatter name field).
    Returns: {skill_dir, resolved_path, found}"""
    dir = _find_skill_dir(skill_name)
    if not dir:
        return {"skill_dir": None, "resolved_path": None, "found": False, "skill_name": skill_name}
    resolved = dir / relative_path if relative_path else dir
    return {"skill_dir": str(dir), "resolved_path": str(resolved), "found": True, "skill_name": skill_name}


if __name__ == "__main__":
    mcp.run()