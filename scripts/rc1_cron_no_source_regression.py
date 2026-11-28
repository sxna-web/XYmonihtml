from html.parser import HTMLParser
from pathlib import Path
import json
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
WORKER_SOURCE = ROOT / "backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js"
WORKER_BUNDLE = ROOT / "releases/v2.5.0-rc1/Worker.js"
RELEASE_HTML = ROOT / "releases/v2.5.0-rc1/index.html"
SCHEMA_INVENTORY = ROOT / "docs/release/V2.5.0_RC1_Worker数据库表字段静态清单_2026-11-28.json"


class InlineScripts(HTMLParser):
    def __init__(self):
        super().__init__()
        self.items = []
        self.current = None

    def handle_starttag(self, tag, attrs):
        if tag.lower() != "script":
            return
        attrs = dict(attrs)
        if attrs.get("src"):
            return
        kind = attrs.get("type", "").lower().strip()
        if kind not in ("", "text/javascript", "application/javascript", "module"):
            return
        self.current = {"type": kind, "chunks": []}

    def handle_data(self, data):
        if self.current is not None:
            self.current["chunks"].append(data)

    def handle_endtag(self, tag):
        if tag.lower() == "script" and self.current is not None:
            self.items.append(self.current)
            self.current = None


def scheduled_block(source: str) -> str:
    marker = "async scheduled(event, env, ctx) {"
    start = source.find(marker)
    if start < 0:
        raise AssertionError("scheduled() entrypoint missing")
    end = source.find("\n  },\n};", start)
    if end < 0:
        raise AssertionError("scheduled() method boundary missing")
    return source[start:end]


def node_check(source: str, suffix: str = ".mjs") -> None:
    with tempfile.NamedTemporaryFile("w", suffix=suffix, encoding="utf-8") as f:
        f.write(source)
        f.flush()
        subprocess.run(["node", "--check", f.name], check=True)


