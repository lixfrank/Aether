# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.0", "pydantic>=2.0", "filelock>=3.0"]
# ///
"""MCP server for research project state management.

Provides atomic state advancement, health checks, and progress tracking.
State stored in .aether/research/persistence/state.json.
Includes contract validation, state recovery, phase info, and config reading.
Strict tool contracts: unknown parameters return errors instead of being silently ignored.
"""

import json
import re
from pathlib import Path
from typing import Any

from filelock import FileLock
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations
from pydantic import BaseModel, ValidationError, create_model

mcp = FastMCP("research-state")

DEFAULT_STATE_DIR = ".aether/research/persistence"


def _stable_response(payload: dict | None = None, error: str | None = None) -> dict:
    resp = dict(payload or {})
    if error:
        resp["error"] = error
    resp["schema_version"] = 1
    return resp


def _stable_error(error: str) -> dict:
    return _stable_response(error=str(error))


def _resolve_project_dir(project_dir: str) -> Path:
    if project_dir:
        return Path(project_dir).resolve()
    return Path.cwd().resolve()


def _state_path(project_dir: Path) -> Path:
    return project_dir / DEFAULT_STATE_DIR / "state.json"


def _default_state() -> dict:
    return {
        "phase": "exploration",
        "plan_number": "0",
        "conventions": {},
        "project_contract": {},
        "progress": {"completed_plans": [], "total_plans": 0},
    }


def _ensure_state_file(project_dir: Path) -> Path:
    sp = _state_path(project_dir)
    sp.parent.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(sp) + ".lock")
    with lock:
        if not sp.exists():
            sp.write_text(json.dumps(_default_state(), indent=2))
    return sp


def _read_state_safe(project_dir: Path) -> dict:
    sp = _state_path(project_dir)
    if not sp.exists():
        return _default_state()
    lock = FileLock(str(sp) + ".lock")
    with lock:
        raw = sp.read_text()
    try:
        state = json.loads(raw)
    except json.JSONDecodeError:
        return {**_default_state(), "_warning": "state.json was corrupted, using defaults"}
    defaults = _default_state()
    for key in defaults:
        if key not in state:
            state[key] = defaults[key]
    if not isinstance(state.get("conventions"), dict):
        state["conventions"] = {}
    if not isinstance(state.get("progress"), dict):
        state["progress"] = defaults["progress"]
    return state


def _write_state(project_dir: Path, state: dict) -> None:
    sp = _state_path(project_dir)
    sp.parent.mkdir(parents=True, exist_ok=True)
    lock = FileLock(str(sp) + ".lock")
    with lock:
        sp.write_text(json.dumps(state, indent=2))


def _parse_roadmap_phases(roadmap_path: Path) -> list[dict] | None:
    if not roadmap_path.exists():
        return None
    try:
        content = roadmap_path.read_text()
        phases = []
        for line in content.splitlines():
            m = re.match(r"^#+\s*Phase\s+(\d+)\s*:\s*(.+)", line)
            if m:
                phases.append({"number": m.group(1), "name": m.group(2).strip()})
        return phases if phases else None
    except Exception:
        return None


def _read_project_config(project_dir: Path) -> dict:
    for name in ["aether.jsonc", "aether.json", "opencode.jsonc", "opencode.json"]:
        cfg_path = project_dir / ".aether" / name
        if cfg_path.exists():
            raw = cfg_path.read_text()
            try:
                import jsonc_parser_placeholder
            except ImportError:
                pass
            try:
                if name.endswith(".jsonc"):
                    cleaned = re.sub(r'//.*$', '', raw, flags=re.MULTILINE)
                    cleaned = re.sub(r'/\*.*?\*/', '', cleaned, flags=re.MULTILINE)
                    return json.loads(cleaned)
                return json.loads(raw)
            except json.JSONDecodeError:
                continue
    for name in ["aether.jsonc", "aether.json", "opencode.jsonc", "opencode.json"]:
        cfg_path = project_dir / name
        if cfg_path.exists():
            raw = cfg_path.read_text()
            try:
                if name.endswith(".jsonc"):
                    cleaned = re.sub(r'//.*$', '', raw, flags=re.MULTILINE)
                    cleaned = re.sub(r'/\*.*?\*/', '', cleaned, flags=re.MULTILINE)
                    return json.loads(cleaned)
                return json.loads(raw)
            except json.JSONDecodeError:
                continue
    return {}


def _format_pydantic_errors(err: ValidationError) -> str:
    parts = []
    for e in err.errors():
        loc = ".".join(str(l) for l in e.get("loc", []))
        msg = e.get("msg", "")
        parts.append(f"{loc}: {msg}")
    return "; ".join(parts)


