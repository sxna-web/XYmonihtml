"""Batch 78 offline protocol counterexamples; no D1, network or credentials."""
import hashlib
import struct
import unicodedata
import unittest

MISSING = object()
MAGIC = b"STARJUMP-APP-IDENTITY\x00CANON\x01"


def _lp(data: bytes) -> bytes:
    if len(data) > 0xFFFFFFFF:
        raise ValueError("field too large")
    return struct.pack(">I", len(data)) + data


def canonical_v1(fields):
    """Ordered sequence of (name, value); preserves missing/NULL/empty/type."""
    out = bytearray(MAGIC)
    seen = set()
    for name, value in fields:
        if not isinstance(name, str) or not name or name in seen:
            raise ValueError("invalid or duplicate field name")
        seen.add(name)
        name_bytes = unicodedata.normalize("NFC", name).encode("utf-8")
        if value is MISSING:
            tag, payload = b"M", b""
        elif value is None:
            tag, payload = b"N", b""
        elif isinstance(value, bool):
            tag, payload = b"B", (b"true" if value else b"false")
        elif isinstance(value, int):
            tag, payload = b"I", str(value).encode("ascii")
        elif isinstance(value, str):
            tag = b"S"
            payload = unicodedata.normalize("NFC", value).encode("utf-8")
        else:
            raise TypeError("unsupported canonical value type")
        out.extend(_lp(name_bytes))
        out.extend(tag)
        out.extend(_lp(payload))
    return bytes(out)


def digest_v1(fields):
    return hashlib.sha256(canonical_v1(fields)).hexdigest()


def receipt_key(owner, operation_id):
    if not owner or not operation_id:
        raise ValueError("owner and operation id required")
    return (owner, operation_id)


def binding_resolution(kind, operation_id, binding_id, created_by):
    if kind == "created":
        return {"event_type": "binding.created",
                "event_key": f"app.identity.binding.created:{binding_id}",
                "created_by_after": operation_id, "claims_created": True}
    if kind == "existing":
        return {"event_type": "binding.existing_resolved",
                "event_key": f"app.identity.binding.existing_resolved:{operation_id}",
                "created_by_after": created_by, "claims_created": False}
    raise ValueError("unknown result kind")


def count_qmarks(sql):
    """Count positional ? outside SQL strings and line/block comments."""
    i, count, state = 0, 0, "normal"
    while i < len(sql):
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < len(sql) else ""
        if state == "normal":
            if ch == "'": state = "single"
            elif ch == '"': state = "double"
            elif ch == "-" and nxt == "-":
                state = "line"; i += 1
            elif ch == "/" and nxt == "*":
                state = "block"; i += 1
            elif ch == "?": count += 1
            elif ch in (":", "@"):
                raise ValueError("named placeholder not allowed")
        elif state == "single":
            if ch == "'" and nxt == "'": i += 1
            elif ch == "'": state = "normal"
        elif state == "double":
            if ch == '"' and nxt == '"': i += 1
            elif ch == '"': state = "normal"
        elif state == "line":
            if ch == "\n": state = "normal"
        elif state == "block":
            if ch == "*" and nxt == "/":
                state = "normal"; i += 1
        i += 1
    if state in ("single", "double", "block"):
        raise ValueError("unterminated SQL literal/comment")
    return count


def validate_manifest(sql, manifest, bind_values):
    count = count_qmarks(sql)
    ordinals = [item["ordinal"] for item in manifest]
    if ordinals != list(range(1, count + 1)):
        raise ValueError("manifest ordinals/count mismatch")
    if len(bind_values) != count:
        raise ValueError("bind value count mismatch")
    if any(value is MISSING for value in bind_values):
        raise ValueError("undefined/missing bind value")
    return True


def hmac_overlap_admit(counts_by_version, limit):
    """Reference rule: reject if any accepted key-version bucket is full."""
    if not counts_by_version:
        raise ValueError("at least one active key version required")
    if any(count < 0 for count in counts_by_version.values()):
        raise ValueError("negative count")
    return not any(count >= limit for count in counts_by_version.values())


