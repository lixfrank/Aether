# /// script
# requires-python = ">=3.11"
# dependencies = ["sympy>=1.12"]
# ///
"""Ward identity verification using sympy.simplify().

Verifies q_μ·M^μ = 0 by substituting polarization → momentum
and simplifying. Deterministic computation, not keyword scanning."""

import json
import sys
from sympy import Symbol, sympify, simplify, Function, IndexedBase

def load_input():
    if len(sys.argv) > 1:
        return json.loads(sys.argv[1])
    elif not sys.stdin.isatty():
        return json.load(sys.stdin)
    else:
        print("Usage: ward_identity_check.py [JSON] or pipe JSON to stdin", file=sys.stderr)
        sys.exit(1)

def run(data: dict) -> dict:
    amplitude = data.get("amplitude", "")
    momentum = data.get("momentum", "")
    polarization = data.get("polarization", "")
    conventions = data.get("context", {}).get("conventions", {})

    if not amplitude:
        return {
            "status": "insufficient_evidence",
            "computation": "No amplitude expression provided",
            "evidence": "Ward identity check requires amplitude expression",
            "confidence": 0.0,
        }

    try:
        M = sympify(amplitude)
        computation = f"Amplitude M = {M}"

        if momentum and polarization:
            q_sym = sympify(momentum)
            eps_sym = sympify(polarization)

            contracted = simplify(M.subs(eps_sym, q_sym))
            computation += f"\nSubstituted ε → q: {contracted}"
            computation += f"\nSimplified: {simplify(contracted)}"

            is_zero = simplify(contracted) == 0
            if is_zero:
                return {
                    "status": "pass",
                    "computation": computation,
                    "evidence": f"Ward identity verified: q_μ·M^μ = 0 after simplification",
                    "confidence": 0.95,
                    "details": {"contracted": str(contracted), "simplified": str(simplify(contracted))},
                }
            else:
                return {
                    "status": "fail",
                    "computation": computation,
                    "evidence": f"Ward identity NOT satisfied: q_μ·M^μ = {simplify(contracted)} (not zero)",
                    "confidence": 0.95,
                    "details": {"contracted": str(contracted), "simplified": str(simplify(contracted))},
                }

        return {
            "status": "warning",
            "computation": computation,
            "evidence": "Amplitude parsed but momentum/polarization symbols not provided for substitution",
            "confidence": 0.3,
            "details": {"parsed": str(M), "note": "Provide momentum and polarization symbols for Ward identity verification"},
        }
    except Exception as e:
        return {
            "status": "insufficient_evidence",
            "computation": f"SymPy parse/computation failed: {e}",
            "evidence": f"Error processing: {e}",
            "confidence": 0.0,
            "details": {"error": str(e)},
        }

input_data = load_input()
result = run(input_data)
json.dump(result, sys.stdout)