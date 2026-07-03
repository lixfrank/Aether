# /// script
# requires-python = ">=3.11"
# ///
#!/usr/bin/env python3
"""Standalone health check — 4-layer progressive detection.

Self-contained health check — no MCP dependency.
Run with: uv run run_health_check.py [project_dir] [layers...]

Layers:
  infrastructure — uv, git, network reachability
  persistence    — research_state.md existence + format, ENVIRONMENT.md
  skill_chain    — skill/agent/checker existence
  runtime        — SymPy dry-run, paper-search test
"""

import json
import re
import subprocess
import sys
from pathlib import Path

VALID_LAYERS = ("infrastructure", "persistence", "skill_chain", "runtime")
PERSISTENCE_DIR = ".aether/research/persistence"


def _run_cmd(cmd, timeout=10, stdin=None):
    try:
        return subprocess.run(
            cmd, capture_output=True, text=True, timeout=timeout, input=stdin
        )
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return subprocess.CompletedProcess(cmd, 1, "", "")


def _check_network(url):
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
                }
    return {"status": "fail", "url": url, "attempts": [m[0] for m in methods]}


def _check_infrastructure(pd):
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

    for key, url, label in [
        ("network_arxiv", "https://api.arxiv.org", "arXiv API"),
        ("network_s2", "https://api.semanticscholar.org", "Semantic Scholar"),
        ("network_inspire_hep", "https://inspirehep.net/api", "INSPIRE-HEP"),
        ("network_pubmed", "https://eutils.ncbi.nlm.nih.gov", "PubMed"),
        ("network_alphaxiv", "https://alphaxiv.org", "alphaxiv"),
        ("network_crossref", "https://api.crossref.org", "Crossref"),
    ]:
        checks[key] = _check_network(url)
        if checks[key]["status"] == "fail":
            issues.append(f"{label} unreachable")

    return {"healthy": len(issues) == 0, "checks": checks, "issues": issues}


def _check_persistence(pd):
    checks = {}
    issues = []
    pdir = pd / PERSISTENCE_DIR

    try:
        pdir.mkdir(parents=True, exist_ok=True)
        checks["persistence_dir_writable"] = {"status": "pass"}
    except OSError as e:
        checks["persistence_dir_writable"] = {
            "status": "fail",
            "reason": str(e),
            "failure_class": "not_writable",
        }
        issues.append(f"persistence directory not writable: {e}")

    rsm = pdir / "research_state.md"
    if rsm.exists():
        content = rsm.read_text()
        has_goal = bool(re.search(r"^##\s*Research\s+Goal", content, re.MULTILINE))
        has_phase = bool(re.search(r"^##\s*Phase\s+History", content, re.MULTILINE))
        if has_goal and has_phase:
            checks["research_state_md_format"] = {"status": "pass"}
        else:
            checks["research_state_md_format"] = {
                "status": "fail",
                "failure_class": "corrupt",
            }
            issues.append(
                "research_state.md missing required sections (Research Goal / Phase History)"
            )
    else:
        checks["research_state_md_format"] = {
            "status": "fail",
            "failure_class": "missing",
        }
        issues.append(
            "research_state.md missing (expected for new project; created during analysis)"
        )

    env_md = pdir / "ENVIRONMENT.md"
    checks["environment_md"] = {
        "status": "pass" if env_md.exists() else "fail",
        "failure_class": None if env_md.exists() else "missing",
    }

    conv_defaults = (
        pd
        / ".aether"
        / "skills"
        / "plugins"
        / "gpd"
        / "gpd-conventions"
        / "references"
        / "convention_defaults.json"
    )
    if conv_defaults.exists():
        try:
            json.loads(conv_defaults.read_text())
            checks["convention_defaults_readable"] = {"status": "pass"}
        except (json.JSONDecodeError, OSError) as e:
            checks["convention_defaults_readable"] = {
                "status": "fail",
                "reason": str(e),
                "failure_class": "corrupt",
            }
    else:
        checks["convention_defaults_readable"] = {
            "status": "fail",
            "failure_class": "missing",
        }

    return {"healthy": len(issues) == 0, "checks": checks, "issues": issues}


def _find_skill_md(pd, skill_name):
    candidates = [
        pd / ".aether" / "skills" / skill_name / "SKILL.md",
        pd / ".aether" / "skills" / "plugins" / "gpd" / skill_name / "SKILL.md",
    ]
    for p in candidates:
        if p.exists():
            return p
    return None


