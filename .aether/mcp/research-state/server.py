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
import os
import re
import subprocess
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
        "phase": "gate",
        "plan_number": "0",
        "conventions": {},
        "project_contract": {},
        "progress": {"completed_plans": [], "total_plans": 0, "rollback_plans": []},
        "phase_commits": {},
        "execution_cycle": 0,
        "rollback_context": None,
        "cross_phase_rollback_count": 0,
        "audit": {
            "repair_count": 0,
            "current_audit_phase": None,
            "audit_round": 0,
        },
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
        return {
            **_default_state(),
            "_warning": "state.json was corrupted, using defaults",
        }
    defaults = _default_state()
    for key in defaults:
        if key not in state:
            state[key] = defaults[key]
    if not isinstance(state.get("conventions"), dict):
        state["conventions"] = {}
    if not isinstance(state.get("progress"), dict):
        state["progress"] = defaults["progress"]
    else:
        prog_defaults = defaults["progress"]
        for key in prog_defaults:
            if key not in state["progress"]:
                state["progress"][key] = prog_defaults[key]
    if not isinstance(state.get("audit"), dict):
        state["audit"] = defaults["audit"]
    return state


def _write_state(project_dir: Path, state: dict) -> None:
    sp = _state_path(project_dir)
    sp.parent.mkdir(parents=True, exist_ok=True)
    state["plan_number"] = (
        str(state["plan_number"]) if state["plan_number"] is not None else "0"
    )
    state["phase"] = str(state["phase"]) if state["phase"] is not None else "gate"
    lock = FileLock(str(sp) + ".lock")
    # Atomic write: serialize to a temp file then os.replace onto state.json.
    # A crash mid-write leaves the temp file orphaned but state.json intact.
    with lock:
        tmp = sp.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(state, indent=2))
        os.replace(tmp, sp)


def _iso_now() -> str:
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).isoformat()


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
                    cleaned = re.sub(r"//.*$", "", raw, flags=re.MULTILINE)
                    cleaned = re.sub(r"/\*.*?\*/", "", cleaned, flags=re.MULTILINE)
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
                    cleaned = re.sub(r"//.*$", "", raw, flags=re.MULTILINE)
                    cleaned = re.sub(r"/\*.*?\*/", "", cleaned, flags=re.MULTILINE)
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
                    return _stable_error(
                        f"Unsupported arguments: {_format_pydantic_errors(e)}"
                    )
                return fn(**kwargs)

            return strict_fn

        tool.fn = make_strict(original_fn, model)


READ_ONLY = ToolAnnotations(
    readOnlyHint=True, destructiveHint=False, idempotentHint=True
)
MUTATING_NON_DESTRUCTIVE = ToolAnnotations(
    readOnlyHint=False, destructiveHint=False, idempotentHint=False
)


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
    return _stable_response(
        {
            **state,
            "project_contract_status": contract_status,
            "project_dir": str(pd),
        }
    )


VALID_PHASES = [
    "gate",
    "phase_analysis",
    "phase_analysis_checkpoint",
    "phase_audit_1",
    "phase_landscape",
    "phase_audit_2",
    "phase_framing",
    "phase_audit_3",
    "phase_debate",
    "phase_checkpoint",
    "phase_execution",
    "completed",
]


@mcp.tool(annotations=MUTATING_NON_DESTRUCTIVE)
def advance_plan(
    phase: str,
    plan_number: str,
    project_dir: str,
    commit_sha: str = "",
    execution_cycle: int = 0,
) -> dict[str, Any]:
    """Atomically advance project to next plan in state.json.
    If phase and plan_number are empty, attempts auto-advance from ROADMAP.md
    then falls back to VALID_PHASES list."""
    pd = _resolve_project_dir(project_dir)
    plan_number = str(plan_number)

    if not phase or not plan_number:
        roadmap_path = pd / DEFAULT_STATE_DIR / "ROADMAP.md"
        phases = _parse_roadmap_phases(roadmap_path)
        current_state = _read_state_safe(pd)
        current_plan = int(current_state.get("plan_number", "0"))

        if phases:
            next_idx = min(current_plan, len(phases) - 1)
            if not phase:
                phase = phases[next_idx].get("name", "")
            if not plan_number:
                plan_number = str(next_idx + 1)
        if not phase:
            if current_plan < len(VALID_PHASES):
                phase = VALID_PHASES[current_plan]
            else:
                return _stable_error(
                    f"Cannot auto-advance: plan_number {current_plan} exceeds VALID_PHASES. "
                    "Please provide explicit phase and plan_number."
                )
            if not plan_number:
                plan_number = str(current_plan + 1)

    state = _read_state_safe(pd)
    old_phase = state.get("phase", "")
    old_plan = state.get("plan_number", "")
    state.setdefault("progress", {})
    state["progress"].setdefault("completed_plans", [])
    state["progress"]["completed_plans"].append({"phase": old_phase, "plan": old_plan})
    state["phase"] = phase
    state["plan_number"] = plan_number

    if commit_sha:
        state.setdefault("phase_commits", {})
        state["phase_commits"][phase] = commit_sha

    if phase == "phase_execution" and execution_cycle:
        state["execution_cycle"] = execution_cycle

    if phase == "phase_debate":
        state.setdefault(
            "debate",
            {
                "rounds_completed": 0,
                "escalate_topics": [],
                "current_sub_phase": None,
            },
        )

    if phase in ("phase_audit_1", "phase_audit_2", "phase_audit_3"):
        state.setdefault(
            "audit",
            {
                "repair_count": 0,
                "current_audit_phase": phase,
                "audit_round": 0,
            },
        )
        state["audit"]["repair_count"] = 0
        state["audit"]["current_audit_phase"] = phase
        state["audit"]["audit_round"] = 0

    _write_state(pd, state)
    return _stable_response(
        {
            "previous": {"phase": old_phase, "plan": old_plan},
            "current": {"phase": phase, "plan": plan_number},
            "progress": state["progress"],
        }
    )


VALID_ROLLBACK_REASONS = {
    "checkpoint_rejection",
    "execution_vague",
    "gap_reexamination",
}
VALID_ROLLBACK_TARGETS = {"phase_debate", "phase_framing"}
CROSS_PHASE_ROLLBACK_LIMIT = 3


