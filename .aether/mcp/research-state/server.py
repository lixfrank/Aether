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


OUTPUT_DIR = ".aether/research"
PERSISTENCE_WHITELIST = {
    "STATE.md", "ROADMAP.md", "PLAN.md", "DIGESTS.md", "state.json",
    "EXECUTION.md", "VERIFICATION.md",
}


def _scan_output_dir(pd: Path) -> list[Path]:
    output_root = pd / OUTPUT_DIR
    if not output_root.exists():
        return []
    return [p for p in output_root.rglob("*") if p.is_file()]


def _is_nested_output_dir(path: Path, pd: Path) -> bool:
    rel = str(path.relative_to(pd))
    parts = rel.split("/")
    depth = 0
    for p in parts:
        if p == OUTPUT_DIR:
            depth += 1
    return depth > 1


def _is_outside_output_dir(path: Path, pd: Path) -> bool:
    try:
        rel = str(path.relative_to(pd))
    except ValueError:
        return True
    return not rel.startswith(OUTPUT_DIR + "/") and rel != OUTPUT_DIR


def _is_persistence_non_whitelisted(path: Path, pd: Path) -> bool:
    rel = str(path.relative_to(pd))
    if not rel.startswith(OUTPUT_DIR + "/persistence/"):
        return False
    filename = path.name
    return filename not in PERSISTENCE_WHITELIST and not filename.endswith(".lock")


@mcp.tool(annotations=READ_ONLY)
def validate_file_locations(project_dir: str) -> dict[str, Any]:
    """Validate file layout against expected schema. Checks for:
    1. Nested output_dir paths (e.g., .aether/research/.aether/research/...)
    2. Files written outside output_dir (e.g., references/ folder at project root)
    3. Non-whitelisted files in persistence/ directory

    Returns compliance status and violation details. The coordinator should
    call this after receiving a worker digest, before appending to DIGESTS.md.
    The agent should relocate any violating files and re-call to confirm compliance."""
    pd = _resolve_project_dir(project_dir)
    violations = []
    output_root = pd / OUTPUT_DIR
    output_exists = output_root.exists()

    if not output_exists:
        return _stable_response({
            "compliant": True,
            "violations": [],
            "output_dir_exists": False,
            "total_files_in_output_dir": 0,
            "project_dir": str(pd),
        })

    all_output_files = _scan_output_dir(pd)

    for f in all_output_files:
        rel = str(f.relative_to(pd))
        if _is_nested_output_dir(f, pd):
            nested_base_idx = rel.find(OUTPUT_DIR, len(OUTPUT_DIR) + 1)
            correct_rel = rel[:nested_base_idx] + rel[nested_base_idx + len(OUTPUT_DIR) + 1:]
            violations.append({
                "path": rel,
                "rule": "nested_output_dir",
                "suggested_correction": f"remove nested {OUTPUT_DIR} prefix; correct path: {correct_rel}",
            })

    project_files_outside = []
    for f in pd.rglob("*"):
        if not f.is_file():
            continue
        if str(f).startswith(str(pd / ".aether")):
            continue
        if str(f).startswith(str(pd / ".git")):
            continue
        if f.parent == pd:
            candidates = ["package.json", "tsconfig.json", "bun.lock", "bunfig.toml",
                          "Cargo.toml", "pyproject.toml", "Makefile", ".gitignore",
                          "README.md", "LICENSE", "AGENTS.md"]
            if f.name in candidates:
                continue
        rel = str(f.relative_to(pd))
        if _is_outside_output_dir(f, pd):
            project_files_outside.append(rel)

    recent_outside = []
    for rel in project_files_outside:
        f = pd / rel
        try:
            mtime = f.stat().st_mtime
            state = _read_state_safe(pd)
            state_mtime = (pd / DEFAULT_STATE_DIR / "state.json").stat().st_mtime
            if mtime > state_mtime - 60:
                recent_outside.append(rel)
        except OSError:
            recent_outside.append(rel)

    for rel in recent_outside:
        violations.append({
            "path": rel,
            "rule": "outside_output_dir",
            "suggested_correction": f"move into {OUTPUT_DIR}/notepads/<slug>/ or appropriate subdirectory",
        })

    for f in all_output_files:
        rel = str(f.relative_to(pd))
        if _is_persistence_non_whitelisted(f, pd):
            violations.append({
                "path": rel,
                "rule": "persistence_non_whitelisted",
                "suggested_correction": f"move to {OUTPUT_DIR}/notepads/<slug>/ if it is research output, or remove if temporary",
            })

    return _stable_response({
        "compliant": len(violations) == 0,
        "violations": violations,
        "output_dir_exists": output_exists,
        "total_files_in_output_dir": len(all_output_files),
        "persistence_whitelist": sorted(PERSISTENCE_WHITELIST),
        "project_dir": str(pd),
    })


_tighten_tool_contracts()

if __name__ == "__main__":
    mcp.run()