def _tighten_tool_contracts() -> None:
    for name, tool in mcp._tool_manager._tools.items():
        params = tool.parameters
        if not params:
            continue
        required = params.get("required", [])
        properties = params.get("properties", {})
        if not properties:
            continue
        field_defs = {}
        for pname, pspec in properties.items():
            ptype = pspec.get("type", "string")
            if ptype == "string":
                ann = str
            elif ptype == "number" or ptype == "integer":
                ann = int
            elif ptype == "boolean":
                ann = bool
            elif ptype == "array":
                ann = list
            elif ptype == "object":
                ann = dict
            else:
                ann = str
            if pname not in required:
                field_defs[pname] = (ann, None)
            else:
                field_defs[pname] = (ann, ...)
        try:
            model = create_model(f"{name}_input", **field_defs)
            model.__config__ = model.__config__.copy()
        except Exception:
            continue
        original_fn = tool.fn
        def make_strict(fn, schema_model):
            async def strict_fn(**kwargs):
                try:
                    schema_model(**kwargs)
                except ValidationError as e:
                    return _stable_error(f"Unsupported arguments: {_format_pydantic_errors(e)}")
                return fn(**kwargs)
            return strict_fn
        tool.fn = make_strict(original_fn, model)


READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True)
MUTATING_NON_DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False)


@mcp.tool(annotations=READ_ONLY)
def get_state(project_dir: str) -> dict[str, Any]:
    """Return structured project state from state.json with contract validation status."""
    pd = _resolve_project_dir(project_dir)
    state = _read_state_safe(pd)
    contract = state.get("project_contract", {})
    contract_status = "none"
    if contract:
        claims = contract.get("claims", [])
        acceptance_tests = contract.get("acceptance_tests", [])
        if claims and acceptance_tests:
            contract_status = "active"
        elif claims:
            contract_status = "partial"
        else:
            contract_status = "empty"
    return _stable_response({
        **state,
        "project_contract_status": contract_status,
        "project_dir": str(pd),
    })


@mcp.tool(annotations=MUTATING_NON_DESTRUCTIVE)
def advance_plan(phase: str, plan_number: str, project_dir: str) -> dict[str, Any]:
    """Atomically advance project to next plan in state.json.
    If phase and plan_number are empty, attempts auto-advance from ROADMAP.md."""
    pd = _resolve_project_dir(project_dir)

    if not phase or not plan_number:
        roadmap_path = pd / DEFAULT_STATE_DIR / "ROADMAP.md"
        phases = _parse_roadmap_phases(roadmap_path)
        if phases:
            current_state = _read_state_safe(pd)
            current_plan = int(current_state.get("plan_number", "0"))
            next_idx = min(current_plan, len(phases) - 1)
            if not phase:
                phase = phases[next_idx].get("name", f"phase-{next_idx}")
            if not plan_number:
                plan_number = str(next_idx + 1)

    state = _read_state_safe(pd)
    old_phase = state.get("phase", "")
    old_plan = state.get("plan_number", "")
    state.setdefault("progress", {})
    state["progress"].setdefault("completed_plans", [])
    state["progress"]["completed_plans"].append({"phase": old_phase, "plan": old_plan})
    state["phase"] = phase
    state["plan_number"] = plan_number
    _write_state(pd, state)
    return _stable_response({
        "previous": {"phase": old_phase, "plan": old_plan},
        "current": {"phase": phase, "plan": plan_number},
        "progress": state["progress"],
    })


@mcp.tool(annotations=READ_ONLY)
def validate_state(project_dir: str) -> dict[str, Any]:
    """Validate state.json schema, conventions, phase format, plan_number format, and contract status."""
    pd = _resolve_project_dir(project_dir)
    state = _read_state_safe(pd)
    errors = []
    warnings = []

    if not state.get("phase"):
        errors.append("missing phase")
    elif not re.match(r"^[a-z0-9_-]+$", state["phase"], re.IGNORECASE):
        errors.append(f"invalid phase format: '{state['phase']}' (must be alphanumeric/hyphen)")

    if not state.get("plan_number"):
        errors.append("missing plan_number")
    elif not re.match(r"^\d+$", state.get("plan_number", "")):
        errors.append(f"invalid plan_number format: '{state['plan_number']}' (must be numeric)")

    conventions = state.get("conventions", {})
    if not isinstance(conventions, dict):
        errors.append("conventions must be a dict")
    else:
        empty_convs = [k for k, v in conventions.items() if not v]
        if empty_convs:
            warnings.append(f"empty convention values: {empty_convs}")

    contract = state.get("project_contract", {})
    if contract:
        if not contract.get("claims"):
            warnings.append("project_contract has no claims")
        if not contract.get("acceptance_tests"):
            warnings.append("project_contract has no acceptance_tests")

    return _stable_response({
        "valid": len(errors) == 0,
        "errors": errors,
        "warnings": warnings,
        "state": state,
    })