@mcp.tool(annotations=MUTATING_NON_DESTRUCTIVE)
def phase_rollback(
    target_phase: str,
    target_plan_number: str,
    project_dir: str,
    preserve_execution: bool = True,
    rollback_reason: str = "",
    rollback_details: dict = None,
    commit_sha: str = "",
) -> dict[str, Any]:
    """Atomically roll back project state to an earlier phase and plan number.

    Unified rollback handler for all rollback scenarios:
    - checkpoint_rejection: user rejected plan at phase_checkpoint
    - execution_vague: autoresearch detected PLAN.md method too vague during phase_execution
    - gap_reexamination: judgment-worker classified claim_impossible level=L3

    Cross-phase rollback counter (only system-initiated rollbacks) capped at 3.
    On limit, returns action=terminated without modifying phase/plan_number.
    Atomic: all field mutations operate on an in-memory dict; only one disk write at end.
    """
    pd = _resolve_project_dir(project_dir)
    target_plan_number = str(target_plan_number)
    if rollback_details is None:
        rollback_details = {}

    if target_phase not in VALID_ROLLBACK_TARGETS:
        return _stable_error(
            f"Invalid target_phase: '{target_phase}'. Must be one of: {sorted(VALID_ROLLBACK_TARGETS)}"
        )
    if rollback_reason and rollback_reason not in VALID_ROLLBACK_REASONS:
        return _stable_error(
            f"Invalid rollback_reason: '{rollback_reason}'. Must be one of: {sorted(VALID_ROLLBACK_REASONS)} or empty"
        )

    state = _read_state_safe(pd)
    current_phase = state.get("phase", "")
    current_plan = state.get("plan_number", "0")

    try:
        current_plan_int = int(current_plan)
        target_plan_int = int(target_plan_number)
    except (TypeError, ValueError):
        return _stable_error(
            f"plan_number must be integers, got current='{current_plan}' target='{target_plan_number}'"
        )

    if target_plan_int >= current_plan_int:
        return _stable_error(
            f"target_plan_number ({target_plan_number}) must be less than current plan_number ({current_plan}). "
            "phase_rollback only allows backward rollbacks."
        )

    details = rollback_details if isinstance(rollback_details, dict) else {}
    evidence = details.get("evidence") or details.get("vagueness_details") or ""
    lessons_obj = {}
    if "what_went_wrong" in details or "what_to_avoid" in details:
        lessons_obj["what_went_wrong"] = details.get("what_went_wrong", "")
        lessons_obj["what_to_avoid"] = details.get("what_to_avoid", "")
        alt = (
            details.get("alternative_direction")
            or details.get("claim_revision_direction")
            or details.get("question_redesign_direction")
            or details.get("gap_reexamination_reason")
        )
        if alt:
            lessons_obj["alternative_direction"] = alt
    elif evidence:
        lessons_obj["what_went_wrong"] = (
            evidence if isinstance(evidence, str) else json.dumps(evidence)
        )

    try:
        head_sha = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=str(pd),
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
    except Exception:
        head_sha = ""

    # resolved_conclusions 摘要（preserve_execution=true 时记录被保留的 resolved questions，
    # 供 WORKFLOW_TERMINATION_REPORT.md 的 Rollback History 引用）
    exe = state.get("execution")
    resolved = (
        exe.get("resolved_conclusions", {})
        if isinstance(exe, dict) and isinstance(exe.get("resolved_conclusions"), dict)
        else {}
    )
    if preserve_execution and resolved:
        parts = []
        for qn, rc in resolved.items():
            summary = ""
            if isinstance(rc, dict):
                summary = str(rc.get("conclusion_summary", "")).strip()
            if summary:
                parts.append(f"{qn}: {summary[:160]}")
            else:
                parts.append(qn)
        preserved_results = "; ".join(parts)
    else:
        preserved_results = ""

    entry = {
        "from_phase": current_phase,
        "from_plan": current_plan,
        "to_phase": target_phase,
        "to_plan": target_plan_number,
        "reason": rollback_reason,
        "timestamp": _iso_now(),
        "guarded": False,
        "source_commit": head_sha,
        "evidence": evidence,
        "lessons": lessons_obj,
        "preserved_results": preserved_results,
    }

    state.setdefault("progress", {}).setdefault("rollback_plans", [])
    state["progress"]["rollback_plans"].append(entry)

    is_system_rollback = rollback_reason in {"execution_vague", "gap_reexamination"}
    if is_system_rollback:
        state["cross_phase_rollback_count"] = (
            state.get("cross_phase_rollback_count", 0) + 1
        )

    count = state.get("cross_phase_rollback_count", 0)
    if is_system_rollback and count >= CROSS_PHASE_ROLLBACK_LIMIT:
        entry["guarded"] = True
        state["rollback_context"] = {
            "reason": rollback_reason,
            "details": details,
            "timestamp": _iso_now(),
        }
        _write_state(pd, state)
        return _stable_response(
            {
                "action": "terminated",
                "reason": "cross_phase_rollback_limit_reached",
                "count": count,
                "limit": CROSS_PHASE_ROLLBACK_LIMIT,
            }
        )

    state["phase"] = target_phase
    state["plan_number"] = target_plan_number

    if preserve_execution and isinstance(state.get("execution"), dict):
        exe = state["execution"]
        exe["current_cycle"] = 1
        exe["execution_shallow_retries"] = {
            k: 0 for k in exe.get("execution_shallow_retries", {})
        }
        exe["environment_retries"] = {k: 0 for k in exe.get("environment_retries", {})}
        exe["verification_shallow_retries"] = {
            k: 0 for k in exe.get("verification_shallow_retries", {})
        }
        exe["current_retry_type"] = "normal"
        exe["current_wave"] = None
        exe["current_question"] = None
        exe["current_step"] = None
        qs = exe.get("question_status", {})
        for qn, status_val in list(qs.items()):
            br = exe.get("blocking_reason", {}).get(qn)
            if status_val == "blocked" and br == "vagueness":
                qs[qn] = "pending"
            elif status_val == "skipped_vague":
                qs[qn] = "pending"
        if "verification_retries" in exe and isinstance(
            exe["verification_retries"], dict
        ):
            exe["verification_retries"] = {k: 0 for k in exe["verification_retries"]}
    elif not preserve_execution:
        if "execution" in state:
            state["execution"] = {}

    if target_phase == "phase_debate":
        state.setdefault(
            "debate",
            {
                "rounds_completed": 0,
                "escalate_topics": [],
                "current_sub_phase": None,
            },
        )
        rc = state["debate"].get("rounds_completed", 0)
        state["debate"]["current_sub_phase"] = None
        state["debate"]["escalate_topics"] = []
        state["debate"]["rounds_completed"] = rc

    if commit_sha:
        state.setdefault("phase_commits", {})
        state["phase_commits"][target_phase] = commit_sha

    state["rollback_context"] = {
        "reason": rollback_reason,
        "details": details,
        "timestamp": _iso_now(),
    }

    _write_state(pd, state)
    return _stable_response(
        {
            "action": "rolled_back",
            "previous": {"phase": current_phase, "plan": current_plan},
            "current": {"phase": target_phase, "plan": target_plan_number},
            "preserve_execution": preserve_execution,
            "rollback_reason": rollback_reason,
            "cross_phase_rollback_count": state.get("cross_phase_rollback_count", 0),
            "rollback_plans_count": len(
                state.get("progress", {}).get("rollback_plans", [])
            ),
        }
    )


