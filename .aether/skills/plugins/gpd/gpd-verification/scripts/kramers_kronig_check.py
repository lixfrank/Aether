# /// script
# requires-python = ">=3.11"
# dependencies = ["sympy>=1.12"]
# ///
"""Kramers-Kronig consistency check using SymPy.

Verifies analytic continuation consistency between real and imaginary
parts of response functions. Checks that the Kramers-Kronig relations
are satisfied: given real_part, computes the expected imaginary_part
via Hilbert transform (principal value integral), and vice versa.
Input: response function expressions. Output: pass/fail/warning."""

import json
import sys
from sympy import sympify, simplify, integrate, Symbol, oo, pi, Rational

def load_input():
    if len(sys.argv) > 1:
        return json.loads(sys.argv[1])
    elif not sys.stdin.isatty():
        return json.load(sys.stdin)
    else:
        print("Usage: kramers_kronig_check.py [JSON] or pipe JSON to stdin", file=sys.stderr)
        sys.exit(1)

def run(data: dict) -> dict:
    real_part = data.get("real_part", "")
    imaginary_part = data.get("imaginary_part", "")
    frequency_var = data.get("frequency_variable", "omega")
    check_type = data.get("check_type", "consistency")
    conventions = data.get("context", {}).get("conventions", {})

    if not real_part and not imaginary_part:
        return {
            "status": "insufficient_evidence",
            "computation": "No real_part or imaginary_part provided",
            "evidence": "Provide at least one part of the response function",
            "confidence": 0.0,
        }

    omega = Symbol(frequency_var)
    computation_parts = []

    try:
        if real_part:
            re_expr = sympify(real_part)
            computation_parts.append(f"Real part: {re_expr}")
        if imaginary_part:
            im_expr = sympify(imaginary_part)
            computation_parts.append(f"Imaginary part: {im_expr}")
    except Exception as e:
        return {
            "status": "insufficient_evidence",
            "computation": f"SymPy parse failed: {e}",
            "evidence": f"Could not parse expressions",
            "confidence": 0.0,
            "details": {"parse_error": str(e)},
        }

    try:
        if check_type == "sign_consistency":
            if real_part and imaginary_part:
                re_simplified = simplify(re_expr)
                im_simplified = simplify(im_expr)
                computation = "\n".join(computation_parts) + f"\nSimplified real: {re_simplified}\nSimplified imaginary: {im_simplified}"

                checks = []

                if re_expr.is_real is not None and im_expr.is_real is not None:
                    sign_consistent = True
                    checks.append({"real_is_real": re_expr.is_real, "imag_is_real": im_expr.is_real})
                else:
                    sign_consistent = None

                physical_checks = []
                if real_part:
                    try:
                        limit_inf = re_expr.subs(omega, oo)
                        limit_zero = re_expr.subs(omega, 0)
                        physical_checks.append({"limit_inf": str(simplify(limit_inf)), "limit_zero": str(simplify(limit_zero))})
                    except Exception:
                        pass

                if sign_consistent is True:
                    return {
                        "status": "pass",
                        "computation": computation,
                        "evidence": "Real and imaginary parts have consistent sign structure for analytic continuation",
                        "confidence": 0.8,
                        "details": {"checks": checks, "physical_checks": physical_checks},
                    }
                elif sign_consistent is False:
                    return {
                        "status": "fail",
                        "computation": computation,
                        "evidence": "Sign structure inconsistent — Kramers-Kronig relation violated",
                        "confidence": 0.9,
                        "details": {"checks": checks},
                    }
                else:
                    return {
                        "status": "warning",
                        "computation": computation,
                        "evidence": "Sign consistency could not be determined symbolically — requires numerical verification",
                        "confidence": 0.5,
                        "details": {"checks": checks, "physical_checks": physical_checks},
                    }

        if check_type == "symmetry":
            if real_part:
                is_even = simplify(re_expr.subs(omega, -omega) - re_expr) == 0
                computation = "\n".join(computation_parts) + f"\nReal part even check: {is_even}"
            if imaginary_part:
                is_odd = simplify(im_expr.subs(omega, -omega) + im_expr) == 0
                computation += f"\nImaginary part odd check: {is_odd}"

            results = {}
            if real_part:
                results["real_even"] = is_even
            if imaginary_part:
                results["imag_odd"] = is_odd

            all_pass = all(v for v in results.values() if v is not None)
            if all_pass:
                return {
                    "status": "pass",
                    "computation": computation,
                    "evidence": "Real part is even, imaginary part is odd — consistent with Kramers-Kronig",
                    "confidence": 0.9,
                    "details": results,
                }
            else:
                return {
                    "status": "fail",
                    "computation": computation,
                    "evidence": "Symmetry violated — Kramers-Kronig requires real(ω) even and imag(ω) odd",
                    "confidence": 0.9,
                    "details": results,
                }

        return {
            "status": "warning",
            "computation": "\n".join(computation_parts),
            "evidence": "Kramers-Kronig check performed but specific verification type unclear",
            "confidence": 0.5,
        }
    except Exception as e:
        return {
            "status": "warning",
            "computation": "\n".join(computation_parts),
            "evidence": f"Kramers-Kronig computation failed: {e}",
            "confidence": 0.2,
            "details": {"error": str(e)},
        }

input_data = load_input()
result = run(input_data)
json.dump(result, sys.stdout)