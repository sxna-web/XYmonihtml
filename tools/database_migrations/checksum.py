"""Deterministic checksum helpers for local migration review; not a D1 guarantee."""
from __future__ import annotations
import hashlib
from pathlib import Path

def canonical_sql_bytes(data: bytes) -> bytes:
    """Normalize line endings only; preserve all other SQL bytes exactly."""
    return data.replace(b"\r\n", b"\n").replace(b"\r", b"\n")

def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(canonical_sql_bytes(data)).hexdigest()

def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())
