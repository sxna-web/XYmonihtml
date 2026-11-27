#!/usr/bin/env python3
"""Offline-only structural checks for Batch 77 documents; no D1/network/credentials."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parent
REQUIRED = {
    "SQL-PORTABILITY-AND-ASSERTION-REVIEW.md": [
        "F77-01", "CHECK", "NULL", "canonical", "existing-binding",
        "owner-scoped", "NOT_DEPLOYABLE",
    ],
    "D1-HARNESS-ADMISSION-CONTRACT.md": [
        "ENABLE_DISPOSABLE_D1_TESTS=true", "default false",
        "test_run_id", "cleanup", "STOP", "No implicit credentials",
        "Production is always rejected",
    ],
}
for filename, needles in REQUIRED.items():
    path = ROOT / filename
    if not path.is_file():
        raise SystemExit(f"FAIL missing {filename}")
    content = path.read_text(encoding="utf-8")
    missing = [needle for needle in needles if needle.lower() not in content.lower()]
    if missing:
        raise SystemExit(f"FAIL {filename}: missing markers {missing}")

harness = (ROOT / "D1-HARNESS-ADMISSION-CONTRACT.md").read_text(encoding="utf-8")
for forbidden in ("wrangler d1 execute", "CLOUDFLARE_API_TOKEN=", "D1_DATABASE_ID="):
    if forbidden.lower() in harness.lower():
        raise SystemExit(f"FAIL unsafe executable credential/command marker: {forbidden}")

print("Batch 77 offline contract structure: PASS")
print("Network/D1 access: NONE; credentials read: NONE; SQL execution: NONE")
