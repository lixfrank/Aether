# /// script
# requires-python = ">=3.11"
# dependencies = ["mcp>=1.0", "pydantic>=2.0", "filelock>=3.0", "pyyaml>=6.0"]
# ///
"""MCP server for research convention lock management.

Provides atomic convention locking with file-lock protection.
Domain-specific defaults loaded from skill references via skill_resolve_path.
Value normalization, non-standard warnings, force override, and cross-field validation.
"""

import json
import re
import threading
from pathlib import Path
from typing import Any

import yaml
from filelock import FileLock
from mcp.server.fastmcp import FastMCP
from mcp.types import ToolAnnotations

mcp = FastMCP("research-conventions")

DEFAULT_STATE_DIR = ".aether/research/persistence"

STANDARD_CONVENTION_KEYS = [
    "natural_units", "metric_signature", "fourier_convention",
    "gauge_choice", "renormalization_scheme", "coupling_convention",
    "spin_basis", "state_normalization", "coordinate_system",
    "index_positioning", "time_ordering", "commutation_convention",
    "levi_civita_sign", "generator_normalization",
    "creation_annihilation_order", "lagrangian_sign",
    "angular_momentum", "spin_statistics", "matsubara",
]

CONVENTION_OPTIONS = {
    "natural_units": ["natural", "SI", "geometric", "atomic", "boltzmann", "thermal", "astronomical", "planck"],
    "metric_signature": ["mostly-minus", "mostly-plus", "euclidean"],
    "fourier_convention": ["physics", "mathematical"],
    "gauge_choice": ["Lorentz", "Coulomb", "Feynman", "unitary", "harmonic", "axial", "temporal", "landau"],
    "renormalization_scheme": ["on-shell", "MS-bar", "MOM", "DR-bar"],
    "coordinate_system": ["Minkowski", "Cartesian", "general", "light-cone", "spherical", "cylindrical"],
    "levi_civita_sign": ["epsilon_0123=+1", "epsilon_0123=-1"],
    "index_positioning": ["upper-first", "lower-first"],
    "time_ordering": ["standard", "reverse", "euclidean"],
    "commutation_convention": ["standard", "opposite"],
    "generator_normalization": ["hermitian", "anti-hermitian"],
    "creation_annihilation_order": ["creation-first", "annihilation-first"],
    "spin_basis": ["computational_basis", "standard_basis"],
    "state_normalization": ["dirac", "non-dirac"],
    "coupling_convention": ["positive", "negative"],
}

CRITICAL_KEYS = {"metric_signature", "fourier_convention", "natural_units"}

CROSS_FIELD_WARNINGS = [
    {
        "condition": lambda c: c.get("metric_signature") == "euclidean" and c.get("fourier_convention") == "physics",
        "warning": "Euclidean metric + physics Fourier convention: sign conventions may be inconsistent for QFT Wick rotation",
    },
    {
        "condition": lambda c: c.get("natural_units") == "SI" and c.get("metric_signature") == "mostly-plus",
        "warning": "SI units + mostly-plus metric: ensure explicit c factors appear in all expressions",
    },
]


def _normalize_key(key: str) -> str:
    return key.strip().lower().replace(" ", "-").replace("_", " ")


def _normalize_value(value: str) -> str:
    return value.strip().lower().replace(" ", "-")


class _StableEnvelope(dict):
    pass


def _stable_response(payload: dict | None = None, error: str | None = None) -> _StableEnvelope:
    resp = _StableEnvelope()
    if payload:
        resp.update(payload)
    if error:
        resp["error"] = error
    resp["schema_version"] = 1
    return resp


def _stable_error(error: str | Exception) -> _StableEnvelope:
    msg = str(error)
    return _stable_response(error=msg)


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


def _read_state_safe(project_dir: Path) -> dict:
    sp = _state_path(project_dir)
    if not sp.exists():
        return {"conventions": {}, "project_contract": {}}
    lock = FileLock(str(sp) + ".lock")
    with lock:
        raw = sp.read_text()
    try:
        state = json.loads(raw)
    except json.JSONDecodeError:
        return {"conventions": {}, "project_contract": {}, "_warning": "state.json was corrupted, using defaults"}
    if not isinstance(state.get("conventions"), dict):
        state["conventions"] = {}
    if "project_contract" not in state:
        state["project_contract"] = {}
    return state


SKILL_DIRS = []
_skill_cache: dict[str, Path | None] = {}
_cache_lock = threading.Lock()


def _init_skill_dirs():
    global SKILL_DIRS
    home = Path.home()
    candidates = [
        home / ".agents" / "skills",
        home / ".opencode" / "skills",
        home / ".aether" / "skills",
    ]
    for d in candidates:
        if d.exists():
            SKILL_DIRS.append(d)


_init_skill_dirs()