class Batch78ContractTests(unittest.TestCase):
    def test_01_created_emits_created_event(self):
        r = binding_resolution("created", "op-1", "b-1", None)
        self.assertEqual(r["event_type"], "binding.created")
        self.assertTrue(r["claims_created"])
        self.assertEqual(r["created_by_after"], "op-1")

    def test_02_existing_emits_distinct_resolution_event(self):
        r = binding_resolution("existing", "op-2", "b-old", "op-original")
        self.assertEqual(r["event_type"], "binding.existing_resolved")
        self.assertFalse(r["claims_created"])
        self.assertEqual(r["created_by_after"], "op-original")
        self.assertNotEqual(r["event_key"], "app.identity.binding.created:b-old")

    def test_03_unknown_result_kind_rejected(self):
        with self.assertRaises(ValueError):
            binding_resolution("created_existing", "op", "b", "old")

    def test_04_owner_scoped_operation_ids_are_independent(self):
        self.assertNotEqual(receipt_key("owner-A", "same-op"),
                            receipt_key("owner-B", "same-op"))

    def test_05_same_owner_operation_key_is_same(self):
        self.assertEqual(receipt_key("owner-A", "op"),
                         receipt_key("owner-A", "op"))

    def test_06_canonical_delimiter_collision_is_removed(self):
        a = [("a", "x|b:y"), ("b", "z")]
        b = [("a", "x"), ("b", "y|b:z")]
        self.assertNotEqual(canonical_v1(a), canonical_v1(b))

    def test_07_null_empty_missing_are_distinct(self):
        values = [None, "", MISSING]
        encoded = [canonical_v1([("field", value)]) for value in values]
        self.assertEqual(len(set(encoded)), 3)

    def test_08_boolean_and_integer_are_distinct(self):
        self.assertNotEqual(canonical_v1([("v", True)]),
                            canonical_v1([("v", 1)]))

    def test_09_unicode_nfc_equivalent_strings_match(self):
        self.assertEqual(canonical_v1([("name", "é")]),
                         canonical_v1([("name", "e\u0301")]))

    def test_10_field_order_is_contractual(self):
        self.assertNotEqual(canonical_v1([("a", 1), ("b", 2)]),
                            canonical_v1([("b", 2), ("a", 1)]))

    def test_11_digest_is_stable(self):
        fields = [("owner", "o1"), ("version", 1), ("optional", None)]
        self.assertEqual(digest_v1(fields), digest_v1(fields))

    def test_12_unsupported_types_rejected(self):
        with self.assertRaises(TypeError):
            canonical_v1([("x", 1.5)])

    def test_13_placeholder_counter_ignores_literals_and_comments(self):
        sql = "SELECT '?' AS q, ? -- ? hidden\n, '?' /* ? hidden */, ?"
        self.assertEqual(count_qmarks(sql), 2)

    def test_14_placeholder_counter_handles_escaped_quotes(self):
        self.assertEqual(count_qmarks("SELECT 'it''s ?' , ?"), 1)
        self.assertEqual(count_qmarks('SELECT "a""?b", ?'), 1)

    def test_15_named_placeholders_rejected(self):
        with self.assertRaises(ValueError):
            count_qmarks("SELECT :owner, ?")

    def test_16_manifest_requires_exact_ordinals(self):
        sql = "UPDATE t SET a=? WHERE id=?"
        manifest = [{"ordinal": 1}, {"ordinal": 3}]
        with self.assertRaises(ValueError):
            validate_manifest(sql, manifest, ["a", "id"])

    def test_17_manifest_rejects_undefined_binding(self):
        sql = "INSERT INTO t(a) VALUES(?)"
        with self.assertRaises(ValueError):
            validate_manifest(sql, [{"ordinal": 1}], [MISSING])

    def test_18_manifest_accepts_exact_positional_bindings(self):
        sql = "UPDATE t SET a=? WHERE id=?"
        self.assertTrue(validate_manifest(sql, [{"ordinal": 1}, {"ordinal": 2}],
                                          ["value", "row-id"]))

    def test_19_hmac_overlap_rejects_if_old_bucket_is_full(self):
        self.assertFalse(hmac_overlap_admit({"k1": 5, "k2": 1}, 5))

    def test_20_hmac_overlap_rejects_if_new_bucket_is_full(self):
        self.assertFalse(hmac_overlap_admit({"k1": 1, "k2": 5}, 5))

    def test_21_hmac_overlap_allows_only_when_all_versions_have_room(self):
        self.assertTrue(hmac_overlap_admit({"k1": 2, "k2": 3}, 5))

    def test_22_hmac_overlap_requires_versions(self):
        with self.assertRaises(ValueError):
            hmac_overlap_admit({}, 5)

    def test_23_hmac_overlap_rejects_invalid_negative_counts(self):
        with self.assertRaises(ValueError):
            hmac_overlap_admit({"k1": -1}, 5)


if __name__ == "__main__":
    unittest.main(verbosity=2)
