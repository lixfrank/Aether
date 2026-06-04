# /// script
# requires-python = ">=3.11"
# dependencies = ["sympy>=1.12"]
# ///
"""Limiting case check using sympy.limit().

Computes actual limit values rather than keyword scanning.
Input: expression + limit specifications.
Output: pass/fail/warning with computed limit values."""

import json
import sys
from sympy import Symbol, sympify, limit, S

def load_input():
    if len(sys.argv) > 1:
        return json.loads(sys.argv[1])
    elif not sys.stdin.isatty():
        return json.load(sys.stdin)
    else:
        print("Usage: limiting_case_check.py [JSON] or pipe JSON to stdin", file=sys.stderr)
        sys.exit(1)

def run(data: dict) -> dict:
    expression = data.get("expression", "")
    limits_spec = data.get("limits", {})
    expected = data.get("expected_limits", {})
    conventions = data.get("context", {}).get("conventions", {})

    try:
        expr = sympify(expression)
    except Exception as e:
        return {
            "status": "insufficient_evidence",
            "computation": f"SymPy parse failed: {e}",
            "evidence": f"Could not parse: {expression}",
            "confidence": 0.0,
            "details": {"parse_error": str(e)},
        }

    results = []
    all_pass = True
    computation_lines = [f"Expression: {expr}"]

    for var_name, limit_value in limits_spec.items():
        try:
            sym = Symbol(var_name)
            lim_val = sympify(limit_value) if isinstance(limit_value, str) else S(limit_value)
            computed = limit(expr, sym, lim_val)
            computation_lines.append(f"lim({var_name} → {lim_val}) = {computed}")

            if expected and var_name in expected:
                exp_val = sympify(expected[var_name]) if isinstance(expected[var_name], str) else S(expected[var_name])
                match = (computed - exp_val).simplify() == 0
                results.append({
                    "variable": var_name,
                    "limit_to": str(lim_val),
                    "computed": str(computed),
                    "expected": str(exp_val),
                    "match": bool(match),
                })
                if not match:
                    all_pass = False
            else:
                results.append({
                    "variable": var_name,
                    "limit_to": str(lim_val),
                    "computed": str(computed),
                    "expected": None,
                    "match": None,
                })
        except Exception as e:
            results.append({
                "variable": var_name,
                "limit_to": str(limit_value),
                "computed": None,
                "expected": None,
                "match": None,
                "error": str(e),
            })
            all_pass = False

    if expected and any(var in expected for var in limits_spec):
        status = "pass" if all_pass else "fail"
        confidence = 0.95
    else:
        status = "pass" if all(results) else "warning"
        confidence = 0.7

    return {
        "status": status,
        "computation": "\n".join(computation_lines),
        "evidence": json.dumps(results, indent=2),
        "confidence": confidence,
        "details": {"results": results},
    }

input_data = load_input()
result = run(input_data)
json.dump(result, sys.stdout)