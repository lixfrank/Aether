# /// script
# requires-python = ">=3.11"
# dependencies = ["sympy>=1.12"]
# ///
"""Symmetry verification using SymPy transformation templates.

Verifies that an expression remains invariant under specified symmetry transformations.
Deterministic computation, not strategy text."""

import json
import sys
from sympy import Symbol, sympify, simplify, Function

def load_input():
    if len(sys.argv) > 1:
        return json.loads(sys.argv[1])
    elif not sys.stdin.isatty():
        return json.load(sys.stdin)
    else:
        print("Usage: symmetry_check.py [JSON] or pipe JSON to stdin", file=sys.stderr)
        sys.exit(1)

def run(data: dict) -> dict:
    expression = data.get("expression", "")
    symmetry_type = data.get("symmetry_type", "")
    transform = data.get("transform", {})
    conventions = data.get("context", {}).get("conventions", {})

    if not expression:
        return {
            "status": "insufficient_evidence",
            "computation": "No expression provided",
            "evidence": "Symmetry check requires expression",
            "confidence": 0.0,
        }

    try:
        expr = sympify(expression)
        computation = f"Expression: {expr}"
    except Exception as e:
        return {
            "status": "insufficient_evidence",
            "computation": f"Parse failed: {e}",
            "evidence": f"Could not parse: {expression}",
            "confidence": 0.0,
        }

    if not transform:
        return {
            "status": "warning",
            "computation": computation + "\nNo transform specification provided",
            "evidence": f"Expression parsed but no transform for {symmetry_type} symmetry",
            "confidence": 0.3,
            "details": {"parsed": str(expr), "note": "Provide transform: {old_symbol: new_expression} for verification"},
        }

    try:
        subs = {}
        for old_sym, new_expr in transform.items():
            subs[Symbol(old_sym)] = sympify(new_expr)

        transformed = expr.subs(subs)
        simplified_transformed = simplify(transformed)
        simplified_original = simplify(expr)
        computation += f"\nTransformed: {transformed}"
        computation += f"\nSimplified transformed: {simplified_transformed}"
        computation += f"\nSimplified original: {simplified_original}"

        is_invariant = simplify(simplified_transformed - simplified_original) == 0
        if is_invariant:
            return {
                "status": "pass",
                "computation": computation,
                "evidence": f"{symmetry_type} symmetry verified: expression invariant under transform",
                "confidence": 0.95,
                "details": {"transformed": str(transformed), "invariant": True},
            }
        else:
            return {
                "status": "fail",
                "computation": computation,
                "evidence": f"{symmetry_type} symmetry NOT invariant: diff = {simplify(simplified_transformed - simplified_original)}",
                "confidence": 0.95,
                "details": {"transformed": str(transformed), "diff": str(simplify(simplified_transformed - simplified_original))},
            }
    except Exception as e:
        return {
            "status": "insufficient_evidence",
            "computation": computation + f"\nTransform failed: {e}",
            "evidence": f"Transform computation error: {e}",
            "confidence": 0.0,
            "details": {"error": str(e)},
        }

input_data = load_input()
result = run(input_data)
json.dump(result, sys.stdout)