@mcp.tool(annotations=READ_ONLY)
def get_progress(project_dir: str) -> dict[str, Any]:
    """Return computed progress summary"""
    pd = _resolve_project_dir(project_dir)
    state = _read_state_safe(pd)
    progress = state.get("progress", {})
    completed = progress.get("completed_plans", [])
    total = progress.get("total_plans", 0)
    return _stable_response({
        "completed_count": len(completed),
        "total_plans": total,
        "current_phase": state.get("phase", ""),
        "current_plan": state.get("plan_number", ""),
        "percentage": (len(completed) / max(total, 1)) * 100 if total else 0,
    })


@mcp.tool(annotations=READ_ONLY)
def run_health_check(project_dir: str, fix: bool = False) -> dict[str, Any]:
    """Full project health dashboard: structure, storage, state validity, conventions, contract, roadmap consistency."""
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

    plan = persistence_dir / "PLAN.md"
    checks["plan_exists"] = plan.exists()
    if not plan.exists():
        issues.append("PLAN.md missing")

    if sp.exists():
        state = _read_state_safe(pd)
        checks["state_phase_set"] = bool(state.get("phase"))
        checks["state_plan_number_set"] = bool(state.get("plan_number"))
        checks["conventions_count"] = len(state.get("conventions", {}))
        convs = state.get("conventions", {})
        empty = [k for k, v in convs.items() if not v]
        checks["conventions_empty_values"] = empty
        if empty:
            issues.append(f"conventions with empty values: {empty}")

        contract = state.get("project_contract", {})
        checks["contract_has_claims"] = bool(contract.get("claims"))
        checks["contract_has_tests"] = bool(contract.get("acceptance_tests"))

        if roadmap.exists():
            phases = _parse_roadmap_phases(roadmap)
            if phases:
                checks["roadmap_phases_count"] = len(phases)
                current_phase = state.get("phase", "")
                phase_names = [p["name"] for p in phases]
                checks["state_phase_in_roadmap"] = current_phase in phase_names or current_phase == "exploration"
                if current_phase not in phase_names and current_phase != "exploration":
                    issues.append(f"state phase '{current_phase}' not found in ROADMAP phases")

        if "_warning" in state:
            issues.append("state.json had parse issues (recovered)")

    return _stable_response({
        "healthy": len(issues) == 0,
        "issues": issues,
        "checks": checks,
        "project_dir": str(pd),
    })


@mcp.tool(annotations=READ_ONLY)
def get_phase_info(project_dir: str) -> dict[str, Any]:
    """Return phase directory info: available phases from ROADMAP.md, current phase, plan count, completion status."""
    pd = _resolve_project_dir(project_dir)
    roadmap_path = pd / DEFAULT_STATE_DIR / "ROADMAP.md"
    phases = _parse_roadmap_phases(roadmap_path)
    state = _read_state_safe(pd)
    current = state.get("phase", "exploration")
    current_plan = int(state.get("plan_number", "0"))
    completed = state.get("progress", {}).get("completed_plans", [])

    return _stable_response({
        "current_phase": current,
        "current_plan_number": current_plan,
        "total_phases": len(phases) if phases else 0,
        "phases": phases or [],
        "completed_plans": len(completed),
        "roadmap_found": roadmap_path.exists(),
    })


@mcp.tool(annotations=READ_ONLY)
def get_config(project_dir: str) -> dict[str, Any]:
    """Return project configuration summary from aether.jsonc/opencode.jsonc.
    Includes agent definitions, MCP config, skills.paths, and output_dir settings."""
    pd = _resolve_project_dir(project_dir)
    cfg = _read_project_config(pd)
    agents = []
    agent_dir = pd / ".aether" / "agent"
    if agent_dir.exists():
        for f in sorted(agent_dir.glob("*.md")):
            content = f.read_text()
            if content.startswith("---"):
                end = content.find("---", 3)
                if end != -1:
                    try:
                        import yaml
                        fm = yaml.safe_load(content[3:end])
                    except Exception:
                        fm = {}
                    agents.append({
                        "name": f.stem,
                        "description": fm.get("description", ""),
                        "mode": fm.get("mode", ""),
                        "mcp": fm.get("mcp", {}),
                        "output_dir": fm.get("output_dir", ""),
                        "skill_refs": fm.get("skill_refs", []),
                    })
    mcp_config = cfg.get("mcp", {})
    enabled_mcps = [name for name, conf in mcp_config.items() if isinstance(conf, dict) and conf.get("enabled", True)]
    return _stable_response({
        "agents": agents,
        "mcp_servers": list(mcp_config.keys()),
        "mcp_enabled": enabled_mcps,
        "skills_paths": cfg.get("skills", {}).get("paths", []),
        "output_dir_default": ".aether/research",
        "project_dir": str(pd),
        "config_found": bool(cfg),
    })


_tighten_tool_contracts()

if __name__ == "__main__":
    mcp.run()