def _check_skill_chain(pd):
    checks = {}
    issues = []

    expected_skills = {
        "paper_search": "paper-search",
        "literature_landscape_scan": "literature-landscape-scan",
        "research_question_framing": "research-question-framing",
        "autoresearch": "autoresearch",
        "analysis": "analysis",
        "debate": "debate",
        "research_audit": "research-audit",
        "health_check": "health-check",
        "literature_review": "literature-review",
        "gpd_verification": "gpd-verification",
        "gpd_errors": "gpd-errors",
        "gpd_conventions": "gpd-conventions",
        "gpd_domain_check": "gpd-domain-check",
    }
    for key, skill_name in expected_skills.items():
        found = _find_skill_md(pd, skill_name)
        if found:
            checks[key] = {"status": "pass", "path": str(found)}
        else:
            checks[key] = {"status": "fail", "failure_class": "missing"}
            issues.append(f"{skill_name} SKILL.md not found")

    expected_agents = [
        "research.md",
        "research-worker.md",
        "research-verifier.md",
        "local-executor.md",
        "research-explorer.md",
        "research-audit.md",
        "debate-critic.md",
        "debate-rebuttal.md",
    ]
    for agent_file in expected_agents:
        p = pd / ".aether" / "agent" / agent_file
        key = agent_file.replace(".md", "").replace("-", "_")
        if p.exists():
            checks[f"agent_{key}"] = {"status": "pass", "path": str(p)}
        else:
            checks[f"agent_{key}"] = {"status": "fail", "failure_class": "missing"}
            issues.append(f"agent/{agent_file} not found")

    audit_scripts = [
        "check_sources.py",
        "check_verification.py",
        "check_artifacts.py",
        "check_conventions.py",
    ]
    scripts_dir = pd / ".aether" / "skills" / "research-audit" / "scripts"
    found_scripts = []
    missing_scripts = []
    for s in audit_scripts:
        p = scripts_dir / s
        if p.exists():
            found_scripts.append(s)
        else:
            missing_scripts.append(s)
    checks["research_audit_checker_scripts"] = {
        "status": "pass" if not missing_scripts else "fail",
        "count": len(found_scripts),
        "missing": missing_scripts if missing_scripts else None,
        "failure_class": "missing" if missing_scripts else None,
    }
    if missing_scripts:
        issues.append(f"research-audit checker scripts missing: {missing_scripts}")

    gpd_scripts = [
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
    gpd_scripts_dir = (
        pd / ".aether" / "skills" / "plugins" / "gpd" / "gpd-verification" / "scripts"
    )
    found_g = []
    missing_g = []
    for s in gpd_scripts:
        p = gpd_scripts_dir / f"{s}.py"
        if p.exists():
            found_g.append(s)
        else:
            missing_g.append(s)
    checks["gpd_verification_scripts"] = {
        "status": "pass" if not missing_g else "fail",
        "count": len(found_g),
        "missing": missing_g if missing_g else None,
    }
    if missing_g:
        issues.append(f"gpd-verification scripts missing: {missing_g}")

    ps_scripts = [
        "arxiv_search.py",
        "download_paper.py",
        "inspire_search.py",
        "s2_search.py",
        "pubmed_search.py",
        "extract_citations.py",
    ]
    ps_dir = pd / ".aether" / "skills" / "paper-search"
    found_ps = [s for s in ps_scripts if (ps_dir / s).exists()]
    missing_ps = [s for s in ps_scripts if not (ps_dir / s).exists()]
    checks["paper_search_scripts"] = {
        "status": "pass" if not missing_ps else "fail",
        "count": len(found_ps),
        "missing": missing_ps if missing_ps else None,
    }
    if missing_ps:
        issues.append(f"paper-search scripts missing: {missing_ps}")

    hc_script = (
        pd / ".aether" / "skills" / "health-check" / "scripts" / "run_health_check.py"
    )
    checks["health_check_script"] = {"status": "pass" if hc_script.exists() else "fail"}
    if not hc_script.exists():
        issues.append("run_health_check.py not found")

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


def _check_runtime(pd):
    checks = {}
    issues = []

    scripts_dir = (
        pd / ".aether" / "skills" / "plugins" / "gpd" / "gpd-verification" / "scripts"
    )
    sympy_results = {}
    sympy_pass = 0
    first = True
    for script_name, dry_input in SYMPY_DRY_RUN_INPUTS.items():
        script_path = scripts_dir / f"{script_name}.py"
        if not script_path.exists():
            sympy_results[script_name] = {
                "status": "fail",
                "reason": "script not found",
            }
            continue
        timeout = 60 if first else 10
        first = False
        result = _run_cmd(
            ["uv", "run", str(script_path)], timeout=timeout, stdin=dry_input
        )
        try:
            output = json.loads(result.stdout.strip()) if result.stdout.strip() else {}
            if output.get("status") == "pass" or output.get("schema_version"):
                sympy_results[script_name] = {"status": "pass"}
                sympy_pass += 1
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
    if sympy_pass < 9:
        failed = [k for k, v in sympy_results.items() if v["status"] != "pass"]
        issues.append(f"SymPy dry-run failures: {failed}")

    alpha_script = pd / ".aether" / "skills" / "paper-search" / "arxiv_search.py"
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

    return {"healthy": len(issues) == 0, "checks": checks, "issues": issues}


def run_health_check(project_dir, layers=None):
    pd = Path(project_dir).resolve() if project_dir else Path.cwd().resolve()
    requested = list(layers) if layers else list(VALID_LAYERS)

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

    overall = all(r.get("healthy", False) for r in layer_results.values())
    total = passed = failed = 0
    degradations = []
    for r in layer_results.values():
        for k, v in r.get("checks", {}).items():
            total += 1
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

    return {
        "healthy": overall,
        "schema_version": 1,
        "layers": layer_results,
        "summary": {
            "total_checks": total,
            "passed": passed,
            "failed": failed,
            "degradations": degradations,
        },
        "project_dir": str(pd),
    }


def main():
    args = sys.argv[1:]
    project_dir = args[0] if args and not args[0].startswith("-") else None
    layers = [a for a in args[1:] if a in VALID_LAYERS] if len(args) > 1 else None
    result = run_health_check(project_dir, layers)
    print(json.dumps(result, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
