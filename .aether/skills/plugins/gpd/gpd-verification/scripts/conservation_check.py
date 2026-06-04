# /// script
# requires-python = ">=3.11"
# dependencies = ["sympy>=1.12"]
# ///
"""Conservation law verification using SymPy.

Checks whether expressions satisfy conservation constraints by
simplifying the conserved quantity and verifying it equals zero
or a constant. Input: conserved_quantity expression + context.
Output: pass/fail/warning with simplification evidence."""

import json
import sys
from sympy import sympify, simplify, Symbol

def load_input():
    if len(sys.argv) > 1:
        return json.loads(sys.argv[1])
    elif not sys.stdin.isatty():
        return json.load(sys.stdin)
    else:
        print("Usage: conservation_check.py [JSON] or pipe JSON to stdin", file=sys.stderr)
        sys.exit(1)

def run(data: dict) -> dict:
    quantity = data.get("conserved_quantity", "")
    conserved_type = data.get("conserved_type", "auto")
    expected_value = data.get("expected_value", "0")
    substitutions = data.get("substitutions", {})
    conventions = data.get("context", {}).get("conventions", {})

    if not quantity:
        return {
            "status": "insufficient_evidence",
            "computation": "No conserved_quantity provided",
            "evidence": "Provide conserved_quantity: expression that should simplify to zero/constant",
            "confidence": 0.0,
        }

    try:
        expr = sympify(quantity)
    except Exception as e:
        return {
            "status": "insufficient_evidence",
            "computation": f"SymPy parse failed: {e}",
            "evidence": f"Could not parse expression: {quantity}",
            "confidence": 0.0,
            "details": {"parse_error": str(e)},
        }

    try:
        if substitutions:
            subs_pairs = []
            for old, new in substitutions.items():
                subs_pairs.append((sympify(old), sympify(new)))
            expr = expr.subs(subs_pairs)

        simplified = simplify(expr)
        computation = f"Original: {quantity}\nSubstitutions: {substitutions}\nSimplified: {simplified}"

        expected_expr = sympify(expected_value)
        diff = simplify(simplified - expected_expr)
        is_zero = diff == 0

        if is_zero:
            return {
                "status": "pass",
                "computation": computation,
                "evidence": f"Conserved quantity simplifies to {expected_value}: {simplified} == {expected_expr}",
                "confidence": 0.95,
                "details": {"simplified": str(simplified), "expected": str(expected_expr)},
            }
        else:
            return {
                "status": "fail",
                "computation": computation,
                "evidence": f"Conservation law violated: {simplified} != {expected_expr}, diff = {diff}",
                "confidence": 0.95,
                "details": {"simplified": str(simplified), "expected": str(expected_expr), "diff": str(diff)},
            }
    except Exception as e:
        return {
            "status": "warning",
            "computation": computation,
            "evidence": f"Simplification failed: {e}",
            "confidence": 0.2,
            "details": {"simplification_error": str(e)},
        }

input_data = load_input()
result = run(input_data)
json.dump(result, sys.stdout)