def _find_skill_dir(skill_name: str, project_dir: Path | None = None) -> Path | None:
    cache_key = skill_name
    if project_dir:
        cache_key = f"{skill_name}:{project_dir}"
    with _cache_lock:
        if cache_key in _skill_cache:
            return _skill_cache[cache_key]

    dirs = list(SKILL_DIRS)
    if project_dir:
        dirs.extend([
            project_dir / ".aether" / "skills",
            project_dir / ".opencode" / "skills",
        ])

    result = None
    for base in dirs:
        if not base.exists():
            continue
        for skill_md in base.rglob("SKILL.md"):
            try:
                content = skill_md.read_text()
                fm = _parse_frontmatter(content)
                if fm and fm.get("name") == skill_name:
                    result = skill_md.parent
                    break
            except Exception:
                continue
        if result:
            break

    with _cache_lock:
        _skill_cache[cache_key] = result
    return result


def _parse_frontmatter(content: str) -> dict | None:
    if not content.startswith("---"):
        return None
    end = content.find("---", 3)
    if end == -1:
        return None
    try:
        return yaml.safe_load(content[3:end])
    except yaml.YAMLError:
        return None


def _required_assertion_keys(locked: dict) -> list[str]:
    required = set()
    for key in locked:
        if key in CRITICAL_KEYS:
            required.add(key)
    return sorted(required)


def _convention_validate_lock(locked: dict) -> list[str]:
    warnings = []
    for key in CRITICAL_KEYS:
        if key not in locked:
            warnings.append(f"Critical convention '{key}' not set")
    for rule in CROSS_FIELD_WARNINGS:
        if rule["condition"](locked):
            warnings.append(rule["warning"])
    return warnings


READ_ONLY = ToolAnnotations(readOnlyHint=True, destructiveHint=False, idempotentHint=True)
MUTATING_DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=True, idempotentHint=False)
MUTATING_NON_DESTRUCTIVE = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False)


def _format_pydantic_errors(err) -> str:
    from pydantic import ValidationError
    if isinstance(err, ValidationError):
        parts = []
        for e in err.errors():
            loc = ".".join(str(l) for l in e.get("loc", []))
            msg = e.get("msg", "")
            parts.append(f"{loc}: {msg}")
        return "; ".join(parts)
    return str(err)


def _tighten_tool_contracts() -> None:
    from pydantic import create_model
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
            schema_model = create_model(f"{name}_input", **field_defs)
        except Exception:
            continue
        original_fn = tool.fn
        def make_strict(fn, sm):
            async def strict_fn(**kwargs):
                try:
                    sm(**kwargs)
                except Exception as e:
                    return _stable_error(f"Unsupported arguments: {_format_pydantic_errors(e)}")
                return fn(**kwargs)
            return strict_fn
        tool.fn = make_strict(original_fn, schema_model)


@mcp.tool(annotations=READ_ONLY)
def convention_lock_status(project_dir: str) -> dict[str, Any]:
    """Return current convention lock state with statistics: set_fields, unset_fields, completeness_percent, cross-field warnings."""
    pd = _resolve_project_dir(project_dir)
    state = _read_state_safe(pd)
    locked = state.get("conventions", {})
    set_fields = sorted(locked.keys())
    unset_fields = sorted(k for k in STANDARD_CONVENTION_KEYS if k not in locked)
    set_count = len(set_fields)
    total = len(STANDARD_CONVENTION_KEYS)
    completeness = round(set_count / max(total, 1) * 100, 1)
    lock_warnings = _convention_validate_lock(locked)
    return _stable_response({
        "conventions": locked,
        "project_dir": str(pd),
        "set_count": set_count,
        "total_standard_fields": total,
        "set_fields": set_fields,
        "unset_fields": unset_fields,
        "completeness_percent": completeness,
        "lock_warnings": lock_warnings,
    })


@mcp.tool(annotations=MUTATING_DESTRUCTIVE)
def convention_set(key: str, value: str, project_dir: str, force: bool = False) -> dict[str, Any]:
    """Atomically set a convention value with normalization and non-standard value warnings.
    Uses single-lock read-modify-write to prevent TOCTOU race. Supports force override of already-set values."""
    pd = _resolve_project_dir(project_dir)
    sp = _state_path(pd)
    sp.parent.mkdir(parents=True, exist_ok=True)

    norm_key = _normalize_key(key)
    norm_value = _normalize_value(value)
    warnings = []

    known_options = CONVENTION_OPTIONS.get(norm_key)
    if known_options and norm_value not in known_options:
        warnings.append(f"Non-standard value '{norm_value}' for '{norm_key}'. Known options: {known_options}")

    lock = FileLock(str(sp) + ".lock")
    with lock:
        if not sp.exists():
            sp.write_text(json.dumps({"conventions": {}, "project_contract": {}}, indent=2))
        state = json.loads(sp.read_text())
        state.setdefault("conventions", {})
        previous_value = state["conventions"].get(norm_key)
        already_set = previous_value is not None

        if already_set and not force:
            return _stable_response({
                "key": norm_key,
                "value": norm_value,
                "previous_value": previous_value,
                "already_set": True,
                "force_required": True,
                "warnings": warnings,
            }, error=f"Convention '{norm_key}' already set to '{previous_value}'. Use force=True to override.")

        state["conventions"][norm_key] = norm_value
        cross_warnings = _convention_validate_lock(state["conventions"])
        all_warnings = warnings + cross_warnings
        sp.write_text(json.dumps(state, indent=2))

    return _stable_response({
        "key": norm_key,
        "value": norm_value,
        "previous_value": previous_value,
        "forced": force and already_set,
        "already_set": already_set,
        "warnings": all_warnings,
        "conventions": state["conventions"],
    })


