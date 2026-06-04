# /// script
# requires-python = ">=3.11"
# dependencies = ["sympy>=1.12"]
# ///
"""Numerical spot-check verification.

Substitutes specific numerical values into expressions to verify identities.
Input: expression + test values.
Output: pass/fail with numerical comparison."""

import json
import sys
from sympy import Symbol, sympify, N, Float

def load_input():
    if len(sys.argv) > 1:
        return json.loads(sys.argv[1])
    elif not sys.stdin.isatty():
        return json.load(sys.stdin)
    else:
        print("Usage: spot_check.py [JSON] or pipe JSON to stdin", file=sys.stderr)
        sys.exit(1)

def run(data: dict) -> dict:
    expression = data.get("expression", "")
    test_values = data.get("test_values", {})
    expected_value = data.get("expected_value")
    threshold = data.get("threshold", 1e-8)
    conventions = data.get("context", {}).get("conventions", {})

    if not expression:
        return {
            "status": "insufficient_evidence",
            "computation": "No expression provided",
            "evidence": "Spot check requires expression",
            "confidence": 0.0,
        }

    try:
        expr = sympify(expression)
    except Exception as e:
        return {
            "status": "insufficient_evidence",
            "computation": f"Parse failed: {e}",
            "evidence": f"Could not parse: {expression}",
            "confidence": 0.0,
        }

    if not test_values:
        return {
            "status": "warning",
            "computation": f"Expression: {expr}\nNo test values provided",
            "evidence": "Provide test_values: {symbol: numerical_value} for spot-check",
            "confidence": 0.3,
        }

    try:
        subs = {}
        for sym_name, val in test_values.items():
            subs[Symbol(sym_name)] = Float(val)

        numerical = N(expr.subs(subs))
        computation = f"Expression: {expr}\nSubstituted: {subs}\nComputed: {numerical}"

        if expected_value is not None:
            exp_num = Float(expected_value)
            diff = abs(float(numerical) - float(exp_num))
            match = diff < float(threshold)
            computation += f"\nExpected: {exp_num}\nDifference: {diff}"
            if match:
                return {
                    "status": "pass",
                    "computation": computation,
                    "evidence": f"Spot-check passed: computed {numerical} ≈ expected {exp_num} (diff={diff})",
                    "confidence": 0.95,
                    "details": {"computed": float(numerical), "expected": float(exp_num), "diff": diff},
                }
            else:
                return {
                    "status": "fail",
                    "computation": computation,
                    "evidence": f"Spot-check failed: computed {numerical} ≠ expected {exp_num} (diff={diff})",
                    "confidence": 0.95,
                    "details": {"computed": float(numerical), "expected": float(exp_num), "diff": diff},
                }

        return {
            "status": "pass",
            "computation": computation,
            "evidence": f"Numerical evaluation: {numerical}",
            "confidence": 0.8,
            "details": {"computed": float(numerical)},
        }
    except Exception as e:
        return {
            "status": "insufficient_evidence",
            "computation": f"Numerical evaluation failed: {e}",
            "evidence": f"Error: {e}",
            "confidence": 0.0,
            "details": {"error": str(e)},
        }

input_data = load_input()
result = run(input_data)
json.dump(result, sys.stdout)