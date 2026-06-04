# /// script
# requires-python = ">=3.11"
# dependencies = ["sympy>=1.12"]
# ///
"""Dimensional analysis check using SymPy.

Tracks dimensions through raw SymPy expressions rather than
pre-annotated bracket notation. Input: expression + optional expected dimensions.
Output: pass/fail/warning with computed dimension trace."""

import json
import sys
from sympy import Symbol, sympify, Mul, Add, Pow, Rational

def load_input():
    if len(sys.argv) > 1:
        return json.loads(sys.argv[1])
    elif not sys.stdin.isatty():
        return json.load(sys.stdin)
    else:
        print("Usage: dimensional_check.py [JSON] or pipe JSON to stdin", file=sys.stderr)
        sys.exit(1)

def run(data: dict) -> dict:
    expression = data.get("expression", "")
    expected = data.get("expected_dimensions", {})
    conventions = data.get("context", {}).get("conventions", {})

    try:
        expr = sympify(expression)
        computation = f"SymPy parsed: {expr}"
    except Exception as e:
        return {
            "status": "insufficient_evidence",
            "computation": f"SymPy parse failed: {e}",
            "evidence": f"Could not parse expression: {expression}",
            "confidence": 0.0,
            "details": {"parse_error": str(e)},
        }

    dim_map = data.get("dimension_map", {})
    if not dim_map:
        return {
            "status": "warning",
            "computation": computation,
            "evidence": "No dimension map provided — cannot track dimensions automatically",
            "confidence": 0.3,
            "details": {"parsed_expr": str(expr), "note": "Provide dimension_map: {symbol: dimension_string} to enable tracking"},
        }

    try:
        dim_symbols = {}
        for sym_name, dim_str in dim_map.items():
            dim_symbols[Symbol(sym_name)] = Symbol(dim_str)

        dim_expr = expr.subs(dim_symbols)
        computation += f"\nDimension substitution: {dim_expr}"

        if expected:
            expected_expr = sympify(expected.get("dimensions", ""))
            match = sympify(str(dim_expr) - str(expected_expr)) == 0
            if match:
                return {
                    "status": "pass",
                    "computation": computation,
                    "evidence": f"Computed dimensions {dim_expr} match expected {expected_expr}",
                    "confidence": 0.95,
                    "details": {"computed": str(dim_expr), "expected": str(expected_expr)},
                }
            else:
                return {
                    "status": "fail",
                    "computation": computation,
                    "evidence": f"Computed dimensions {dim_expr} DO NOT match expected {expected_expr}",
                    "confidence": 0.95,
                    "details": {"computed": str(dim_expr), "expected": str(expected_expr), "diff": str(dim_expr - expected_expr)},
                }

        return {
            "status": "pass",
            "computation": computation,
            "evidence": f"Dimension tracking completed: {dim_expr}",
            "confidence": 0.8,
            "details": {"computed_dimensions": str(dim_expr)},
        }
    except Exception as e:
        return {
            "status": "warning",
            "computation": computation,
            "evidence": f"Dimension substitution failed: {e}",
            "confidence": 0.2,
            "details": {"substitution_error": str(e)},
        }

input_data = load_input()
result = run(input_data)
json.dump(result, sys.stdout)