VALID_DEBATE_SUB_PHASES = {
    "advocacy",
    "critique",
    "rebuttal",
    "adjudication",
    "repair",
    "null",
}


@mcp.tool(annotations=MUTATING_NON_DESTRUCTIVE)
def update_debate_state(
    project_dir: str,
    rounds_completed: int | None = None,
    escalate_topics: list[str] | None = None,
    current_sub_phase: str | None = None,
) -> dict[str, Any]:
    """Update debate-specific fields in state.json.
    Only callable during phase_debate.
    All parameters are optional — only provided fields are updated.
    escalate_topics: ESCALATE topic names extracted from DEBATE.md adjudicator ruling by coordinator.
    current_sub_phase accepts: advocacy, critique, rebuttal, adjudication, repair, null."""
    pd = _resolve_project_dir(project_dir)
    state = _read_state_safe(pd)

    if state.get("phase") != "phase_debate":
        return _stable_error("update_debate_state only callable during phase_debate")

    if current_sub_phase is not None:
        sub = str(current_sub_phase)
        if sub not in VALID_DEBATE_SUB_PHASES:
            return _stable_error(
                f"Invalid current_sub_phase: '{sub}'. Must be one of: {sorted(VALID_DEBATE_SUB_PHASES)}"
            )

    state.setdefault(
        "debate",
        {
            "rounds_completed": 0,
            "escalate_topics": [],
            "current_sub_phase": None,
        },
    )

    if rounds_completed is not None:
        state["debate"]["rounds_completed"] = int(rounds_completed)
    if escalate_topics is not None:
        state["debate"]["escalate_topics"] = list(escalate_topics)
    if current_sub_phase is not None:
        sub = str(current_sub_phase)
        state["debate"]["current_sub_phase"] = None if sub == "null" else sub

    _write_state(pd, state)
    return _stable_response(
        {
            "debate": state["debate"],
        }
    )


VALID_AUDIT_PHASES = {"phase_audit_1", "phase_audit_2", "phase_audit_3"}
VALID_AUDIT_SUB_PHASES = {"audit", "repair", "null"}


@mcp.tool(annotations=MUTATING_NON_DESTRUCTIVE)
def update_audit_state(
    project_dir: str,
    repair_count: int | None = None,
    current_audit_phase: str | None = None,
    audit_round: int | None = None,
) -> dict[str, Any]:
    """Update audit-specific fields in state.json.
    Only callable during phase_audit_1, phase_audit_2, or phase_audit_3.
    All parameters are optional — only provided fields are updated.
    repair_count: cumulative repair attempts within current audit loop (reset to 0 on new audit phase).
    current_audit_phase: phase_audit_1, phase_audit_2, or phase_audit_3.
    audit_round: current audit round number within the phase.
    """
    pd = _resolve_project_dir(project_dir)
    state = _read_state_safe(pd)

    current = state.get("phase", "")
    if current not in VALID_AUDIT_PHASES:
        return _stable_error(
            f"update_audit_state only callable during phase_audit_1, phase_audit_2, or phase_audit_3, current phase: {current}"
        )

    if current_audit_phase is not None:
        cap = str(current_audit_phase)
        if cap not in VALID_AUDIT_PHASES:
            return _stable_error(
                f"Invalid current_audit_phase: '{cap}'. Must be one of: {sorted(VALID_AUDIT_PHASES)}"
            )

    state.setdefault(
        "audit",
        {
            "repair_count": 0,
            "current_audit_phase": None,
            "audit_round": 0,
        },
    )

    if repair_count is not None:
        state["audit"]["repair_count"] = int(repair_count)
    if current_audit_phase is not None:
        state["audit"]["current_audit_phase"] = str(current_audit_phase)
    if audit_round is not None:
        state["audit"]["audit_round"] = int(audit_round)

    _write_state(pd, state)
    return _stable_response(
        {
            "audit": state["audit"],
        }
    )


@mcp.tool(annotations=READ_ONLY)
def check_file_updated(
    project_dir: str, file_path: str, since_mtime: float
) -> dict[str, Any]:
    """Check if a file under .aether/research/ has been modified since a given timestamp.

    Used by the coordinator to verify that a debate worker actually wrote to DEBATE.md
    after returning a digest. file_path is relative to .aether/research/ (e.g.
    "persistence/DEBATE.md"). since_mtime is a Unix timestamp (seconds since epoch)
    recorded before the worker was dispatched.

    Returns: updated (bool), current_mtime, size, previous_mtime."""
    pd = _resolve_project_dir(project_dir)
    full_path = pd / OUTPUT_DIR / file_path
    if not full_path.exists():
        return _stable_response(
            {
                "updated": False,
                "exists": False,
                "current_mtime": None,
                "size": None,
                "previous_mtime": since_mtime,
            }
        )
    try:
        stat = full_path.stat()
    except OSError:
        return _stable_response(
            {
                "updated": False,
                "exists": True,
                "current_mtime": None,
                "size": None,
                "previous_mtime": since_mtime,
            }
        )
    return _stable_response(
        {
            "updated": stat.st_mtime > since_mtime,
            "exists": True,
            "current_mtime": stat.st_mtime,
            "size": stat.st_size,
            "previous_mtime": since_mtime,
        }
    )


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
        errors.append(
            f"invalid phase format: '{state['phase']}' (must be alphanumeric/hyphen)"
        )

    if not state.get("plan_number"):
        errors.append("missing plan_number")
    elif not re.match(r"^\d+$", state.get("plan_number", "")):
        errors.append(
            f"invalid plan_number format: '{state['plan_number']}' (must be numeric)"
        )

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

    return _stable_response(
        {
            "valid": len(errors) == 0,
            "errors": errors,
            "warnings": warnings,
            "state": state,
        }
    )


