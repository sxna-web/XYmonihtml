"""Batch 79 offline matrix, bind-manifest and limiter-overlap counterexamples.
No network, D1, SQL execution, credentials or production dependencies.
"""
import hashlib
import unittest

ALLOWED_SOURCES = {"authenticated_context", "validated_request", "server_constant", "derived_server_value"}
ALLOWED_STORAGE = {"text", "integer", "real", "blob", "null"}
ALLOWED_SENSITIVITY = {"public", "internal", "sensitive", "secret"}
REQUIRED_AUDIT_FIELDS = {
    "event_id", "event_key", "event_type", "schema_version", "occurred_at",
    "actor_type", "actor_id", "owner_admin_id", "target_type", "target_id",
    "operation_id", "outcome", "reason_code", "payload", "correlation_id",
}


def scan_placeholders(sql):
    """Count bare positional ?; reject named/numbered placeholders."""
    i, count, state = 0, 0, "normal"
    pairs = {"single": "'", "double": '"', "backtick": "`"}
    while i < len(sql):
        ch = sql[i]
        nxt = sql[i + 1] if i + 1 < len(sql) else ""
        if state == "normal":
            if ch == "'": state = "single"
            elif ch == '"': state = "double"
            elif ch == "`": state = "backtick"
            elif ch == "[" : state = "bracket"
            elif ch == "-" and nxt == "-": state = "line"; i += 1
            elif ch == "/" and nxt == "*": state = "block"; i += 1
            elif ch in (":", "@", "$"):
                if nxt and (nxt.isalnum() or nxt == "_"):
                    raise ValueError("named placeholder rejected")
            elif ch == "?":
                if nxt.isdigit():
                    raise ValueError("numbered placeholder rejected")
                count += 1
        elif state in pairs:
            if ch == pairs[state]:
                if nxt == ch: i += 1
                else: state = "normal"
        elif state == "bracket":
            if ch == "]":
                if nxt == "]": i += 1
                else: state = "normal"
        elif state == "line":
            if ch == "\n": state = "normal"
        elif state == "block":
            if ch == "*" and nxt == "/": state = "normal"; i += 1
        i += 1
    if state in ("single", "double", "backtick", "bracket", "block"):
        raise ValueError("unterminated quoted/comment region")
    return count


def validate_manifest(sql, manifest, bind_values):
    count = scan_placeholders(sql)
    sql_hash = hashlib.sha256(sql.encode("utf-8")).hexdigest()
    if manifest:
        if any(m.get("statement_id") != manifest[0].get("statement_id") for m in manifest):
            raise ValueError("statement id mismatch")
        if not manifest[0].get("statement_id"):
            raise ValueError("statement id required")
        if any(m.get("sql_sha256") != sql_hash for m in manifest):
            raise ValueError("exact SQL hash mismatch")
    if len(manifest) != count or len(bind_values) != count:
        raise ValueError("placeholder/manifest/bind count mismatch")
    expected = list(range(1, count + 1))
    if [m.get("ordinal") for m in manifest] != expected:
        raise ValueError("manifest ordinal order mismatch")
    names = [m.get("semantic_name") for m in manifest]
    if any(not isinstance(n, str) or not n for n in names) or len(set(names)) != len(names):
        raise ValueError("semantic names must be unique and non-empty")
    for m, value in zip(manifest, bind_values):
        if m.get("source") not in ALLOWED_SOURCES:
            raise ValueError("invalid bind source")
        if m.get("storage_class") not in ALLOWED_STORAGE:
            raise ValueError("invalid storage class")
        if m.get("sensitivity") not in ALLOWED_SENSITIVITY:
            raise ValueError("invalid sensitivity")
        if not isinstance(m.get("nullable"), bool):
            raise ValueError("nullable must be explicit boolean")
        if m.get("missing_policy") not in {"reject", "bind_null", "explicit_optional_shape"}:
            raise ValueError("missing policy required")
        if value is ...:
            raise ValueError("undefined/missing bind value")
        if value is None:
            if not m["nullable"] or m["storage_class"] != "null" or m["missing_policy"] != "bind_null":
                raise ValueError("NULL bind violates manifest")
        elif m["storage_class"] == "null":
            raise ValueError("non-NULL value declared as NULL")
        elif m["storage_class"] == "text" and not isinstance(value, str):
            raise ValueError("text bind type mismatch")
        elif m["storage_class"] == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
            raise ValueError("integer bind type mismatch")
        elif m["storage_class"] == "real" and not isinstance(value, (int, float)):
            raise ValueError("real bind type mismatch")
        elif m["storage_class"] == "blob" and not isinstance(value, bytes):
            raise ValueError("blob bind type mismatch")
    return sql_hash


