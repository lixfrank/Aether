# /// script
# requires-python = ">=3.11"
# dependencies = ["sympy>=1.12"]
# ///
"""Positivity constraint verification using SymPy.

Checks whether matrices (density matrices, spectral functions)
satisfy positivity constraints by computing eigenvalues and
verifying all have the correct sign. Input: matrix expression.
Output: pass/fail/warning with eigenvalue evidence."""

import json
import sys
from sympy import sympify, Matrix, Eigenvalues, Symbol, simplify

def load_input():
    if len(sys.argv) > 1:
        return json.loads(sys.argv[1])
    elif not sys.stdin.isatty():
        return json.load(sys.stdin)
    else:
        print("Usage: positivity_check.py [JSON] or pipe JSON to stdin", file=sys.stderr)
        sys.exit(1)

def run(data: dict) -> dict:
    matrix_expr = data.get("matrix", "")
    positivity_type = data.get("positivity_type", "non-negative")
    substitutions = data.get("substitutions", {})
    conventions = data.get("context", {}).get("conventions", {})

    if not matrix_expr:
        return {
            "status": "insufficient_evidence",
            "computation": "No matrix provided",
            "evidence": "Provide matrix: list-of-lists or SymPy Matrix expression",
            "confidence": 0.0,
        }

    try:
        if isinstance(matrix_expr, list) and all(isinstance(row, list) for row in matrix_expr):
            mat = Matrix(matrix_expr)
        else:
            parsed = sympify(matrix_expr)
            if isinstance(parsed, Matrix):
                mat = parsed
            else:
                return {
                    "status": "insufficient_evidence",
                    "computation": f"Parsed expression is not a Matrix: {type(parsed)}",
                    "evidence": "Input must be a matrix (list of lists or SymPy Matrix)",
                    "confidence": 0.0,
                }
    except Exception as e:
        return {
            "status": "insufficient_evidence",
            "computation": f"Matrix parse failed: {e}",
            "evidence": f"Could not parse matrix: {matrix_expr}",
            "confidence": 0.0,
            "details": {"parse_error": str(e)},
        }

    try:
        if substitutions:
            subs_pairs = [(sympify(k), sympify(v)) for k, v in substitutions.items()]
            mat = mat.subs(subs_pairs)

        eigenvalues = mat.eigenvals()
        computation = f"Matrix shape: {mat.shape}\nEigenvalues: {eigenvalues}"

        sign_map = {"non-negative": lambda x: x >= 0, "positive": lambda x: x > 0, "non-positive": lambda x: x <= 0}
        check_fn = sign_map.get(positivity_type, lambda x: x >= 0)

        results = []
        all_pass = True
        for ev, multiplicity in eigenvalues.items():
            ev_simplified = simplify(ev)
            try:
                ev_numeric = float(ev_simplified)
                passes = check_fn(ev_numeric)
            except (TypeError, ValueError):
                ev_numeric = None
                passes = None
            results.append({"eigenvalue": str(ev_simplified), "multiplicity": multiplicity, "numeric": ev_numeric, "passes": passes})
            if passes is False:
                all_pass = False

        if all_pass and any(r["passes"] is None for r in results):
            return {
                "status": "warning",
                "computation": computation,
                "evidence": f"Eigenvalues contain symbolic terms that cannot be numerically evaluated for sign",
                "confidence": 0.5,
                "details": {"eigenvalues": results},
            }

        if all_pass:
            return {
                "status": "pass",
                "computation": computation,
                "evidence": f"All eigenvalues satisfy {positivity_type} constraint",
                "confidence": 0.95,
                "details": {"eigenvalues": results},
            }
        else:
            failing = [r for r in results if r["passes"] is False]
            return {
                "status": "fail",
                "computation": computation,
                "evidence": f"Positivity ({positivity_type}) violated: eigenvalues {failing} have wrong sign",
                "confidence": 0.95,
                "details": {"eigenvalues": results, "failing": failing},
            }
    except Exception as e:
        return {
            "status": "warning",
            "computation": computation,
            "evidence": f"Eigenvalue computation failed: {e}",
            "confidence": 0.2,
            "details": {"eigenvalue_error": str(e)},
        }

input_data = load_input()
result = run(input_data)
json.dump(result, sys.stdout)