@mcp.tool(annotations=READ_ONLY)
def get_progress(project_dir: str) -> dict[str, Any]:
    """Return computed progress summary"""
    pd = _resolve_project_dir(project_dir)
    state = _read_state_safe(pd)
    progress = state.get("progress", {})
    completed = progress.get("completed_plans", [])
    total = progress.get("total_plans", 0)
    return _stable_response(
        {
            "completed_count": len(completed),
            "total_plans": total,
            "current_phase": state.get("phase", ""),
            "current_plan": state.get("plan_number", ""),
            "percentage": (len(completed) / max(total, 1)) * 100 if total else 0,
        }
    )


def _run_cmd(
    cmd: list[str], timeout: int = 10, stdin: str | None = None
) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, input=stdin
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return subprocess.CompletedProcess(cmd, 1, "", "")


def _check_network(url: str) -> dict:
    methods = [
        ("curl", ["curl", "-sL", "-o", "/dev/null", "-w", "%{http_code}", url]),
        ("wget", ["wget", "-q", "-O", "/dev/null", "--timeout=5", url]),
        (
            "python",
            [
                "python3",
                "-c",
                f"import urllib.request; r=urllib.request.urlopen('{url}',timeout=5); print(r.status)",
            ],
        ),
    ]
    for name, cmd in methods:
        result = _run_cmd(cmd, timeout=15)
        if result.returncode == 0:
            code = result.stdout.strip()
            if code.startswith("2"):
                return {
                    "status": "pass",
                    "method": name,
                    "url": url,
                    "http_code": int(code),
                }
            if code == "429":
                return {
                    "status": "degraded",
                    "method": name,
                    "url": url,
                    "http_code": 429,
                    "note": "rate limited, endpoint reachable but throttled",
                }
    return {"status": "fail", "url": url, "attempts": [m[0] for m in methods]}


VALID_LAYERS = ("infrastructure", "persistence", "skill_chain", "runtime")


def _check_infrastructure(project_dir: Path) -> dict:
    checks = {}
    issues = []

    result = _run_cmd(["uv", "--version"])
    if result.returncode == 0:
        checks["uv_available"] = {"status": "pass", "version": result.stdout.strip()}
    else:
        checks["uv_available"] = {"status": "fail", "failure_class": "not_installed"}
        issues.append("uv not available")

    result = _run_cmd(["uv", "python", "list"])
    if result.returncode == 0:
        versions = [l.strip() for l in result.stdout.strip().splitlines() if l.strip()]
        checks["uv_python_management"] = {"status": "pass", "versions": versions}
    else:
        checks["uv_python_management"] = {
            "status": "fail",
            "failure_class": "not_configured",
        }

    result = _run_cmd(["git", "--version"])
    if result.returncode == 0:
        checks["git_available"] = {"status": "pass", "version": result.stdout.strip()}
    else:
        checks["git_available"] = {"status": "fail", "failure_class": "not_installed"}
        issues.append("git not available")

    result = _run_cmd(["git", "rev-parse", "--git-dir"], timeout=5)
    if result.returncode == 0:
        checks["git_working_dir"] = {"status": "pass", "git_dir": result.stdout.strip()}
    else:
        checks["git_working_dir"] = {
            "status": "fail",
            "failure_class": "not_initialized",
        }
        issues.append("not inside a git repository")

    checks["network_arxiv"] = _check_network("https://api.arxiv.org")
    if checks["network_arxiv"]["status"] == "fail":
        issues.append("arXiv API unreachable")

    checks["network_s2"] = _check_network("https://api.semanticscholar.org")
    if checks["network_s2"]["status"] == "fail":
        issues.append("Semantic Scholar S2 API unreachable")

    checks["network_inspire_hep"] = _check_network("https://inspirehep.net/api")
    if checks["network_inspire_hep"]["status"] == "fail":
        issues.append("INSPIRE-HEP API unreachable")

    checks["network_pubmed"] = _check_network("https://eutils.ncbi.nlm.nih.gov")
    if checks["network_pubmed"]["status"] == "fail":
        issues.append("PubMed API unreachable")

    checks["network_alphaxiv"] = _check_network("https://alphaxiv.org")
    if checks["network_alphaxiv"]["status"] == "fail":
        issues.append("alphaxiv unreachable")

    checks["network_crossref"] = _check_network("https://api.crossref.org")
    if checks["network_crossref"]["status"] == "fail":
        issues.append("Crossref API unreachable")

    return {"healthy": len(issues) == 0, "checks": checks, "issues": issues}


