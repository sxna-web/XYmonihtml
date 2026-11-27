"""Offline structural validator for the Batch 76 D1 test matrix; never connects to D1."""
import json
from pathlib import Path

ROOT = Path(__file__).parent
MATRIX = ROOT / "d1_validation_matrix.json"
REQUIRED_IDS = {f"D1-{n:03d}" for n in range(1, 27)}
REQUIRED_FIELDS = {"id", "area", "mode", "procedure", "expected", "required_evidence", "cleanup"}
FORBIDDEN = ("production database", "starjump-staging", "starjump-db", "wrangler d1 execute", "DROP DATABASE")

def main():
    data = json.loads(MATRIX.read_text(encoding="utf-8"))
    assert data["batch"] == "V2.5-DEV-B1-APP-IDENTITY-76"
    assert data["status"] == "SPEC_ONLY_NO_D1_EXECUTION"
    safety = data["safety"]
    assert safety["requires_explicit_user_approval"] is True
    assert safety["requires_dedicated_disposable_d1"] is True
    assert safety["production_allowed"] is False
    assert safety["starjump_staging_substitute_allowed"] is False
    cases = data["cases"]
    ids = [case["id"] for case in cases]
    assert len(ids) == len(set(ids)), "duplicate case id"
    assert set(ids) == REQUIRED_IDS, f"missing/extra IDs: {set(ids) ^ REQUIRED_IDS}"
    for case in cases:
        assert REQUIRED_FIELDS <= set(case), f"missing fields: {case.get('id')}"
        assert case["mode"] in {"read_only", "disposable_write", "concurrent_disposable_requests", "read_only_after_fixture"}
        assert case["required_evidence"], f"missing evidence: {case['id']}"
        assert case["cleanup"], f"missing cleanup: {case['id']}"
        joined = " ".join(str(v) for v in case.values()).lower()
        assert "production data" not in joined, case["id"]
    for term in FORBIDDEN:
        assert term.lower() not in MATRIX.read_text(encoding="utf-8").lower(), f"unsafe target/command in matrix: {term}"
    print(f"Batch 76 D1 matrix structure: PASS ({len(cases)} cases)")
    print("Network/D1 access: NONE; SQL execution: NONE; migrations: NONE")

if __name__ == "__main__":
    main()
