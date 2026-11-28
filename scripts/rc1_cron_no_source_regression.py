from html.parser import HTMLParser
from pathlib import Path
import json
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
WORKER_SOURCE = ROOT / "backend/worker/V2.5-DEV-B1-CORE-AUTH-49/Worker.js"
AUTH_ADAPTER = ROOT / "backend/worker/V2.5-DEV-B1-CORE-AUTH-49/worker-auth-adapter.mjs"
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
    auth_adapter = AUTH_ADAPTER.read_text(encoding="utf-8")
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
    unclassified = sql_refs - known_tables - {"SET", "eff", "sqlite_master", "to"}  # "UPDATE to ..." may occur in comments
    if unclassified:
        raise AssertionError("Worker SQL table references missing from schema inventory: " + ", ".join(sorted(unclassified)))
    committed_status = "UPDATE sync_tasks SET status='committed'" in source and "WHERE id = ? AND status = 'staged'" in source
    lifecycle_window = source.split("async function runNodeLifecycle", 1)[1].split("async function ", 1)[0]
    if not committed_status or "FROM sync_tasks WHERE source_id = ? AND status = 'committed'" not in lifecycle_window:
        raise AssertionError("Node lifecycle must use the committed sync-task terminal status")
    if "ORDER BY committed_at DESC, created_at DESC" not in lifecycle_window:
        raise AssertionError("Node lifecycle must order successful sync history by committed_at")

    # Source ownership must be revalidated inside the same write batch and in
    # the final mutation SQL, not only by a prior SELECT.
    owner_helper = source.split("function sourceOwnerFence", 1)[1].split("async function loadSubscriptionNode", 1)[0]
    user_sources = source.split("async function userSourcesRoute", 1)[1].split("async function userConvertGroupsRoute", 1)[0]
    if "assertStmt(db" not in owner_helper or "source_ownership" not in owner_helper:
        raise AssertionError("User source mutations need an in-batch ownership assertion")
    if user_sources.count("${ownerFence.sql}") < 3 or user_sources.count("sourceOwnerFence(db, ctx, id)") < 3:
        raise AssertionError("Source enabled/update/archive SQL must all carry the final owner predicate")
    if "owner_user_id: own.user_id" not in user_sources:
        raise AssertionError("Manual source sync must carry the verified owner into the sync fence")
    if "so.user_id AS owner_user_id" not in scheduled_block(source):
        raise AssertionError("Cron source selection must carry the source owner into the sync fence")
    if "so.user_id = ?" not in source.split("const FENCE_SQL", 1)[1].split("function fenceBinds", 1)[0]:
        raise AssertionError("Sync stage/commit fence must revalidate source ownership")

    # APP management writes must use the same-batch assist-scope guard.
    app_groups = source.split("async function userAppGroupsRoute", 1)[1].split("/** APP：按可见性返回分组与节点 */", 1)[0]
    if ".run()" in app_groups:
        raise AssertionError("User APP group mutations must not bypass userBatch/scopeGuard")
    if app_groups.count("await userBatch(db, ctx") < 6:
        raise AssertionError("APP group create/update/delete/source/member mutations must use userBatch")
    if "EXISTS (SELECT 1 FROM app_groups WHERE id = ? AND admin_user_id = ?)" not in app_groups:
        raise AssertionError("APP group association removal must retain a final owner predicate")
    if "const ownershipGuard = cutoff" not in app_groups:
        raise AssertionError("APP group history delete must assert owner/cutoff before child cleanup")
    if auth_adapter.count('p.length === 6 && p[4] === "sources" && method === "DELETE") return "associate";') != 1:
        raise AssertionError("APP source-association removal must be an active-VIP configuration mutation")
    app_links = source.split("async function addAppLink", 1)[1].split("/* 超管 */", 1)[0]
    if "await userBatch(db, ctx" not in app_links or "auditStmt(db, ctx" not in app_links:
        raise AssertionError("APP link creation must share its assist-scope guard and audit batch")
    if "assertStmt(db," not in app_links or "LINKS_LIMIT_CHANGED" not in app_links or "COUNT(*) FROM app_links WHERE admin_user_id = ?" not in app_links:
        raise AssertionError("APP link creation must recheck current permission and max-link quota inside the insert batch")
    super_groups = source.split("async function superAppGroupsRoute", 1)[1].split("/** 管理员管理自己的分组", 1)[0]
    if ".run()" in super_groups:
        raise AssertionError("Super APP group writes must not bypass atomic D1 batches")
    if super_groups.count("await db.batch([") < 7:
        raise AssertionError("Super APP group create/update/delete/source/member writes must be batched")
    if super_groups.count("auditStmt(db, ctx") < 7:
        raise AssertionError("Super APP group mutations must be audited in their business batch")
    if "assertStmt(db, \"EXISTS (SELECT 1 FROM app_users WHERE id = ?)\", [adminId])" not in super_groups:
        raise AssertionError("Super APP group creation must verify target admin existence in the same batch")
    if "DELETE FROM app_group_sources WHERE group_id = ? AND EXISTS" not in super_groups or "DELETE FROM app_group_members WHERE group_id = ? AND EXISTS" not in super_groups:
        raise AssertionError("Super APP group deletion must clean child associations before deleting the parent")
    if "app_group.super_source_add" not in super_groups or "app_group.super_source_remove" not in super_groups:
        raise AssertionError("Super APP source association mutations must have audit events")
    if "app_group.super_member_add" not in super_groups or "app_group.super_member_remove" not in super_groups:
        raise AssertionError("Super APP member mutations must have audit events")

    super_links = source.split("async function superAppLinksRoute", 1)[1].split("/* 免费分组：管理员开启后", 1)[0]
    if ".run()" in super_links:
        raise AssertionError("Super APP link/permission/rebind mutations must not bypass atomic D1 batches")
    if super_links.count("await db.batch([") < 3 or super_links.count("auditStmt(db, ctx") < 3:
        raise AssertionError("Super APP link delete, permission update and entitlement rebind must be batched and audited")
    if "free_group_enabled=CASE WHEN ? = 1 THEN excluded.free_group_enabled ELSE admin_app_perms.free_group_enabled END" not in super_links:
        raise AssertionError("APP permission update must preserve free-group state when omitted without overwriting a concurrent change")
    if "WHERE id = ? AND device_id = ?" not in super_links or "EXISTS (SELECT 1 FROM app_entitlements WHERE id = ? AND device_id = ?)" not in super_links:
        raise AssertionError("APP entitlement rebind must use an optimistic old-device predicate")
    if "app_link.super_delete" not in super_links or "app_entitlement.rebind" not in super_links:
        raise AssertionError("Super APP link and entitlement mutations must write audit records")

    app_cards = source.split("async function userAppCardsRoute", 1)[1].split("/* ────────────────────────────── 节点生命周期", 1)[0]
    if app_cards.count("assertStmt(db,") < 2 or "APP_CARD_CAPACITY_CHANGED" not in app_cards:
        raise AssertionError("APP card total/stock capacity must be asserted inside the redemption batch")

    add_download = source.split("async function addDownload", 1)[1].split("async function downloadRoute", 1)[0]
    if ".run()" in add_download or "assertStmt(db, quotaSql, quotaBinds)" not in add_download or "DOWNLOAD_LIMIT_CHANGED" not in add_download:
        raise AssertionError("Download-link quota must be rechecked in the same batch as insert and audit")
    super_downloads = source.split("async function superDownloadsRoute", 1)[1].split("async function userDownloadsRoute", 1)[0]
    user_downloads = source.split("async function userDownloadsRoute", 1)[1].split("/* ────────────────────────────── 统计与导出", 1)[0]
    if ".run()" in super_downloads or "await db.batch([" not in super_downloads or "download_link.super_delete" not in super_downloads:
        raise AssertionError("Super download-link deletion must be atomic and audited")
    if ".run()" in user_downloads or "WHERE id = ? AND admin_user_id = ?" not in user_downloads or "download_link.delete" not in user_downloads:
        raise AssertionError("User download-link deletion must retain owner predicate and audit batch")

    node_owner_guard = source.split("function nodeOwnerAssertStmt", 1)[1].split("function overrideMap", 1)[0]
    if "FROM user_manual_nodes WHERE id = ? AND user_id = ?" not in node_owner_guard or "JOIN source_ownership so ON so.source_id = n.source_id" not in node_owner_guard:
        raise AssertionError("Node owner guard must cover manual and subscription node ownership")
    overrides = source.split("async function userOverridesRoute", 1)[1].split("function validateOverrideValue", 1)[0]
    metadata = source.split("async function userMetadataRoute", 1)[1].split("/* ────────────────────────────── 总管理员", 1)[0]
    groups = source.split("async function userGroupsRoute", 1)[1].split("async function userMetadataRoute", 1)[0]
    if overrides.count("nodeOwnerAssertStmt(db, ctx, nodeId, \"subscription\")") < 2:
        raise AssertionError("Node override set/remove must recheck source ownership inside the batch")
    if "nodeOwnerAssertStmt(db, ctx, nodeId, found.kind)" not in metadata:
        raise AssertionError("Node metadata must recheck manual/subscription ownership inside the batch")
    user_nodes = source.split("async function userNodesRoute", 1)[1].split("function pickNode", 1)[0]
    if "nodeOwnerAssertStmt(db, ctx, id, \"subscription\")" not in user_nodes or "nodeOwnerAssertStmt(db, ctx, id, \"manual\")" not in user_nodes:
        raise AssertionError("Node enabled toggles must recheck subscription/manual node ownership inside the batch")
    if "nodeOwnerAssertStmt(db, ctx, nodeId, kind)" not in groups or "GROUP_MEMBER_STATE_CHANGED" not in groups:
        raise AssertionError("Node-group member add must recheck both group and node ownership inside the batch")

    super_releases = source.split("async function superReleasesRoute", 1)[1].split("/* ────────────────────────────── APP 下载链接", 1)[0]
    if ".run()" in super_releases:
        raise AssertionError("Super release and announcement mutations must not bypass atomic batches")
    if super_releases.count("await db.batch([") < 5 or super_releases.count("auditStmt(db, ctx") < 5:
        raise AssertionError("Super release/announcement create, toggle and delete paths must be batched and audited")

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

    app_cards_route = source.split("async function userAppCardsRoute", 1)[1].split("/* ────────────────────────────── 节点生命周期", 1)[0]
    if ".run()" in app_cards_route:
        raise AssertionError("User APP card writes must use scope-guarded batches")
    if "CARD_STATE_CHANGED" not in app_cards_route or "activated_at IS NULL AND used_at IS NULL AND status <> 'used'" not in app_cards_route:
        raise AssertionError("APP card soft-delete must recheck unused state in the same batch")
    redeem = source.split("async function appRedeemRoute", 1)[1].split("async function runEntitlementMaintenance", 1)[0]
    redeem_batch = redeem.split("await userBatch(db, ctx, [", 1)[1].split("]);", 1)[0]
    for statement in ("UPDATE app_cards SET status='used'", "INSERT INTO app_entitlements", "INSERT OR IGNORE INTO app_free_grants", "INSERT INTO app_card_events"):
        if statement not in redeem_batch:
            raise AssertionError("APP redemption must atomically commit card, entitlement, free grant and activation event: " + statement)
    if "datetime(expires_at) > datetime('now')" not in redeem_batch or "manual_disabled=0" not in redeem_batch:
        raise AssertionError("APP redemption batch must recheck card expiry and manual-disable state")
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