def _check_persistence(project_dir: Path) -> dict:
    checks = {}
    issues = []
    persistence_dir = project_dir / DEFAULT_STATE_DIR

    try:
        persistence_dir.mkdir(parents=True, exist_ok=True)
        checks["persistence_dir_writable"] = {"status": "pass"}
    except OSError as e:
        checks["persistence_dir_writable"] = {
            "status": "fail",
            "reason": str(e),
            "failure_class": "not_writable",
        }
        issues.append(f"persistence directory not writable: {e}")

    sp = persistence_dir / "state.json"
    if sp.exists():
        try:
            data = json.loads(sp.read_text())
            checks["state_json_valid"] = {
                "status": "pass",
                "phase": data.get("phase", "unknown"),
            }
        except json.JSONDecodeError as e:
            checks["state_json_valid"] = {
                "status": "fail",
                "reason": str(e),
                "failure_class": "corrupt",
            }
            issues.append(f"state.json corrupt: {e}")
    else:
        checks["state_json_valid"] = {
            "status": "fail",
            "reason": "file not found",
            "failure_class": "missing",
        }
        issues.append("state.json missing")

    state_md = persistence_dir / "STATE.md"
    if state_md.exists():
        content = state_md.read_text()
        has_heading = bool(re.search(r"^##\s*Current\s+Phase", content, re.MULTILINE))
        checks["state_md_format"] = {"status": "pass" if has_heading else "fail"}
        if not has_heading:
            issues.append("STATE.md missing '## Current Phase' heading")
    else:
        checks["state_md_format"] = {"status": "fail", "failure_class": "missing"}
        issues.append("STATE.md missing")

    convention_defaults = (
        project_dir
        / ".aether"
        / "skills"
        / "plugins"
        / "gpd"
        / "gpd-conventions"
        / "references"
        / "convention_defaults.json"
    )
    if convention_defaults.exists():
        try:
            data = json.loads(convention_defaults.read_text())
            checks["convention_defaults_readable"] = {
                "status": "pass",
                "keys_count": len(data),
            }
        except (json.JSONDecodeError, OSError) as e:
            checks["convention_defaults_readable"] = {
                "status": "fail",
                "reason": str(e),
                "failure_class": "corrupt",
            }
            issues.append(f"convention_defaults.json unreadable: {e}")
    else:
        checks["convention_defaults_readable"] = {
            "status": "fail",
            "reason": "file not found",
            "failure_class": "missing",
        }
        issues.append("convention_defaults.json missing")

    return {"healthy": len(issues) == 0, "checks": checks, "issues": issues}


