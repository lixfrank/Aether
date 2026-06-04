# /// script
# requires-python = ">=3.11"
# dependencies = ["sympy>=1.12"]
# ///
"""Numerical convergence verification.

Tests series convergence at specified thresholds.
Input: series + order + threshold.
Output: pass/fail/warning with convergence data."""

import json
import sys
from sympy import Symbol, sympify, N, Float, oo, series as sympy_series

def load_input():
    if len(sys.argv) > 1:
        return json.loads(sys.argv[1])
    elif not sys.stdin.isatty():
        return json.load(sys.stdin)
    else:
        print("Usage: convergence_check.py [JSON] or pipe JSON to stdin", file=sys.stderr)
        sys.exit(1)

def run(data: dict) -> dict:
    series_expr = data.get("series", "")
    order = data.get("order", 6)
    threshold = data.get("threshold", 1e-6)
    test_values = data.get("test_values", {})
    conventions = data.get("context", {}).get("conventions", {})

    if not series_expr:
        return {
            "status": "insufficient_evidence",
            "computation": "No series expression provided",
            "evidence": "Convergence check requires series",
            "confidence": 0.0,
        }

    try:
        expr = sympify(series_expr)
        computation = f"Series: {expr}"
    except Exception as e:
        return {
            "status": "insufficient_evidence",
            "computation": f"Parse failed: {e}",
            "evidence": f"Could not parse: {series_expr}",
            "confidence": 0.0,
        }

    if test_values:
        try:
            subs = {}
            for sym_name, val in test_values.items():
                subs[Symbol(sym_name)] = Float(val)

            numerical = N(expr.subs(subs))
            computation += f"\nTest values: {subs}\nComputed: {numerical}"
            magnitude = abs(float(numerical))

            if magnitude < float(threshold):
                return {
                    "status": "pass",
                    "computation": computation + f"\nMagnitude {magnitude} < threshold {threshold}",
                    "evidence": f"Convergence check passed: |value| = {magnitude} < {threshold}",
                    "confidence": 0.9,
                    "details": {"magnitude": magnitude, "threshold": float(threshold)},
                }
            else:
                return {
                    "status": "fail",
                    "computation": computation + f"\nMagnitude {magnitude} ≥ threshold {threshold}",
                    "evidence": f"Convergence check failed: |value| = {magnitude} ≥ {threshold}",
                    "confidence": 0.9,
                    "details": {"magnitude": magnitude, "threshold": float(threshold)},
                }
        except Exception as e:
            return {
                "status": "insufficient_evidence",
                "computation": computation + f"\nNumerical eval failed: {e}",
                "evidence": f"Error: {e}",
                "confidence": 0.0,
            }

    return {
        "status": "warning",
        "computation": computation + "\nNo test values provided for convergence evaluation",
        "evidence": "Provide test_values for numerical convergence evaluation",
        "confidence": 0.3,
        "details": {"parsed": str(expr)},
    }

input_data = load_input()
result = run(input_data)
json.dump(result, sys.stdout)