def audit_envelope_missing(envelope):
    return REQUIRED_AUDIT_FIELDS - set(envelope)


def overlap_admit(events_by_version, limit):
    """Evaluate union of logical event IDs, not per-version counts."""
    if not events_by_version or limit < 1:
        raise ValueError("active versions and positive limit required")
    union = {}
    for version, events in events_by_version.items():
        if not version:
            raise ValueError("key version required")
        for event_id, fingerprint in events.items():
            if not event_id:
                raise ValueError("event id required")
            if event_id in union and union[event_id] != fingerprint:
                raise ValueError("cross-version event payload conflict")
            union[event_id] = fingerprint
    return len(union) < limit


def cleanup_eligible(retain_until, now, active_window_end, retry_horizon_end):
    """Strictly older than all protected horizons."""
    return retain_until < now and retain_until < active_window_end and retain_until < retry_horizon_end


class Batch79Tests(unittest.TestCase):
    def manifest(self, n=2, sql=""):
        sql_hash = hashlib.sha256(sql.encode("utf-8")).hexdigest()
        return [
            {"statement_id": "stmt_test", "sql_sha256": sql_hash,
             "ordinal": i, "semantic_name": f"bind_{i}", "source": "validated_request",
             "storage_class": "text", "nullable": False, "missing_policy": "reject",
             "sensitivity": "internal"}
            for i in range(1, n + 1)
        ]

    def test_01_exact_manifest_validates_and_returns_sql_hash(self):
        sql = "UPDATE t SET a=? WHERE id=?"
        digest = validate_manifest(sql, self.manifest(2, sql), ["x", "id"])
        self.assertEqual(digest, hashlib.sha256(sql.encode()).hexdigest())

    def test_02_qmarks_inside_all_quote_regions_ignored(self):
        sql = "SELECT '?', \"?\", `?`, [?], ?"
        self.assertEqual(scan_placeholders(sql), 1)

    def test_03_qmarks_in_line_and_block_comments_ignored(self):
        self.assertEqual(scan_placeholders("SELECT ? -- ?\n/* ? */ , ?"), 2)

    def test_04_doubled_single_quote_escape(self):
        self.assertEqual(scan_placeholders("SELECT 'it''s ?' , ?"), 1)

    def test_05_doubled_double_quote_escape(self):
        self.assertEqual(scan_placeholders('SELECT "a""?b", ?'), 1)

    def test_06_doubled_backtick_escape(self):
        self.assertEqual(scan_placeholders("SELECT `a``?`, ?"), 1)

    def test_07_bracket_identifier_question_mark_ignored(self):
        self.assertEqual(scan_placeholders("SELECT [?column?], ?"), 1)

    def test_08_named_colon_placeholder_rejected(self):
        with self.assertRaises(ValueError): scan_placeholders("SELECT :owner, ?")

    def test_09_named_at_placeholder_rejected(self):
        with self.assertRaises(ValueError): scan_placeholders("SELECT @owner, ?")

    def test_10_named_dollar_placeholder_rejected(self):
        with self.assertRaises(ValueError): scan_placeholders("SELECT $owner, ?")

    def test_11_numbered_placeholder_rejected(self):
        with self.assertRaises(ValueError): scan_placeholders("SELECT ?1")

    def test_12_numeric_named_placeholder_rejected(self):
        for prefix in (":", "@", "$"):
            with self.assertRaises(ValueError): scan_placeholders(f"SELECT {prefix}1")

    def test_35_unterminated_single_quote_rejected(self):
        with self.assertRaises(ValueError): scan_placeholders("SELECT 'abc ?")

    def test_13_unterminated_block_comment_rejected(self):
        with self.assertRaises(ValueError): scan_placeholders("SELECT ? /* ?")

    def test_14_manifest_count_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            validate_manifest("SELECT ?, ?", self.manifest(1, "SELECT ?, ?"), ["a", "b"])

    def test_15_manifest_order_mismatch_rejected(self):
        m = self.manifest(2, "SELECT ?, ?"); m[0]["ordinal"], m[1]["ordinal"] = 2, 1
        with self.assertRaises(ValueError): validate_manifest("SELECT ?, ?", m, ["a", "b"])

    def test_16_duplicate_semantic_names_rejected(self):
        m = self.manifest(2, "SELECT ?, ?"); m[1]["semantic_name"] = m[0]["semantic_name"]
        with self.assertRaises(ValueError): validate_manifest("SELECT ?, ?", m, ["a", "b"])

    def test_17_undefined_bind_rejected(self):
        with self.assertRaises(ValueError):
            validate_manifest("SELECT ?", self.manifest(1, "SELECT ?"), [...])

    def test_18_text_type_mismatch_rejected(self):
        with self.assertRaises(ValueError):
            validate_manifest("SELECT ?", self.manifest(1, "SELECT ?"), [123])

    def test_19_boolean_is_not_integer_bind(self):
        m = self.manifest(1, "SELECT ?"); m[0]["storage_class"] = "integer"
        with self.assertRaises(ValueError): validate_manifest("SELECT ?", m, [True])

    def test_20_null_requires_explicit_null_contract(self):
        m = self.manifest(1, "SELECT ?"); m[0].update(storage_class="null", nullable=True, missing_policy="bind_null")
        self.assertTrue(validate_manifest("SELECT ?", m, [None]))

    def test_21_null_without_nullable_rejected(self):
        m = self.manifest(1); m[0].update(storage_class="null", nullable=False, missing_policy="bind_null")
        with self.assertRaises(ValueError): validate_manifest("SELECT ?", m, [None])

    def test_22_invalid_manifest_enum_rejected(self):
        m = self.manifest(1); m[0]["source"] = "client_claimed_owner"
        with self.assertRaises(ValueError): validate_manifest("SELECT ?", m, ["x"])

    def test_23_sql_hash_changes_with_exact_whitespace(self):
        a = validate_manifest("SELECT ?", self.manifest(1, "SELECT ?"), ["x"])
        b = validate_manifest("SELECT  ?", self.manifest(1), ["x"])
        self.assertNotEqual(a, b)

    def test_24_manifest_rejects_wrong_exact_sql_hash(self):
        sql = "SELECT ?"
        m = self.manifest(1, sql)
        m[0]["sql_sha256"] = "0" * 64
        with self.assertRaises(ValueError): validate_manifest(sql, m, ["x"])

    def test_25_audit_envelope_required_fields_complete(self):
        self.assertEqual(audit_envelope_missing({k: None for k in REQUIRED_AUDIT_FIELDS}), set())

    def test_25_audit_envelope_missing_actor_owner_target_detected(self):
        envelope = {k: None for k in REQUIRED_AUDIT_FIELDS}
        for k in ("actor_type", "actor_id", "owner_admin_id", "target_type", "target_id"):
            envelope.pop(k)
        self.assertEqual(audit_envelope_missing(envelope),
                         {"actor_type", "actor_id", "owner_admin_id", "target_type", "target_id"})

    def test_26_audit_envelope_missing_schema_outcome_reason_detected(self):
        envelope = {k: None for k in REQUIRED_AUDIT_FIELDS}
        for k in ("schema_version", "outcome", "reason_code"): envelope.pop(k)
        self.assertEqual(audit_envelope_missing(envelope), {"schema_version", "outcome", "reason_code"})

    def test_27_split_key_history_cannot_undercount(self):
        events = {"old": {f"e{i}": "same" for i in range(3)},
                  "new": {f"e{i}": "same" for i in range(3, 6)}}
        self.assertFalse(overlap_admit(events, 5))

    def test_28_dual_written_same_event_counts_once(self):
        events = {"old": {"e1": "fp1"}, "new": {"e1": "fp1"}}
        self.assertTrue(overlap_admit(events, 2))

    def test_29_cross_version_same_event_different_payload_conflicts(self):
        events = {"old": {"e1": "fp1"}, "new": {"e1": "changed"}}
        with self.assertRaises(ValueError): overlap_admit(events, 5)

    def test_30_missing_event_id_rejected(self):
        with self.assertRaises(ValueError): overlap_admit({"old": {"": "fp"}}, 5)

    def test_31_cleanup_strictly_before_all_horizons(self):
        self.assertTrue(cleanup_eligible(10, 11, 12, 13))

    def test_32_cleanup_exact_boundary_retained(self):
        self.assertFalse(cleanup_eligible(10, 10, 12, 13))

    def test_33_cleanup_active_window_protected(self):
        self.assertFalse(cleanup_eligible(11, 12, 11, 20))

    def test_34_cleanup_retry_horizon_protected(self):
        self.assertFalse(cleanup_eligible(11, 12, 20, 11))


if __name__ == "__main__":
    unittest.main(verbosity=2)