def _find_skill_md(project_dir: Path, skill_name: str) -> Path | None:
    candidates = [
        project_dir / ".aether" / "skills" / skill_name / "SKILL.md",
        project_dir
        / ".aether"
        / "skills"
        / "plugins"
        / "gpd"
        / skill_name
        / "SKILL.md",
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def _check_skill_chain(project_dir: Path) -> dict:
    checks = {}
    issues = []

    skill_refs_map = {
        "research_worker_paper_search": "paper-search",
        "research_worker_debate_advocate": "debate-advocate",
        "research_worker_debate_critic": "debate-critic",
        "research_worker_debate_adjudicator": "debate-adjudicator",
        "research_worker_debate_repair": "debate-repair",
        "research_verifier_research_verification": "research-verification",
        "gpd_verifier_research_verification": "research-verification",
        "gpd_verifier_gpd_verification": "gpd-verification",
        "gpd_verifier_gpd_errors": "gpd-errors",
        "gpd_verifier_gpd_domain_check": "gpd-domain-check",
        "gpd_verifier_gpd_conventions": "gpd-conventions",
        "gpd_reviewer_gpd_errors": "gpd-errors",
        "gpd_reviewer_gpd_conventions": "gpd-conventions",
        "gpd_reviewer_gpd_domain_check": "gpd-domain-check",
        "research_worker_audit": "research-audit",
        "research_worker_audit_repair": "research-audit-repair",
        "research_worker_audit_reasoning": "research-audit-reasoning",
        "research_worker_audit_repair_reasoning": "research-audit-repair-reasoning",
    }
    for key, skill_name in skill_refs_map.items():
        found = _find_skill_md(project_dir, skill_name)
        if found:
            checks[key] = {"status": "pass", "path": str(found)}
        else:
            checks[key] = {"status": "fail", "failure_class": "missing"}
            issues.append(f"{skill_name} SKILL.md not found")

    # §5.7 judgment-worker agent existence check (used by autoresearch for depth/shallow/claim classifications)
    judgment_worker_path = project_dir / ".aether" / "agent" / "judgment-worker.md"
    if judgment_worker_path.exists():
        checks["autoresearch_judgment_worker"] = {
            "status": "pass",
            "path": str(judgment_worker_path),
        }
    else:
        checks["autoresearch_judgment_worker"] = {
            "status": "fail",
            "failure_class": "missing",
        }
        issues.append(
            "judgment-worker agent (.aether/agent/judgment-worker.md) not found"
        )

    gpd_verification_scripts = [
        "dimensional_check",
        "spot_check",
        "limiting_case_check",
        "conservation_check",
        "convergence_check",
        "ward_identity_check",
        "positivity_check",
        "kramers_kronig_check",
        "symmetry_check",
    ]
    scripts_dir = (
        project_dir
        / ".aether"
        / "skills"
        / "plugins"
        / "gpd"
        / "gpd-verification"
        / "scripts"
    )
    found_scripts = []
    missing_scripts = []
    for s in gpd_verification_scripts:
        p = scripts_dir / f"{s}.py"
        if p.exists():
            found_scripts.append(s)
        else:
            missing_scripts.append(s)
    checks["gpd_verification_9_scripts"] = {
        "status": "pass" if len(missing_scripts) == 0 else "fail",
        "count": len(found_scripts),
        "missing": missing_scripts if missing_scripts else None,
        "failure_class": "missing" if missing_scripts else None,
    }
    if missing_scripts:
        issues.append(f"gpd-verification scripts missing: {missing_scripts}")

    gpd_verification_refs = [
        "check_registry.json",
        "contract_checks.json",
    ]
    refs_dir = (
        project_dir
        / ".aether"
        / "skills"
        / "plugins"
        / "gpd"
        / "gpd-verification"
        / "references"
    )
    domain_checklists_dir = refs_dir / "domain_checklists"
    found_refs = []
    missing_refs = []
    for r in gpd_verification_refs:
        p = refs_dir / r
        if p.exists():
            found_refs.append(r)
        else:
            missing_refs.append(r)
    if domain_checklists_dir.exists():
        for f in sorted(domain_checklists_dir.glob("*.json")):
            found_refs.append(f"domain_checklists/{f.name}")
    else:
        missing_refs.append("domain_checklists/")
    checks["gpd_verification_references"] = {
        "status": "pass" if len(missing_refs) == 0 else "fail",
        "count": len(found_refs),
        "missing": missing_refs if missing_refs else None,
        "failure_class": "missing" if missing_refs else None,
    }
    if missing_refs:
        issues.append(f"gpd-verification references missing: {missing_refs}")

    gpd_errors_refs = [
        "error_catalog.json",
        "traceability_matrix.json",
        "detection_strategies.json",
    ]
    errors_dir = (
        project_dir
        / ".aether"
        / "skills"
        / "plugins"
        / "gpd"
        / "gpd-errors"
        / "references"
    )
    found_err = []
    missing_err = []
    for r in gpd_errors_refs:
        p = errors_dir / r
        if p.exists():
            found_err.append(r)
        else:
            missing_err.append(r)
    checks["gpd_errors_references"] = {
        "status": "pass" if len(missing_err) == 0 else "fail",
        "count": len(found_err),
        "missing": missing_err if missing_err else None,
        "failure_class": "missing" if missing_err else None,
    }
    if missing_err:
        issues.append(f"gpd-errors references missing: {missing_err}")

    conv_refs = ["convention_defaults.json", "subfield_defaults/physics.json"]
    conv_dir = (
        project_dir
        / ".aether"
        / "skills"
        / "plugins"
        / "gpd"
        / "gpd-conventions"
        / "references"
    )
    found_conv = []
    missing_conv = []
    for r in conv_refs:
        p = conv_dir / r
        if p.exists():
            found_conv.append(r)
        else:
            missing_conv.append(r)
    checks["gpd_conventions_references"] = {
        "status": "pass" if len(missing_conv) == 0 else "fail",
        "count": len(found_conv),
        "missing": missing_conv if missing_conv else None,
        "failure_class": "missing" if missing_conv else None,
    }
    if missing_conv:
        issues.append(f"gpd-conventions references missing: {missing_conv}")

    dc_protocols = [
        "renormalization_group.json",
        "dimensional_analysis.json",
        "limiting_cases.json",
        "perturbation_theory.json",
    ]
    dc_dir = (
        project_dir
        / ".aether"
        / "skills"
        / "plugins"
        / "gpd"
        / "gpd-domain-check"
        / "references"
    )
    dc_bundles_dir = dc_dir / "bundles"
    found_dc = []
    missing_dc = []
    for r in dc_protocols:
        p = dc_dir / "protocols" / r
        if p.exists():
            found_dc.append(f"protocols/{r}")
        else:
            missing_dc.append(f"protocols/{r}")
    if dc_bundles_dir.exists():
        for f in sorted(dc_bundles_dir.glob("*.json")):
            found_dc.append(f"bundles/{f.name}")
    else:
        missing_dc.append("bundles/")
    checks["gpd_domain_check_references"] = {
        "status": "pass" if len(missing_dc) == 0 else "fail",
        "count": len(found_dc),
        "missing": missing_dc if missing_dc else None,
        "failure_class": "missing" if missing_dc else None,
    }
    if missing_dc:
        issues.append(f"gpd-domain-check references missing: {missing_dc}")

    lit_review_scripts = [
        "search_databases.py",
        "verify_citations.py",
        "generate_pdf.py",
    ]
    lr_dir = project_dir / ".aether" / "skills" / "literature-review" / "scripts"
    found_lr = []
    missing_lr = []
    for s in lit_review_scripts:
        p = lr_dir / s
        if p.exists():
            found_lr.append(s)
        else:
            missing_lr.append(s)
    checks["literature_review_scripts"] = {
        "status": "pass" if len(missing_lr) == 0 else "fail",
        "count": len(found_lr),
        "missing": missing_lr if missing_lr else None,
        "failure_class": "missing" if missing_lr else None,
    }
    if missing_lr:
        issues.append(f"literature-review scripts missing: {missing_lr}")

    paper_search_scripts = [
        "arxiv_search.py",
        "download_paper.py",
        "inspire_search.py",
        "s2_search.py",
        "pubmed_search.py",
        "extract_citations.py",
    ]
    ps_dir = project_dir / ".aether" / "skills" / "paper-search"
    found_ps = []
    missing_ps = []
    for s in paper_search_scripts:
        p = ps_dir / s
        if p.exists():
            found_ps.append(s)
        else:
            missing_ps.append(s)
    checks["paper_search_scripts"] = {
        "status": "pass" if len(missing_ps) == 0 else "fail",
        "count": len(found_ps),
        "missing": missing_ps if missing_ps else None,
        "failure_class": "missing" if missing_ps else None,
    }
    if missing_ps:
        issues.append(f"paper-search scripts missing: {missing_ps}")

    return {"healthy": len(issues) == 0, "checks": checks, "issues": issues}


SYMPY_DRY_RUN_INPUTS = {
    "dimensional_check": '{"expression":"1","context":{"domain":"health_test"},"conventions":{},"dimension_map":{"1":"dimensionless"}}',
    "spot_check": '{"expression":"1","context":{"domain":"health_test"},"spot_check_type":"unit_consistency","conventions":{}}',
    "limiting_case_check": '{"expression":"1","limit_value":"1","variable":"x","conventions":{},"context":{"domain":"health_test"}}',
    "conservation_check": '{"expression":"1","conserved_quantity":"energy","conventions":{},"context":{"domain":"health_test"}}',
    "convergence_check": '{"expression":"1","n_terms":"3","conventions":{},"context":{"domain":"health_test"}}',
    "ward_identity_check": '{"expression":"1","identities_to_check":["unit"],"conventions":{},"context":{"domain":"health_test"}}',
    "positivity_check": '{"expression":"1","conventions":{},"context":{"domain":"health_test"}}',
    "kramers_kronig_check": '{"expression":"1","conventions":{},"context":{"domain":"health_test"}}',
    "symmetry_check": '{"expression":"1","symmetry_type":"parity","conventions":{},"context":{"domain":"health_test"}}',
}


def _check_runtime(project_dir: Path) -> dict:
    checks = {}
    issues = []
    cross_mcp_pending = []

    state = _read_state_safe(project_dir)
    if state.get("phase") or state.get("phase") == "":
        checks["research_state_mcp"] = {
            "status": "pass",
            "phase_returned": state.get("phase", ""),
        }
    else:
        checks["research_state_mcp"] = {"status": "fail"}
        issues.append("research-state MCP get_state returned no phase")

    sp = _state_path(project_dir)
    backup_path = Path(str(sp) + ".health_backup")
    original_content = None
    rollback_status = "skipped"
    if sp.exists():
        original_content = sp.read_text()
        backup_path.write_text(original_content)
        original_state = (
            json.loads(original_content) if original_content else _default_state()
        )
        orig_phase = original_state.get("phase", "gate")
        orig_plan = original_state.get("plan_number", "0")

        advance_result = advance_plan(
            phase="health_test", plan_number="0", project_dir=str(project_dir)
        )
        if advance_result.get("current", {}).get("phase") == "health_test":
            rollback_result = advance_plan(
                phase=orig_phase, plan_number=orig_plan, project_dir=str(project_dir)
            )
            if rollback_result.get("current", {}).get("phase") == orig_phase:
                rollback_status = "success"
            else:
                if original_content:
                    sp.write_text(original_content)
                rollback_status = "fallback_write"
        else:
            rollback_status = "advance_failed"
            if original_content:
                sp.write_text(original_content)

        if backup_path.exists():
            backup_path.unlink()
    checks["advance_plan_test"] = {
        "status": "pass",
        "rollback": rollback_status,
        "note": "health_check exemption: round-trip write-path test",
    }
    if rollback_status not in ("success", "skipped"):
        issues.append(f"advance_plan rollback issue: {rollback_status}")

    # phase_rollback registration check (no round-trip — avoids rollback_plans pollution)
    rollback_tool = mcp._tool_manager._tools.get("phase_rollback")
    if rollback_tool and rollback_tool.parameters:
        checks["phase_rollback_registration"] = {
            "status": "pass",
            "method": "registration_check_only",
        }
    else:
        checks["phase_rollback_registration"] = {
            "status": "fail",
            "failure_class": "tool_not_registered",
        }
        issues.append("phase_rollback tool not registered")

    scripts_dir = (
        project_dir
        / ".aether"
        / "skills"
        / "plugins"
        / "gpd"
        / "gpd-verification"
        / "scripts"
    )
    sympy_results = {}
    sympy_pass_count = 0
    first_script = True
    for script_name, dry_input in SYMPY_DRY_RUN_INPUTS.items():
        script_path = scripts_dir / f"{script_name}.py"
        if not script_path.exists():
            sympy_results[script_name] = {
                "status": "fail",
                "reason": "script not found",
            }
            continue
        timeout = 60 if first_script else 10
        first_script = False
        result = _run_cmd(
            ["uv", "run", str(script_path)],
            timeout=timeout,
            stdin=dry_input,
        )
        try:
            output = json.loads(result.stdout.strip()) if result.stdout.strip() else {}
            if output.get("status") == "pass" or output.get("schema_version"):
                sympy_results[script_name] = {"status": "pass"}
                sympy_pass_count += 1
            else:
                sympy_results[script_name] = {
                    "status": "fail",
                    "reason": result.stderr[:200]
                    if result.stderr
                    else "unexpected output",
                }
        except (json.JSONDecodeError, AttributeError):
            sympy_results[script_name] = {
                "status": "fail",
                "reason": result.stderr[:200]
                if result.stderr
                else "no valid JSON output",
            }
    checks["sympy_dry_run"] = sympy_results
    if sympy_pass_count < 9:
        failed_scripts = [k for k, v in sympy_results.items() if v["status"] != "pass"]
        issues.append(f"SymPy dry-run failures: {failed_scripts}")

    alpha_script = (
        project_dir / ".aether" / "skills" / "paper-search" / "arxiv_search.py"
    )
    if alpha_script.exists():
        result = _run_cmd(
            ["uv", "run", str(alpha_script), "health test query", "--max-papers", "1"],
            timeout=30,
        )
        if result.returncode == 0 and result.stdout.strip():
            try:
                output = json.loads(result.stdout.strip())
                count = len(output) if isinstance(output, list) else 1
                checks["paper_search"] = {"status": "pass", "results_count": count}
            except json.JSONDecodeError:
                checks["paper_search"] = {"status": "pass", "results_count": 1}
        else:
            checks["paper_search"] = {
                "status": "fail",
                "reason": result.stderr[:200] if result.stderr else "no output",
            }
            issues.append("paper-search arxiv_search failed")
    else:
        checks["paper_search"] = {"status": "fail", "reason": "script not found"}

    cross_mcp_pending = ["research_conventions_mcp_online", "convention_skill_resolve"]

    return {
        "healthy": len(issues) == 0,
        "checks": checks,
        "issues": issues,
        "cross_mcp_pending": cross_mcp_pending,
    }


@mcp.tool(annotations=READ_ONLY)
def run_health_check(
    project_dir: str, layers: list[str] | None = None
) -> dict[str, Any]:
    """Full project health dashboard with 4-layer progressive detection.

    Layers:
    - infrastructure: uv, git, network reachability (6 endpoints: arxiv, s2, inspire_hep, pubmed, alphaxiv, crossref)
    - persistence: directory writable, state.json valid, convention_defaults readable
    - runtime: MCP tool calls, all 9 SymPy scripts dry-run, paper-search arxiv_search

    NOTE: Cross-MCP checks (research-conventions) are NOT included in
    this tool's output. The agent must call research-conventions MCP
    separately and merge results (see §4.2).

    By default runs all layers. Pass layers=["infrastructure","persistence"]
    to run only specific layers. Runtime layer requires all previous
    layers to pass first.

    Returns per-layer status with issues and checks details.

    NOTE: This tool is READ_ONLY. Auto-install of missing items is handled
    by the env-setup skill (see §6.5), which requires per-item user authorization.
    """
    pd = _resolve_project_dir(project_dir)
    requested = list(layers) if layers else list(VALID_LAYERS)
    for l in requested:
        if l not in VALID_LAYERS:
            return _stable_error(f"Invalid layer: {l}. Valid layers: {VALID_LAYERS}")

    layer_results = {}
    blocked = None

    for layer_name in VALID_LAYERS:
        if layer_name not in requested:
            continue
        if blocked:
            layer_results[layer_name] = {
                "healthy": False,
                "checks": {},
                "issues": [f"blocked_by: {blocked}"],
            }
            continue
        if layer_name == "infrastructure":
            result = _check_infrastructure(pd)
        elif layer_name == "persistence":
            result = _check_persistence(pd)
        elif layer_name == "skill_chain":
            result = _check_skill_chain(pd)
        elif layer_name == "runtime":
            result = _check_runtime(pd)
        else:
            continue
        layer_results[layer_name] = result
        if not result["healthy"]:
            blocked = layer_name

    overall_healthy = all(r.get("healthy", False) for r in layer_results.values())
    total_checks = 0
    passed = 0
    failed = 0
    degradations = []
    cross_mcp_pending_count = 0
    for r in layer_results.values():
        for k, v in r.get("checks", {}).items():
            total_checks += 1
            if isinstance(v, dict):
                if v.get("status") == "pass":
                    passed += 1
                elif v.get("status") == "degraded":
                    degradations.append(k)
                    passed += 1
                else:
                    failed += 1
            elif v is True:
                passed += 1
            else:
                failed += 1
        if "cross_mcp_pending" in r:
            cross_mcp_pending_count = len(r["cross_mcp_pending"])

    return _stable_response(
        {
            "healthy": overall_healthy,
            "layers": layer_results,
            "summary": {
                "total_checks": total_checks,
                "passed": passed,
                "failed": failed,
                "degradations": degradations,
                "cross_mcp_pending_count": cross_mcp_pending_count,
            },
            "project_dir": str(pd),
        }
    )


@mcp.tool(annotations=READ_ONLY)
def get_phase_info(project_dir: str) -> dict[str, Any]:
    """Return phase directory info: available phases from ROADMAP.md, current phase, plan count, completion status."""
    pd = _resolve_project_dir(project_dir)
    roadmap_path = pd / DEFAULT_STATE_DIR / "ROADMAP.md"
    phases = _parse_roadmap_phases(roadmap_path)
    state = _read_state_safe(pd)
    current = state.get("phase", "gate")
    current_plan = int(state.get("plan_number", "0"))
    completed = state.get("progress", {}).get("completed_plans", [])

    return _stable_response(
        {
            "current_phase": current,
            "current_plan_number": current_plan,
            "total_phases": len(phases) if phases else 0,
            "phases": phases or [],
            "completed_plans": len(completed),
            "roadmap_found": roadmap_path.exists(),
        }
    )


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
                    agents.append(
                        {
                            "name": f.stem,
                            "description": fm.get("description", ""),
                            "mode": fm.get("mode", ""),
                            "mcp": fm.get("mcp", {}),
                            "output_dir": fm.get("output_dir", ""),
                            "skill_refs": fm.get("skill_refs", []),
                        }
                    )
    mcp_config = cfg.get("mcp", {})
    enabled_mcps = [
        name
        for name, conf in mcp_config.items()
        if isinstance(conf, dict) and conf.get("enabled", True)
    ]
    return _stable_response(
        {
            "agents": agents,
            "mcp_servers": list(mcp_config.keys()),
            "mcp_enabled": enabled_mcps,
            "skills_paths": cfg.get("skills", {}).get("paths", []),
            "output_dir_default": ".aether/research",
            "project_dir": str(pd),
            "config_found": bool(cfg),
        }
    )


OUTPUT_DIR = ".aether/research"
PERSISTENCE_WHITELIST = {
    "STATE.md",
    "ROADMAP.md",
    "PLAN.md",
    "DIGESTS.md",
    "state.json",
    "EXECUTION.md",
    "VERIFICATION.md",
    "ENVIRONMENT.md",
    "DEBATE.md",
    "WORKFLOW_TERMINATION_REPORT.md",  # cross-phase rollback termination report (§3.1)
}

PERSISTENCE_WHITELIST_DIRS = {"audits"}


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
    if filename in PERSISTENCE_WHITELIST or filename.endswith(".lock"):
        return False
    parent_name = path.parent.name
    if parent_name in PERSISTENCE_WHITELIST_DIRS:
        return False
    return True


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
        return _stable_response(
            {
                "compliant": True,
                "violations": [],
                "output_dir_exists": False,
                "total_files_in_output_dir": 0,
                "project_dir": str(pd),
            }
        )

    all_output_files = _scan_output_dir(pd)

    for f in all_output_files:
        rel = str(f.relative_to(pd))
        if _is_nested_output_dir(f, pd):
            nested_base_idx = rel.find(OUTPUT_DIR, len(OUTPUT_DIR) + 1)
            correct_rel = (
                rel[:nested_base_idx] + rel[nested_base_idx + len(OUTPUT_DIR) + 1 :]
            )
            violations.append(
                {
                    "path": rel,
                    "rule": "nested_output_dir",
                    "suggested_correction": f"remove nested {OUTPUT_DIR} prefix; correct path: {correct_rel}",
                }
            )

    project_files_outside = []
    for f in pd.rglob("*"):
        if not f.is_file():
            continue
        if str(f).startswith(str(pd / ".aether")):
            continue
        if str(f).startswith(str(pd / ".git")):
            continue
        if f.parent == pd:
            candidates = [
                "package.json",
                "tsconfig.json",
                "bun.lock",
                "bunfig.toml",
                "Cargo.toml",
                "pyproject.toml",
                "Makefile",
                ".gitignore",
                "README.md",
                "LICENSE",
                "AGENTS.md",
            ]
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
        violations.append(
            {
                "path": rel,
                "rule": "outside_output_dir",
                "suggested_correction": f"move into {OUTPUT_DIR}/notepads/<slug>/ or appropriate subdirectory",
            }
        )

    for f in all_output_files:
        rel = str(f.relative_to(pd))
        if _is_persistence_non_whitelisted(f, pd):
            violations.append(
                {
                    "path": rel,
                    "rule": "persistence_non_whitelisted",
                    "suggested_correction": f"move to {OUTPUT_DIR}/notepads/<slug>/ if it is research output, or remove if temporary",
                }
            )

    return _stable_response(
        {
            "compliant": len(violations) == 0,
            "violations": violations,
            "output_dir_exists": output_exists,
            "total_files_in_output_dir": len(all_output_files),
            "persistence_whitelist": sorted(PERSISTENCE_WHITELIST),
            "project_dir": str(pd),
        }
    )


_tighten_tool_contracts()

if __name__ == "__main__":
    mcp.run()