def main() -> None:
    source = WORKER_SOURCE.read_text(encoding="utf-8")
    bundle = WORKER_BUNDLE.read_text(encoding="utf-8")
    html = RELEASE_HTML.read_text(encoding="utf-8")
    inventory = json.loads(SCHEMA_INVENTORY.read_text(encoding="utf-8"))
    known_tables = {item["name"] for item in inventory["source_ddl_tables"] + inventory["worker_referenced_base_tables"]}
    if len(inventory["source_ddl_tables"]) != 18 or len(inventory["worker_referenced_base_tables"]) != 22 or len(known_tables) != 40:
        raise AssertionError("Static DB inventory counts must be 18 source-DDL + 22 referenced-base = 40 distinct tables")
    required_block = source.split("const REQUIRED_TABLES = [", 1)[1].split("];", 1)[0]
    referenced_block = source.split("const WORKER_REFERENCED_TABLES = [", 1)[1].split("];", 1)[0]
    required_tables = set(re.findall(r'"([a-z][a-z0-9_]+)"', required_block))
    referenced_tables = set(re.findall(r'"([a-z][a-z0-9_]+)"', referenced_block))
    inventory_core = {item["name"] for item in inventory["source_ddl_tables"]}
    inventory_referenced = {item["name"] for item in inventory["worker_referenced_base_tables"]}
    if required_tables != inventory_core:
        raise AssertionError("Read-only core table check must match the 18 source-DDL inventory names")
    if referenced_tables != inventory_referenced:
        raise AssertionError("Read-only Worker-reference table check must match all 22 referenced inventory names")
    if len(required_tables | referenced_tables) != 40:
        raise AssertionError("Read-only schema-status endpoint must cover all 40 inventory tables")
    sql_refs = set(re.findall(r"\b(?:FROM|JOIN|UPDATE|INTO|DELETE\s+FROM)\s+[\"'`]?([A-Za-z_][A-Za-z0-9_]*)", source, re.IGNORECASE))
    unclassified = sql_refs - known_tables - {"SET", "eff", "sqlite_master"}
    if unclassified:
        raise AssertionError("Worker SQL table references missing from schema inventory: " + ", ".join(sorted(unclassified)))
    committed_status = "UPDATE sync_tasks SET status='committed'" in source and "WHERE id = ? AND status = 'staged'" in source
    lifecycle_window = source.split("async function runNodeLifecycle", 1)[1].split("async function ", 1)[0]
    if not committed_status or "FROM sync_tasks WHERE source_id = ? AND status = 'committed'" not in lifecycle_window:
        raise AssertionError("Node lifecycle must use the committed sync-task terminal status")
    if "ORDER BY committed_at DESC, created_at DESC" not in lifecycle_window:
        raise AssertionError("Node lifecycle must order successful sync history by committed_at")

    node_check(source)
    node_check(bundle)

    block = scheduled_block(source)
    if "if (!sources.length) return;" in block:
        raise AssertionError("Cron still exits before lifecycle maintenance when no sources exist")
    maintenance = [
        "await runVipCardMaintenance(db, cronCtx)",
        "await runNodeLifecycle(db, cronCtx)",
        "await runEntitlementMaintenance(db)",
    ]
    positions = [block.find(item) for item in maintenance]
    if any(pos < 0 for pos in positions) or positions != sorted(positions):
        raise AssertionError("Cron maintenance calls missing or out of order")
    sync_guard = block.find("if (sources.length)")
    sync_call = block.find("await runSync(db, sources")
    if sync_guard < 0 or sync_call < sync_guard or positions[-1] > sync_guard:
        raise AssertionError("Only runSync may be conditional on sources.length")

    if re.search(r'^\s*import\b.*(?:worker-auth-adapter|authorization)\.mjs', bundle, re.MULTILINE):
        raise AssertionError("Bundled Worker still imports a local helper module")

    parser = InlineScripts()
    parser.feed(html)
    if not parser.items:
        raise AssertionError("No inline JavaScript blocks found in release HTML")
    for item in parser.items:
        suffix = ".mjs" if item["type"] == "module" else ".js"
        node_check("".join(item["chunks"]), suffix)

    if "localStorage.getItem('sj-api') || 'https://" in html:
        raise AssertionError("Release HTML still has a hard-coded API fallback bypassing the API input")

    dispatch = source.split('if (url.pathname === "/api/super/schema-status" || url.pathname === "/api/super/migrate")', 1)[1].split("if (url.pathname.startsWith", 1)[0]
    for guard in ("ctx.legacy", "ctx.actorId !== ctx.effectiveId"):
        if guard not in dispatch:
            raise AssertionError("Database route missing super-session/owner guard: " + guard)
    migrate = source.split("async function migrateRoute", 1)[1].split("/* ────────────────────────────── 站内提醒", 1)[0]
    if "MIGRATION_REVIEW_REQUIRED" not in migrate or "MIGRATE_STATEMENTS" in source:
        raise AssertionError("Unsafe legacy DDL path is not fully disabled")
    if "migration_enabled: false" not in migrate or "verification: \"TABLE_NAMES_ONLY\"" not in migrate:
        raise AssertionError("Schema status must disclose its table-name-only verification scope")
    if "required_tables_present:" not in migrate or "ready:" in migrate:
        raise AssertionError("Table-name-only status must not expose a misleading generic ready flag")
    if "worker_referenced_tables_present:" not in migrate or "all_worker_tables_present:" not in migrate:
        raise AssertionError("Schema status must report the additional Worker SQL reference table set")
    if "d.missing" not in html or "d.core_table_count" not in html:
        raise AssertionError("HTML must consume the explicit core table-name-only status fields")
    if "worker_referenced_missing" not in html or "all_worker_tables_present" not in html:
        raise AssertionError("HTML must display missing Worker-reference tables and total table-name status")
    if "api('/api/super/migrate'" in html or "RC1 暂不执行自动建表" not in html:
        raise AssertionError("HTML must remain read-only for database migration in RC1")

    redeem = source.split("async function appRedeemRoute", 1)[1].split("async function runEntitlementMaintenance", 1)[0]
    token_pos = redeem.find("const token = await entToken(env, id, deviceId)")
    write_pos = redeem.find("await userBatch(db, ctx")
    if token_pos < 0 or write_pos < 0 or token_pos > write_pos:
        raise AssertionError("APP HMAC token must be validated before consuming the card")

    print("PASS: source Worker syntax")
    print("PASS: self-contained bundled Worker syntax")
    print("PASS: Cron maintenance runs without sync sources")
    print(f"PASS: {len(parser.items)} inline HTML scripts")
    print("PASS: all HTML API calls use the configured API base")
    print("PASS: APP token secret validated before card redemption writes")
    print("PASS: DB migration rejects legacy/assist sessions")
    print("PASS: unsafe legacy DDL disabled; schema status is explicitly read-only and has no generic ready flag")
    print("PASS: HTML DB controls cannot trigger DDL")
    print("PASS: Worker SQL table references covered by 40-table evidence inventory")


if __name__ == "__main__":
    main()