@mcp.tool(annotations=READ_ONLY)
def convention_check(file_content: str, project_dir: str) -> dict[str, Any]:
    """Check ASSERT_CONVENTION headers in file_content against current lock"""
    pd = _resolve_project_dir(project_dir)
    state = _read_state_safe(pd)
    locked = state.get("conventions", {})
    pattern = re.compile(r"<!--\s*ASSERT_CONVENTION:\s*(.*?)\s*-->")
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
    return _stable_response({"results": results, "all_consistent": all(r["status"] == "consistent" for r in results) if results else True})


@mcp.tool(annotations=READ_ONLY)
def convention_validate(project_dir: str) -> dict[str, Any]:
    """Validate convention lock completeness and cross-field consistency. Checks for missing critical conventions and cross-field contradictions."""
    pd = _resolve_project_dir(project_dir)
    state = _read_state_safe(pd)
    locked = state.get("conventions", {})
    warnings = _convention_validate_lock(locked)
    required_unset = [k for k in CRITICAL_KEYS if k not in locked]
    return _stable_response({
        "valid": len(warnings) == 0,
        "warnings": warnings,
        "critical_unset": required_unset,
        "set_count": len(locked),
        "total_standard_fields": len(STANDARD_CONVENTION_KEYS),
        "completeness_percent": round(len(locked) / max(len(STANDARD_CONVENTION_KEYS), 1) * 100, 1),
    })


@mcp.tool(annotations=READ_ONLY)
def assert_convention_validate(file_path: str, project_dir: str, require_assertions: bool = True) -> dict[str, Any]:
    """Validate all ASSERT_CONVENTION lines in a file against current lock.
    By default requires at least one ASSERT_CONVENTION line (require_assertions=True).
    Returns valid=False if file has no ASSERT lines when require_assertions is enabled."""
    pd = _resolve_project_dir(project_dir)
    try:
        content = Path(file_path).read_text()
    except Exception as e:
        return _stable_error(f"Cannot read file {file_path}: {e}")

    state = _read_state_safe(pd)
    locked = state.get("conventions", {})
    pattern = re.compile(r"<!--\s*ASSERT_CONVENTION:\s*(.*?)\s*-->")
    matches = pattern.findall(content)
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

    all_consistent = all(r["status"] == "consistent" for r in results) if results else True
    has_assertions = len(matches) > 0

    if require_assertions and not has_assertions:
        required_keys = _required_assertion_keys(locked)
        return _stable_response({
            "valid": False,
            "message": "No ASSERT_CONVENTION lines found. Every derivation artifact must include at least one ASSERT_CONVENTION line.",
            "required_assertion_keys": required_keys,
            "results": [],
            "all_consistent": True,
            "has_assertions": False,
        })

    return _stable_response({
        "valid": all_consistent,
        "results": results,
        "all_consistent": all_consistent,
        "has_assertions": has_assertions,
        "assertion_count": len(matches),
    })


@mcp.tool(annotations=READ_ONLY)
def subfield_defaults(domain: str) -> dict[str, Any]:
    """Return default conventions for a domain.
    Loads defaults from skill references via skill_resolve_path.
    Physics defaults loaded from gpd-conventions/references/convention_defaults/physics.json."""
    skill_dir = _find_skill_dir(f"{domain}-conventions") or _find_skill_dir("gpd-conventions")
    if not skill_dir:
        return _stable_response({"defaults": {}, "domain": domain, "source": "no skill found"})
    defaults_file = skill_dir / "references" / "convention_defaults" / f"{domain}.json"
    if not defaults_file.exists():
        defaults_file = skill_dir / "references" / "convention_defaults.json"
    if not defaults_file.exists():
        return _stable_response({"defaults": {}, "domain": domain, "source": f"skill found at {skill_dir} but no defaults file"})
    try:
        return _stable_response({"defaults": json.loads(defaults_file.read_text()), "domain": domain, "source": str(defaults_file)})
    except Exception as e:
        return _stable_error(f"Error reading {defaults_file}: {e}")


@mcp.tool(annotations=READ_ONLY)
def skill_resolve_path(skill_name: str, relative_path: str = "", project_dir: str = "") -> dict[str, Any]:
    """Resolve the absolute path to a skill directory or a specific file within it.
    Uses project_dir parameter for project-level skill discovery (not CWD).
    Caches results for performance."""
    pd = _resolve_project_dir(project_dir)
    dir = _find_skill_dir(skill_name, project_dir=pd)
    if not dir:
        return _stable_response({"skill_dir": None, "resolved_path": None, "found": False, "skill_name": skill_name})
    resolved = dir / relative_path if relative_path else dir
    return _stable_response({"skill_dir": str(dir), "resolved_path": str(resolved), "found": True, "skill_name": skill_name})


_tighten_tool_contracts()

if __name__ == "__main__":
    mcp.run()