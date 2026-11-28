import { authorizeAppManagementRequest } from "./worker-auth-adapter.mjs";

/* V2.5-DEV-B1-CORE-AUTH-49: owner-predicate hardened authorization revision; source base retained unchanged. */
/**
 * StarJump V2.5.0 RC1 Candidate Worker
 * 星跃管理平台 —— 上线候选后端（多用户隔离 / 字段覆盖 / 分组 / 审计 / 同步 staging+fencing）
 *
 * 基线：V0.4.0-compat-test2（保留其解析器行为、SSRF 纵深防御、旧接口形状）
 * 部署绑定：
 *   D1 binding : DB  -> 用户当前已配置的正式 D1；部署时保持现有绑定，不要改绑 starjump-db 或 staging
 *   Secret     : ADMIN_TOKEN      (>=32 字符；仅作为旧后台 /api/admin/* 与 bootstrap 的超级凭据)
 *   Secret     : SESSION_PEPPER   (本候选要求 >=32 字符；必须保留现有原值，不能直接轮换)
 *   Secret     : APP_HMAC_SECRET  (可选；若已配置，首次兼容部署前须确认与当前 SESSION_PEPPER 一致)
 *   Variable   : ADMIN_ORIGIN     (后台页面 Origin，可用逗号分隔多个)
 *   Variable   : ALLOW_REGISTRATION ("1" 才允许自助注册，默认关闭)
 *   Variable   : SESSION_TTL_HOURS  (默认 720 = 30 天)
 *   Variable   : IMPERSONATION_TTL_MINUTES (默认 30)
 *
 * 设计约束（对应任务书第三、八、九节）：
 *   - 不改任何旧表结构；旧表数据不动；不改历史 fingerprint。
 *   - 用户覆盖只写 node_overrides，绝不回写 node_records。
 *   - 手动节点只写 user_manual_nodes，不属于机场同步范围。
 *   - 所有用户态数据访问都从服务端 Session 推导 user_id，绝不信任请求体。
 *   - 审计与业务写尽量同 batch；审计表由触发器保证 append-only。
 *
 * 未在真实 D1 上验证的事项集中列在 Compatibility_Report 的「未验证」章节。
 */

const VERSION = "2.5.0-rc1";
const CANON_VERSION = "v1.0-1";

const MAX_BODY = 32 * 1024;
const MAX_SUB_BYTES = 1024 * 1024;
const MAX_NODES_PER_SOURCE = 500;
const MAX_SYNC_SOURCES = 12;
const FETCH_TIMEOUT_MS = 10000;
const MAX_LOG_ERROR = 500;
const MAX_COMMIT_NODES = 50;           // 单个提交 batch 的节点数上限（每条节点 2 条语句）
const LEASE_MS = 30 * 60 * 1000;
// Cloudflare Workers 的 WebCrypto PBKDF2 上限是 100,000 次（超过会抛 NotSupportedError），
// 因此这里使用平台允许的最大值。牺牲部分强度以换取可运行；详见 README 安全说明。
const PBKDF2_ITERATIONS = 100000;
const PBKDF2_MAX_SUPPORTED = 100000;   // 平台硬上限；高于此值的旧哈希无法在本运行时校验
const PBKDF2_MIN_ITERATIONS = 100000;

const ALLOWED_OVERRIDE_FIELDS = new Set(["name", "protocol", "server", "port", "tier", "enabled"]);
const ALLOWED_SCOPES = new Set(["read", "operate", "manage"]);
const ALLOWED_PROTOCOLS = new Set(["vless", "vmess", "trojan", "ss"]);
const SORTABLE_COLUMNS = new Set(["name", "created_at", "updated_at", "port", "tier"]);

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

/* ────────────────────────────── 基础工具 ────────────────────────────── */

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { ...JSON_HEADERS, ...headers } });
}
function fail(message, status = 400, extra = {}, headers = {}) {
  return json({ ok: false, error: message, ...extra }, status, headers);
}
function s(v, max = 500) {
  return String(v ?? "").trim().slice(0, max);
}
function num(v, def = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}
function validId(v) {
  return /^[A-Za-z0-9_-]{1,80}$/.test(String(v || ""));
}
function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** 只接受 true/false/1/0/"1"/"0"，其余返回 null（调用方必须 400）。 */
function parseBool01(v) {
  if (v === true || v === 1 || v === "1") return 1;
  if (v === false || v === 0 || v === "0") return 0;
  return null;
}
/** 严格整数参数：缺省返回 def；格式/范围错误返回 { error }。 */
function intParam(raw, { min, max, def, name = "参数" }) {
  if (raw === undefined || raw === null || raw === "") return { value: def };
  const str = String(raw).trim();
  if (!/^-?\d{1,9}$/.test(str)) return { error: `${name}必须是整数` };
  const n = Number(str);
  if (!Number.isInteger(n) || n < min || n > max) return { error: `${name}必须在 ${min}-${max} 之间` };
  return { value: n };
}
/** limit/offset 严格校验（limit 1-500，offset 0-1000000）。 */
function parsePaging(params) {
  const get = (k) => (params && typeof params.get === "function" ? params.get(k) : params?.[k]);
  const limit = intParam(get("limit"), { min: 1, max: 500, def: 50, name: "limit" });
  if (limit.error) return limit;
  const offset = intParam(get("offset"), { min: 0, max: 1_000_000, def: 0, name: "offset" });
  if (offset.error) return offset;
  return { limit: limit.value, offset: offset.value };
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
}
function timingSafeEqual(a, b) {
  const aa = String(a ?? ""), bb = String(b ?? "");
  let diff = aa.length ^ bb.length;
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (aa.charCodeAt(i) || 0) ^ (bb.charCodeAt(i) || 0);
  return diff === 0;
}
function newId() {
  return crypto.randomUUID().replace(/-/g, "");
}
function requestId(req) {
  const given = s(req.headers.get("x-request-id"), 80);
  return validId(given) ? given : newId();
}
function allowedOrigins(env) {
  return String(env.ADMIN_ORIGIN || "").split(",").map(x => x.trim()).filter(Boolean);
}
function corsHeaders(req, env) {
  const origin = req.headers.get("Origin");
  const list = allowedOrigins(env);
  const h = { vary: "Origin" };
  if (origin && list.includes(origin)) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-methods"] = "GET,POST,PUT,PATCH,DELETE,OPTIONS";
    h["access-control-allow-headers"] = "Content-Type,Authorization,X-Request-Id,X-Effective-User";
    h["access-control-max-age"] = "86400";
  }
  return h;
}
function originAllowed(req, env) {
  const origin = req.headers.get("Origin");
  if (!origin) return true;             // 非浏览器客户端（curl/Worker）不带 Origin
  return allowedOrigins(env).includes(origin);
}

/* ────────────────────────────── 密码与令牌 ────────────────────────────── */

function b64(bytes) {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}
function unb64(str) {
  const bin = atob(str);
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

/** 格式：pbkdf2$sha256$<iterations>$<saltB64>$<hashB64>；不含明文，不用裸 SHA-256。 */
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$sha256$${PBKDF2_ITERATIONS}$${b64(salt)}$${b64(hash)}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 5 || parts[0] !== "pbkdf2" || parts[1] !== "sha256") return false;
  const iterations = Number(parts[2]);
  if (!Number.isInteger(iterations) || iterations < PBKDF2_MIN_ITERATIONS) return false;
  if (iterations > PBKDF2_MAX_SUPPORTED) {
    // 平台不支持这么高的迭代数（例如历史数据用 310000 生成的），无法校验，按失败处理但留下痕迹
    try { console.warn(`[auth] stored hash uses ${iterations} iterations, above platform max ${PBKDF2_MAX_SUPPORTED}`); } catch {}
    return false;
  }
  let salt, expected;
  try {
    salt = unb64(parts[3]);
    expected = unb64(parts[4]);
  } catch {
    return false;
  }
  const actual = await pbkdf2(password, salt, iterations);
  return timingSafeEqual(b64(actual), b64(expected));
}

/** 32 字节随机 session token（base64url），数据库只存哈希。 */
function newSessionToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function sessionError(code, message) { const error = new Error(message); error.code = code; return error; }
function requiredSecret(env, name, minLength = 32) {
  const value = String(env?.[name] || "");
  if (value.length < minLength) throw sessionError("SECRET_NOT_CONFIGURED", `Worker Secret 未配置或长度不足：${name}`);
  return value;
}
async function sessionTokenHash(token, env) {
  return sha256Hex(`${requiredSecret(env, "SESSION_PEPPER", 32)}|${token}`);
}

/* ────────────────────────────── 身份与鉴权 ────────────────────────────── */

const SCOPE_RANK = { read: 1, operate: 2, manage: 3 };

function scopeSatisfies(granted, needed) {
  return (SCOPE_RANK[granted] || 0) >= (SCOPE_RANK[needed] || 99);
}

/**
 * 从请求解析身份。返回 null 表示匿名。
 * 结果 ctx：
 *   actorId     真实身份（写审计的 actor_user_id）
 *   effectiveId 生效身份（普通用户 = actor；总管理员协助 = 目标用户）
 *   isSuper     是否为超级管理员（role=super_admin 或持有 ADMIN_TOKEN）
 *   session     会话行（ADMIN_TOKEN 时为 null）
 */
async function resolveSession(req, env) {
  const header = req.headers.get("Authorization") || "";
  if (!header) return null;
  if (!/^Bearer\s+/i.test(header)) throw sessionError("INVALID_SESSION", "Authorization 格式无效");
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw sessionError("INVALID_SESSION", "Bearer Token 为空");

  // 旧后台凭据：ADMIN_TOKEN 直通（只用于 /api/admin/* 与 bootstrap，不产生用户态数据访问）
  const adminToken = String(env.ADMIN_TOKEN || "");
  if (adminToken.length >= 32 && timingSafeEqual(token, adminToken)) {
    return { actorId: "legacy-admin", effectiveId: "legacy-admin", isSuper: true, session: null, legacy: true };
  }

  const tokenHash = await sessionTokenHash(token, env);
  const row = await env.DB.prepare(
    `SELECT s.id, s.user_id, s.acting_as_user_id, s.scope_id, s.expires_at, s.revoked_at,
            u.id AS u_id, u.username, u.role, u.status, u.display_name
       FROM user_sessions s
       LEFT JOIN app_users u ON u.id = s.user_id
      WHERE s.token_hash = ?`,
  ).bind(tokenHash).first();

  if (!row) throw sessionError("INVALID_SESSION", "会话无效、已撤销或已过期");
  if (row.revoked_at) throw sessionError("INVALID_SESSION", "会话无效、已撤销或已过期");
  if (!row.u_id) throw sessionError("INVALID_SESSION", "会话无效、已撤销或已过期");
  if (row.status !== "active") throw sessionError("INVALID_SESSION", "会话无效、已撤销或已过期");

  // 过期判断交给 SQLite，避免 Worker 与本机时钟漂移
  const alive = await env.DB.prepare("SELECT 1 AS ok WHERE datetime(?) > datetime('now')")
    .bind(row.expires_at).first();
  if (!alive) throw sessionError("INVALID_SESSION", "会话无效、已撤销或已过期");

  const isSuper = row.role === "super_admin";
  let effectiveId = row.user_id;
  let scope = null;   // 协助会话的授权等级：read < operate < manage
  if (row.acting_as_user_id) {
    if (!isSuper) throw sessionError("INVALID_SESSION", "会话无效、已撤销或已过期"); // 只有超管可协助
    if (!row.scope_id) throw sessionError("INVALID_SESSION", "会话无效、已撤销或已过期");
    const grant = await env.DB.prepare(
      `SELECT scope FROM admin_user_scopes
        WHERE id = ? AND admin_user_id = ? AND target_user_id = ?
          AND revoked_at IS NULL
          AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
    ).bind(row.scope_id, row.user_id, row.acting_as_user_id).first();
    if (!grant) throw sessionError("INVALID_SESSION", "会话无效、已撤销或已过期");
    effectiveId = row.acting_as_user_id;
    scope = grant.scope;
  }

  // 低频更新 last_seen_at，避免每次请求都写库
  await env.DB.prepare(
    "UPDATE user_sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE id = ? AND (last_seen_at IS NULL OR datetime(last_seen_at) < datetime('now','-10 minutes'))",
  ).bind(row.id).run().catch(() => {});

  return {
    actorId: row.user_id,
    effectiveId,
    scope,
    isSuper,
    session: {
      id: row.id, userId: row.user_id, actingAs: row.acting_as_user_id || null,
      scopeId: row.scope_id || null, username: row.username, role: row.role,
    },
    legacy: false,
  };
}

/**
 * 协助会话的操作范围检查。
 * - 本人操作（actor === effective）不受 scope 限制；
 * - 协助他人时：read 只读，operate 可写非删除，manage 可删除/归档。
 */
function requireScope(ctx, need) {
  if (!ctx) return fail("未登录", 401);
  if (ctx.actorId === ctx.effectiveId) return null;
  if (!ctx.isSuper) return fail("需要权限", 403);
  const have = ctx.scope || null;
  if (!have) return fail("协助会话缺少有效授权", 403);
  if (!scopeSatisfies(have, need)) {
    return fail(`协助权限不足：当前 ${have}，此操作需要 ${need}`, 403, { code: "SCOPE_INSUFFICIENT" });
  }
  return null;
}

/**
 * 写入批次里的“授权仍然有效”断言：协助期间授权被撤销/过期会让整批回滚，
 * 消除“检查通过之后再被撤销”的竞态。
 */
function scopeGuardStmt(db, ctx) {
  if (!ctx || ctx.actorId === ctx.effectiveId || !ctx.session?.scopeId) return null;
  return db.prepare(
    `SELECT CASE WHEN EXISTS (
        SELECT 1 FROM admin_user_scopes
         WHERE id = ? AND admin_user_id = ? AND target_user_id = ?
           AND revoked_at IS NULL
           AND (expires_at IS NULL OR datetime(expires_at) > datetime('now')))
      THEN 1 ELSE json_extract('scope-revoked', '$') END`,
  ).bind(ctx.session.scopeId, ctx.actorId, ctx.effectiveId);
}
/** 用户态写操作的统一入口：业务语句 + 授权断言同批提交。 */
async function userBatch(db, ctx, stmts) {
  const guard = scopeGuardStmt(db, ctx);
  return db.batch(guard ? [...stmts, guard] : stmts);
}

async function hasScopeGrant(db, adminId, targetUserId, need) {
  if (adminId === targetUserId) return true;
  for (const scope of ["manage", "operate", "read"]) {
    if (!scopeSatisfies(scope, need)) continue;
    const hit = await db.prepare(
      `SELECT 1 AS ok FROM admin_user_scopes
        WHERE admin_user_id = ? AND target_user_id = ? AND scope = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
    ).bind(adminId, targetUserId, scope).first();
    if (hit) return true;
  }
  return false;
}

/* ────────────────────────────── 审计 ────────────────────────────── */

function jsonText(value) {
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value).slice(0, 4000);
  } catch {
    return "";
  }
}

/** 生成一条审计 INSERT 语句，供调用方放进同一个 D1 batch。 */
function auditStmt(db, ctx, { action, targetType = "", targetId = "", before = null, after = null, result = "ok", reason = "", detail = "" }) {
  return db.prepare(
    `INSERT INTO admin_audit_events
       (actor_user_id, effective_user_id, action, target_type, target_id, request_id, before_json, after_json, result, reason, detail)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).bind(
    ctx.actorId || null,
    ctx.effectiveId || null,
    s(action, 100),
    s(targetType, 40),
    s(targetId, 120),
    s(ctx.requestId || "", 80),
    jsonText(before),
    jsonText(after),
    s(result, 20) || "ok",
    s(reason, 500),
    s(detail, 1000),
  );
}

/** 拒绝类事件：失败不阻断主流程（不能因为写不进审计就把 403 变成 500）。 */
async function auditDenied(db, ctx, action, reason, targetType = "", targetId = "") {
  try {
    await auditStmt(db, { ...ctx, requestId: ctx.requestId }, { action, targetType, targetId, result: "denied", reason }).run();
  } catch (e) {
    // 审计写入失败不改变拒绝结果，但要留下可追踪的痕迹（不含任何敏感值）
    try { console.error(`[audit] denied-event write failed request=${ctx?.requestId || "-"} action=${action}`); } catch { /* ignore */ }
  }
}

/* ────────────────────────────── 认证路由 ────────────────────────────── */

const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{2,31}$/;

async function routeAuth(req, env, url, ctx) {
  const db = env.DB;
  const method = req.method;
  const path = url.pathname;

  if (path === "/api/auth/register" && method === "POST") {
    if (String(env.ALLOW_REGISTRATION || "") !== "1") {
      return fail("未开放自助注册，请联系管理员开通账号", 403);
    }
    const body = await readJson(req);
    const username = s(body.username, 32).toLowerCase();
    const password = String(body.password ?? "");
    if (!USERNAME_RE.test(username)) return fail("用户名需为 3-32 位小写字母/数字/_.-，且以字母或数字开头", 400);
    if (password.length < 10 || password.length > 200) return fail("密码长度需为 10-200 位", 400);

    const exists = await db.prepare("SELECT id FROM app_users WHERE username = ?").bind(username).first();
    if (exists) return fail("用户名不可用", 409);

    const id = newId();
    const hash = await hashPassword(password);
    await db.batch([
      db.prepare("INSERT INTO app_users(id, username, display_name, password_hash, role, status) VALUES(?,?,?,?,?,?)")
        .bind(id, username, s(body.display_name, 60), hash, "user", "active"),
      auditStmt(db, { actorId: id, effectiveId: id, requestId: ctx.requestId }, {
        action: "auth.register", targetType: "user", targetId: id, after: { username },
      }),
    ]);
    await grantTrial(db, id).catch(() => {});
    return json({ ok: true, data: { id, username, role: "user", trial_days: VIP_TRIAL_DAYS } }, 201);
  }

  if (path === "/api/auth/bootstrap" && method === "POST") {
    // 仅当库里没有任何用户时可用；必须携带 ADMIN_TOKEN（由外层 legacy 校验）
    if (!ctx || !ctx.isSuper || !ctx.legacy) return fail("需要 ADMIN_TOKEN", 401);
    // 分阶段记录进度：出错时能精确指出停在 import/validate/hash/insert/audit 哪一步
    let stage = "init";
    try {
      stage = "read_body";
      const body = await readJson(req);
      stage = "validate";
      const username = s(body.username, 32).toLowerCase() || "admin";
      const password = String(body.password ?? "");
      if (!USERNAME_RE.test(username)) return fail("用户名格式不正确", 400);
      if (password.length < 12) return fail("超级管理员密码至少 12 位", 400);
      const id = newId();
      stage = "hash_password";
      const hash = await hashPassword(password);
      stage = "insert_user";
      // 单条 INSERT ... SELECT ... WHERE NOT EXISTS 是原子判定：并发 bootstrap 只会有一个人成功。
      const ins = await db.prepare(
        `INSERT INTO app_users(id, username, display_name, password_hash, role, status)
         SELECT ?,?,?,?, 'super_admin', 'active'
          WHERE NOT EXISTS (SELECT 1 FROM app_users)`,
      ).bind(id, username, s(body.display_name, 60) || "总管理员", hash).run();
      if (!ins.meta?.changes) return fail("已存在用户，bootstrap 已关闭", 409);
      stage = "write_audit";
      await db.batch([
        auditStmt(db, { actorId: "legacy-admin", effectiveId: id, requestId: ctx.requestId }, {
          action: "auth.bootstrap", targetType: "user", targetId: id,
          after: { username, role: "super_admin" },
          detail: "通过 ADMIN_TOKEN 完成一次性初始化",
        }),
      ]);
      return json({ ok: true, data: { id, username, role: "super_admin" } }, 201);
    } catch (e) {
      // 仅当 staging 显式设置 DIAGNOSTICS=1 时才把内部错误回给客户端；不泄露任何凭据
      if (String(env.DIAGNOSTICS || "") === "1") {
        return json({
          ok: false,
          error: `初始化失败（诊断模式，停在第 ${stage} 步）`,
          stage,
          code: String(e?.name || "Error"),
          detail: String(e?.message || e || "").slice(0, 300),
        }, 500);
      }
      throw e;
    }
  }

  if (path === "/api/auth/login" && method === "POST") {
    const body = await readJson(req);
    const username = s(body.username, 32).toLowerCase();
    const password = String(body.password ?? "");
    if (!USERNAME_RE.test(username) || !password) {
      // 与“密码错误”同文案，降低枚举价值
      return fail("用户名或密码不正确", 401);
    }
    const row = await db.prepare(
      "SELECT id, username, password_hash, role, status, failed_login_count, locked_until FROM app_users WHERE username = ?",
    ).bind(username).first();

    const generic = fail("用户名或密码不正确", 401);

    if (!row) {
      await pbkdf2(password, new Uint8Array(16), PBKDF2_MIN_ITERATIONS).catch(() => {});  // 等时
      return generic;
    }
    if (row.locked_until) {
      const locked = await db.prepare("SELECT 1 AS ok WHERE datetime(?) > datetime('now')").bind(row.locked_until).first();
      if (locked) return fail("账号暂时锁定，请稍后再试", 423);
    }
    if (row.status !== "active") return fail("账号已停用", 403);

    const okPassword = await verifyPassword(password, row.password_hash);
    if (!okPassword) {
      const failed = Number(row.failed_login_count || 0) + 1;
      if (failed >= 5) {
        await db.prepare("UPDATE app_users SET failed_login_count = 0, locked_until = datetime('now','+15 minutes'), updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(row.id).run();
      } else {
        await db.prepare("UPDATE app_users SET failed_login_count = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(failed, row.id).run();
      }
      await auditDenied(db, { actorId: row.id, effectiveId: row.id, requestId: ctx.requestId }, "auth.login.failed", "密码错误", "user", row.id);
      return generic;
    }

    const token = newSessionToken();
    const tokenHash = await sessionTokenHash(token, env);
    const ttlHours = Math.min(24 * 365, Math.max(1, num(env.SESSION_TTL_HOURS, 720)));
    const sessionId = newId();
    await db.batch([
      db.prepare(
        "INSERT INTO user_sessions(id, user_id, token_hash, expires_at, user_agent) VALUES(?,?,?,datetime('now', ?),?)",
      ).bind(sessionId, row.id, tokenHash, `+${ttlHours} hours`, s(req.headers.get("user-agent"), 200)),
      db.prepare("UPDATE app_users SET failed_login_count = 0, locked_until = NULL, last_login_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .bind(row.id),
      auditStmt(db, { actorId: row.id, effectiveId: row.id, requestId: ctx.requestId }, {
        action: "auth.login", targetType: "session", targetId: sessionId,
      }),
    ]);
    return json({
      ok: true,
      data: { token, expires_in_hours: ttlHours, user: { id: row.id, username: row.username, role: row.role } },
    });
  }

  if (path === "/api/auth/me" && method === "GET") {
    if (!ctx || ctx.legacy) return fail("未登录", 401);
    const user = await db.prepare("SELECT id, username, display_name, role, status, created_at, last_login_at FROM app_users WHERE id = ?")
      .bind(ctx.actorId).first();
    return json({
      ok: true,
      data: {
        user,
        vip: await vipStatus(db, ctx.actorId),
        effective_user_id: ctx.effectiveId,
        impersonating: ctx.actorId !== ctx.effectiveId,
        session_id: ctx.session?.id || null,
      },
    });
  }

  if (path === "/api/auth/password" && method === "PUT") {
    if (!ctx || ctx.legacy) return fail("未登录", 401);
    const body = await readJson(req);
    const current = String(body.current_password ?? "");
    const next = String(body.new_password ?? "");
    if (next.length < 10 || next.length > 200) return fail("新密码长度需为 10-200 位", 400);
    if (next === current) return fail("新密码不能与当前密码相同", 400);
    const me = await db.prepare("SELECT id, password_hash FROM app_users WHERE id = ?").bind(ctx.actorId).first();
    if (!me) return fail("用户不存在", 404);
    if (!(await verifyPassword(current, me.password_hash))) {
      await auditDenied(db, ctx, "auth.password.change", "当前密码错误", "user", ctx.actorId);
      return fail("当前密码不正确", 403);
    }
    const hash = await hashPassword(next);
    await db.batch([
      db.prepare("UPDATE app_users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(hash, ctx.actorId),
      // 保留当前会话，撤销其他会话，避免旧 token 继续可用
      db.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND id <> ? AND revoked_at IS NULL")
        .bind(ctx.actorId, ctx.session?.id || ""),
      auditStmt(db, ctx, { action: "auth.password.change", targetType: "user", targetId: ctx.actorId, detail: "用户自助修改密码，其他会话已撤销" }),
    ]);
    return json({ ok: true, data: { changed: true, other_sessions_revoked: true } });
  }

  if ((path === "/api/auth/logout" || path === "/api/auth/revoke-session") && method === "POST") {
    if (!ctx || ctx.legacy) return fail("未登录", 401);
    const body = path === "/api/auth/revoke-session" ? await readJson(req) : {};
    const target = s(body.session_id, 80);
    if (target) {
      const row = await db.prepare("SELECT id, user_id FROM user_sessions WHERE id = ?").bind(target).first();
      if (!row) return fail("会话不存在", 404);
      // 只能撤销自己名下的会话；超管可撤销任意会话
      if (row.user_id !== ctx.actorId && !ctx.isSuper) {
        await auditDenied(db, ctx, "auth.session.revoke", "非本人会话", "session", target);
        return fail("无权撤销该会话", 403);
      }
      await db.batch([
        db.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL").bind(target),
        auditStmt(db, ctx, { action: "auth.session.revoke", targetType: "session", targetId: target, reason: s(body.reason, 200) }),
      ]);
      return json({ ok: true });
    }
    await db.batch([
      db.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").bind(ctx.session.id),
      auditStmt(db, ctx, { action: "auth.logout", targetType: "session", targetId: ctx.session.id }),
    ]);
    return json({ ok: true });
  }

  return fail("接口不存在", 404);
}

/* ────────────────────────────── 请求体与 URL 校验 ────────────────────────────── */

async function readJson(req, { allowEmpty = false } = {}) {
  const ct = req.headers.get("content-type") || "";
  if (ct && !/^application\/json(?:\s*;|$)/i.test(ct)) throw new Error("请求必须使用 application/json");
  const declared = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_BODY) throw new Error("请求体超过 32 KiB 限制");

  // 边读边计数：不依赖 Content-Length（可能缺失或被伪造），超限立刻取消并拒绝
  let raw = "";
  if (req.body) {
    const reader = req.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BODY) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw new Error("请求体超过 32 KiB 限制");
        }
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
    try {
      raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(all);
    } catch {
      throw new Error("请求体不是合法的 UTF-8");
    }
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY) throw new Error("请求体超过 32 KiB 限制");
  }
  if (!raw.trim()) {
    if (allowEmpty) return {};
    throw new Error("请求体不能为空");
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("JSON 格式无效");
  }
  if (!isPlainObject(value)) throw new Error("JSON 内容必须是对象");
  return value;
}

function decodeMaybeBase64(text) {
  const t = String(text || "").trim();
  if (!t) return "";
  if (/^(vless|vmess|trojan|ss):\/\//im.test(t)) return t;
  try {
    const clean = t.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(clean);
    const decoded = new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
    if (/(vless|vmess|trojan|ss):\/\//i.test(decoded)) return decoded;
  } catch { /* 不是 base64，按原文处理 */ }
  return t;
}

function isPrivateIPv4(host) {
  const p = host.split(".").map(Number);
  if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19));
}
function isBlockedHost(host) {
  const h = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") ||
      h.endsWith(".internal") || h.endsWith(".test") || h.endsWith(".invalid")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(h)) return true;   // 一律拒绝 IPv4 字面量
  if (h.includes(":")) {
    if (h === "::" || h === "::1" || /^f[cd]/i.test(h) || /^fe[89ab]/i.test(h) ||
        /^ff/i.test(h) || /^::ffff:/i.test(h)) return true;
    return true;                                                              // 其余 IPv6 字面量同样拒绝
  }
  return false;
}
function validateSubscriptionUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) throw new Error("订阅地址长度不合法");
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("订阅地址不是有效 URL");
  }
  if (u.protocol !== "https:") throw new Error("仅允许 HTTPS 订阅地址");
  if (u.username || u.password) throw new Error("订阅地址不能包含用户名或密码");
  if (u.port && u.port !== "443") throw new Error("订阅地址仅允许 HTTPS 默认端口 443");
  if (u.hash) throw new Error("订阅地址不能包含片段(#)");
  const host = u.hostname.toLowerCase();
  if (!host || host.length > 253) throw new Error("订阅地址主机名不合法");
  if (host.includes("%") || host.includes("\\")) throw new Error("订阅地址主机名不合法");
  if (isBlockedHost(host)) throw new Error("订阅地址主机属于本地、保留地址或 IP 字面量");
  const labels = host.split(".");
  // 纯数字标签（2130706433 / 0177.0.0.1 这类变形）一律拒绝
  if (labels.every(l => /^[0-9]+$/.test(l))) throw new Error("订阅地址不能使用 IP 形式");
  if (labels.length < 2) throw new Error("订阅地址必须是完整域名");
  if (labels.some(l => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(l))) throw new Error("订阅地址主机名不合法");
  const tld = labels[labels.length - 1];
  if (!/^[a-z]{2,24}$/i.test(tld)) throw new Error("订阅地址必须包含有效顶级域名");
  return u;
}

/** 解析 subscription-userinfo / profile-title 等机场常见响应头。解析失败一律忽略，绝不影响节点同步。 */
function parseQuotaHeaders(headers) {
  const out = {};
  try {
    const raw = headers.get("subscription-userinfo") || "";
    for (const part of String(raw).split(";")) {
      const m = part.trim().match(/^([a-z_]+)\s*=\s*(-?\d+)$/i);
      if (!m) continue;
      const v = Number(m[2]);
      if (!Number.isSafeInteger(v) || v < 0) continue;
      out[m[1].toLowerCase()] = v;
    }
    // expire 有两种常见单位：Unix 秒（10 位）与毫秒（13 位）
    if (Number.isFinite(out.expire) && out.expire > 1e11) out.expire = Math.floor(out.expire / 1000);
    let title = s(headers.get("profile-title"), 200);
    if (/^base64:/i.test(title)) {
      try { title = s(b64urlDecode(title.slice(7)), 200); } catch { title = ""; }
    }
    if (title) out.title = title;
  } catch { /* 头解析失败就当没有额度信息 */ }
  return out;
}

async function fetchSubscription(url) {
  const u = validateSubscriptionUrl(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(u.toString(), {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: {
        accept: "text/plain, application/octet-stream, */*",
        "user-agent": "StarJump-Subscription-Sync/1.0",
      },
    });
    if (res.status >= 300 && res.status < 400) throw new Error("订阅服务器重定向被拒绝");
    if (!res.ok) throw new Error(`订阅请求失败，HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_SUB_BYTES) throw new Error("订阅内容超过 1 MiB 限制");
    if (!res.body) throw new Error("订阅响应为空");
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_SUB_BYTES) throw new Error("订阅内容超过 1 MiB 限制");
        chunks.push(value);
      }
    } finally {
      try { reader.releaseLock(); } catch {}
    }
    const all = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) { all.set(c, offset); offset += c.byteLength; }
    return { text: new TextDecoder("utf-8", { fatal: false }).decode(all), quota: parseQuotaHeaders(res.headers) };
  } catch (e) {
    if (e?.name === "AbortError") throw new Error("订阅请求超时（10 秒）");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ────────────────────────────── 节点解析与身份键 ────────────────────────────── */

function safeDecode(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}
function b64urlDecode(input) {
  const clean = String(input || "").replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = clean.length % 4 ? "=".repeat(4 - (clean.length % 4)) : "";
  const bin = atob(clean + pad);
  return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function parseVmess(uri) {
  const raw = uri.slice("vmess://".length).split("#")[0];
  const o = JSON.parse(b64urlDecode(raw));
  const server = s(o.add, 253);
  const port = Number(o.port);
  const uuid = s(o.id, 64);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("VMess 地址或端口无效");
  return {
    protocol: "vmess", server, port,
    name: s(safeDecode(uri.split("#")[1] || o.ps || "VMess"), 160) || "VMess",
    identityMaterial: `vmess:${server.toLowerCase()}:${port}:${uuid}`,
  };
}
function parseSs(uri) {
  const hashAt = uri.indexOf("#");
  const name = hashAt >= 0 ? s(safeDecode(uri.slice(hashAt + 1)), 160) : "";
  let raw = (hashAt >= 0 ? uri.slice(5, hashAt) : uri.slice(5)).split("?")[0];
  let credential = "";
  let hostpart = "";
  if (raw.includes("@")) {
    const at = raw.lastIndexOf("@");
    const auth = raw.slice(0, at);
    hostpart = raw.slice(at + 1);
    credential = safeDecode(auth);
    if (!credential.includes(":")) {
      try { credential = b64urlDecode(auth); } catch { /* 保持原值 */ }
    }
  } else {
    const decoded = b64urlDecode(raw);
    if (!decoded.includes("@")) throw new Error("Shadowsocks URI 格式不支持");
    const at = decoded.lastIndexOf("@");
    credential = decoded.slice(0, at);
    hostpart = decoded.slice(at + 1);
  }
  const hp = new URL("http://" + hostpart);
  const server = hp.hostname.replace(/^\[|\]$/g, "");
  const port = Number(hp.port || 0);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Shadowsocks 地址或端口无效");
  const [method, ...rest] = credential.split(":");
  const password = rest.join(":");
  return {
    protocol: "ss", server, port,
    name: name || "Shadowsocks",
    identityMaterial: `ss:${server.toLowerCase()}:${port}:${s(method, 40)}:${s(password, 200)}`,
  };
}
function parseNodeUri(uri) {
  const head = String(uri).slice(0, 8).toLowerCase();
  if (head.startsWith("vmess://")) return parseVmess(uri);
  if (head.startsWith("ss://")) return parseSs(uri);
  const u = new URL(uri);
  const protocol = u.protocol.replace(":", "").toLowerCase();
  if (!["vless", "trojan"].includes(protocol)) throw new Error(`不支持的协议：${protocol}`);
  const server = u.hostname.replace(/^\[|\]$/g, "");
  const port = Number(u.port || 443);
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("节点地址或端口无效");
  const name = s(safeDecode(u.hash.replace(/^#/, "")), 160) || protocol.toUpperCase();
  const secret = safeDecode(u.username || "");
  return {
    protocol, server, port, name,
    identityMaterial: protocol === "vless"
      ? `vless:${server.toLowerCase()}:${port}:${s(secret, 100)}`
      : `trojan:${server.toLowerCase()}:${port}:${s(secret, 200)}`,
  };
}

async function parseSubscription(content, source) {
  const decoded = decodeMaybeBase64(content);
  const lines = decoded.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const uris = lines.filter(x => /^(vless|vmess|trojan|ss):\/\//i.test(x));
  if (!uris.length) throw new Error("未识别到支持的节点 URI（当前不支持 Clash YAML）");
  if (uris.length > MAX_NODES_PER_SOURCE) throw new Error(`单源节点数超过 ${MAX_NODES_PER_SOURCE} 条上限`);

  const out = [];
  const seenFp = new Set();
  let malformed = 0;
  for (const uri of uris) {
    try {
      const parsed = parseNodeUri(uri);
      const fingerprint = await sha256Hex(uri.trim());     // 与 V0.4.0 完全一致，历史 fingerprint 不变
      if (seenFp.has(fingerprint)) continue;
      seenFp.add(fingerprint);
      // 身份键只存哈希：UUID/密码等凭据不落库、不进日志；同一节点跨次同步仍然稳定
      const identityKey = await sha256Hex(parsed.identityMaterial);
      out.push({
        name: parsed.name,
        protocol: parsed.protocol,
        server: parsed.server,
        port: parsed.port,
        uri: uri.trim(),
        fingerprint,
        identityKey,
        tier: source.tier || "free",
      });
    } catch {
      malformed += 1;
    }
  }
  if (!out.length) throw new Error("订阅中没有可解析的 VLESS/VMess/Trojan/SS 节点");
  return { nodes: out, malformed };
}

/** 递归稳定序列化：对象键排序、数组顺序不变、嵌套结构完整保留。 */
function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map(k => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
}

function maskSubscriptionUrl(raw) {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/•••`;
  } catch {
    return "https://•••/•••";
  }
}

/* ────────────────────────────── 同步引擎（lease / stage / manifest / fencing / commit）────────────────────────────── */

const FENCE_SQL = `EXISTS (SELECT 1 FROM subscription_sync_state st
  WHERE st.source_id = ? AND st.generation = ? AND st.lease_owner = ?
    AND st.lease_token_hash = ? AND st.lease_expires_at > ?)`;

function fenceBinds(lease) {
  return [lease.sourceId, lease.generation, lease.owner, lease.tokenHash, Date.now()];
}
/** 断言语句：fence 失效时 json_extract 报错 → 整个 D1 batch 回滚。 */
function fenceAssert(db, lease) {
  return db.prepare(`SELECT CASE WHEN ${FENCE_SQL} THEN 1 ELSE json_extract('fence-lost', '$') END`)
    .bind(...fenceBinds(lease));
}
/** 通用断言：条件不成立则让 batch 回滚。 */
function assertStmt(db, conditionSql, binds) {
  return db.prepare(`SELECT CASE WHEN (${conditionSql}) THEN 1 ELSE json_extract('assert-failed', '$') END`)
    .bind(...binds);
}

async function acquireLease(db, sourceId, actorUserId, triggerKind) {
  const owner = newId();
  const token = newSessionToken();
  const tokenHash = await sha256Hex(token);
  const nowMs = Date.now();
  const expires = nowMs + LEASE_MS;

  const res = await db.prepare(
    `INSERT INTO subscription_sync_state(source_id, generation, lease_owner, lease_token_hash, lease_expires_at, updated_at)
     VALUES(?, 1, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(source_id) DO UPDATE SET
       generation = subscription_sync_state.generation + 1,
       lease_owner = excluded.lease_owner,
       lease_token_hash = excluded.lease_token_hash,
       lease_expires_at = excluded.lease_expires_at,
       updated_at = CURRENT_TIMESTAMP
     WHERE subscription_sync_state.lease_expires_at <= ?`,
  ).bind(sourceId, owner, tokenHash, expires, nowMs).run();
  if (!res.meta?.changes) return null;         // 已有未过期租约

  const state = await db.prepare(
    "SELECT generation, lease_owner, lease_token_hash, lease_expires_at FROM subscription_sync_state WHERE source_id = ?",
  ).bind(sourceId).first();
  if (!state || state.lease_owner !== owner || state.lease_token_hash !== tokenHash) return null;
  if (Number(state.lease_expires_at) <= Date.now()) return null;

  const taskId = newId();
  await db.batch([
    // 先删掉将被取代任务的暂存（含完整 URI），再改状态
    db.prepare(
      `DELETE FROM sync_task_stage WHERE task_id IN (
         SELECT id FROM sync_tasks WHERE source_id = ? AND id <> ? AND status IN ('staging','staged'))`,
    ).bind(sourceId, taskId),
    db.prepare(
      `INSERT INTO sync_tasks(id, source_id, generation, lease_owner, lease_token_hash, actor_user_id, trigger_kind, status)
       VALUES(?,?,?,?,?,?,?,'staging')`,
    ).bind(taskId, sourceId, state.generation, owner, tokenHash, actorUserId || null, triggerKind),
    db.prepare(
      `UPDATE sync_tasks SET status='abandoned', error_message='superseded by newer generation', updated_at=CURRENT_TIMESTAMP
        WHERE source_id = ? AND id <> ? AND status IN ('staging','staged')`,
    ).bind(sourceId, taskId),
  ]);

  return { taskId, sourceId, generation: state.generation, owner, tokenHash, expires };
}

async function stageNodes(db, lease, records) {
  const CHUNK = 20;
  const stageSql = `INSERT INTO sync_task_stage(task_id, seq, node_key, payload)
    SELECT ?,?,?,? WHERE ${FENCE_SQL}`;
  let seq = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const stmts = [fenceAssert(db, lease)];
    for (const record of records.slice(i, i + CHUNK)) {
      stmts.push(db.prepare(stageSql).bind(lease.taskId, seq, record.k, stableJson(record), ...fenceBinds(lease)));
      seq += 1;
    }
    const results = await db.batch(stmts);
    for (let j = 1; j < results.length; j++) {
      if (!results[j].meta?.changes) throw new Error("stage 写入被 fencing 拒绝（租约已失效）");
    }
  }
  const upd = await db.prepare(
    `UPDATE sync_tasks SET staged_count = ?, node_count = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'staging' AND ${FENCE_SQL}`,
  ).bind(seq, seq, lease.taskId, ...fenceBinds(lease)).run();
  if (!upd.meta?.changes) throw new Error("任务状态异常，无法记录暂存计数");
  return seq;
}

async function sealTask(db, lease, expectedCount) {
  const rows = await db.prepare(
    "SELECT seq, node_key, payload FROM sync_task_stage WHERE task_id = ? ORDER BY seq ASC",
  ).bind(lease.taskId).all();
  const list = rows.results || [];
  if (list.length !== expectedCount) throw new Error(`暂存数量不一致：期望 ${expectedCount}，实际 ${list.length}`);
  const material = list.map(r => `${r.seq}\t${r.node_key}\t${r.payload}`).join("\n");
  const stageHash = await sha256Hex(material);   // 由 Worker 读取完整 Stage 后自行计算

  await db.batch([
    fenceAssert(db, lease),
    db.prepare("INSERT INTO sync_task_manifests(task_id, node_count, stage_hash, canonicalization_version) VALUES(?,?,?,?)")
      .bind(lease.taskId, list.length, stageHash, CANON_VERSION),
    assertStmt(db, "EXISTS (SELECT 1 FROM sync_task_manifests WHERE task_id=? AND stage_hash=?)", [lease.taskId, stageHash]),
    db.prepare(
      `UPDATE sync_tasks SET status='staged', manifest_hash=?, node_count=?, staged_count=?, updated_at=CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'staging' AND ${FENCE_SQL}`,
    ).bind(stageHash, list.length, list.length, lease.taskId, ...fenceBinds(lease)),
    fenceAssert(db, lease),
  ]);
  return stageHash;
}

async function commitTask(db, lease, source, meta) {
  const rows = await db.prepare(
    "SELECT seq, node_key, payload FROM sync_task_stage WHERE task_id = ? ORDER BY seq ASC",
  ).bind(lease.taskId).all();
  const list = rows.results || [];
  if (list.length !== meta.records) throw new Error("提交前校验失败：stage 记录数变化");
  // 提交前由 Worker 重新计算摘要，与 manifest 比对（不信任客户端/早期写入）
  const stageHash = await sha256Hex(list.map(r => `${r.seq}\t${r.node_key}\t${r.payload}`).join("\n"));
  if (stageHash !== meta.manifestHash) throw new Error("提交前校验失败：摘要不匹配");

  const taskStatusSql = "EXISTS (SELECT 1 FROM sync_tasks WHERE id=? AND status='staged' AND manifest_hash=?)";
  const stageStatusBinds = [lease.taskId, meta.manifestHash];

  // set-based 写入：语句数与节点数无关（1 条 upsert + 1 条 alias + 校验 + 日志 + 审计 + 收尾），
  // 因此无论 31 条还是 500 条，整个提交都在同一个 D1 batch（同一事务）里完成。
  const upsertFromStage = `INSERT INTO node_records
      (id, source_id, source_name, name, protocol, server, port, uri, fingerprint, tier, enabled, last_seen, created_at, updated_at)
    SELECT json_extract(payload,'$.id'), ?, json_extract(payload,'$.sn'), json_extract(payload,'$.n'),
           json_extract(payload,'$.p'), json_extract(payload,'$.h'), json_extract(payload,'$.o'),
           json_extract(payload,'$.u'), json_extract(payload,'$.fp'), json_extract(payload,'$.t'),
           1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM sync_task_stage
     WHERE task_id = ? AND ${FENCE_SQL}
    ON CONFLICT(source_id, fingerprint) DO UPDATE SET
      source_name=excluded.source_name, name=excluded.name, protocol=excluded.protocol,
      server=excluded.server, port=excluded.port, uri=excluded.uri, tier=excluded.tier,
      enabled=1, last_seen=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`;
  const aliasFromStage = `INSERT INTO node_identity_aliases(source_id, identity_key, fingerprint)
    SELECT ?, json_extract(payload,'$.k'), json_extract(payload,'$.fp')
      FROM sync_task_stage
     WHERE task_id = ? AND ${FENCE_SQL}
    ON CONFLICT(source_id, identity_key) DO UPDATE SET
      fingerprint=excluded.fingerprint, updated_at=CURRENT_TIMESTAMP`;
  // 提交后的数量自证：库内与 stage 的节点数必须一致，否则整批回滚
  const integritySql = `((SELECT COUNT(*) FROM node_records n WHERE n.source_id = ?
      AND n.fingerprint IN (SELECT json_extract(payload,'$.fp') FROM sync_task_stage WHERE task_id = ?))
    = (SELECT COUNT(*) FROM sync_task_stage WHERE task_id = ?))`;

  await db.batch([
    fenceAssert(db, lease),
    assertStmt(db, taskStatusSql, stageStatusBinds),
    db.prepare(upsertFromStage).bind(source.id, lease.taskId, ...fenceBinds(lease)),
    db.prepare(aliasFromStage).bind(source.id, lease.taskId, ...fenceBinds(lease)),
    assertStmt(db, integritySql, [source.id, lease.taskId, lease.taskId]),
    (meta.disableMissing
      ? db.prepare(
        `UPDATE node_records SET enabled = 0, updated_at = CURRENT_TIMESTAMP
          WHERE source_id = ? AND ${FENCE_SQL}
            AND fingerprint NOT IN (
              SELECT json_extract(payload, '$.fp') FROM sync_task_stage WHERE task_id = ?
            )`,
      ).bind(source.id, ...fenceBinds(lease), lease.taskId)
      : db.prepare("SELECT 1 WHERE 1")),
    db.prepare(
      `INSERT INTO node_sync_logs(source_id, source_name, status, total_nodes, added_nodes, updated_nodes, error_message, trigger_kind, duration_ms, missing_nodes)
       SELECT ?,?, 'success', ?, ?, ?, '', ?, ?, ? WHERE ${FENCE_SQL}`,
    ).bind(source.id, s(source.name, 100), meta.records, meta.added, meta.updated,
      s(meta.triggerKind || "manual", 20), Number(meta.durationMs || 0), Number(meta.missing || 0), ...fenceBinds(lease)),
    auditStmt(db, meta.ctx, {
      action: "sync.commit", targetType: "source", targetId: source.id,
      after: {
        task_id: lease.taskId, generation: lease.generation, nodes: meta.records,
        added: meta.added, updated: meta.updated, missing: meta.missing,
        malformed: meta.malformed, manifest: meta.manifestHash,
      },
      detail: "单批原子提交（set-based upsert）",
    }),
    db.prepare(
      `UPDATE sync_tasks SET status='committed', committed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP,
              missing_count=?, manifest_hash=?
        WHERE id = ? AND status = 'staged' AND ${FENCE_SQL}`,
    ).bind(meta.missing, meta.manifestHash, lease.taskId, ...fenceBinds(lease)),
    db.prepare("DELETE FROM sync_task_stage WHERE task_id = ?").bind(lease.taskId),
    db.prepare(
      `UPDATE subscription_sync_state SET lease_expires_at = 0, last_success_at = CURRENT_TIMESTAMP,
              last_manifest_hash = ?, last_task_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE source_id = ? AND generation = ? AND lease_owner = ?`,
    ).bind(meta.manifestHash, lease.taskId, lease.sourceId, lease.generation, lease.owner),
  ]);
}

async function failTask(db, lease, message, ctx) {
  const clean = s(message, MAX_LOG_ERROR) || "同步失败";
  try {
    await db.batch([
      // 先清暂存（payload 含完整 URI），再标记失败；同一批次保证一致
      db.prepare("DELETE FROM sync_task_stage WHERE task_id = ?").bind(lease.taskId),
      db.prepare(
        `UPDATE sync_tasks SET status='failed', error_message=?, updated_at=CURRENT_TIMESTAMP
          WHERE id = ? AND generation = ?`,
      ).bind(clean, lease.taskId, lease.generation),
      db.prepare(
        `UPDATE subscription_sync_state SET lease_expires_at = 0, updated_at = CURRENT_TIMESTAMP
          WHERE source_id = ? AND generation = ? AND lease_owner = ?`,
      ).bind(lease.sourceId, lease.generation, lease.owner),
      auditStmt(db, ctx || { actorId: "scheduled", effectiveId: null, requestId: "" }, {
        action: "sync.failed", targetType: "source", targetId: lease.sourceId,
        result: "failed", reason: clean.slice(0, 200),
        detail: `task=${lease.taskId}; generation=${lease.generation}`,
      }),
    ]);
  } catch { /* 释放失败交由租约自然过期 */ }
}

/* ────────────── 机场额度（只存订阅源级数据，仅总后台可见） ────────────── */

function toSqlTime(unixSeconds) {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return null;
  const ms = unixSeconds * 1000;
  if (Math.abs(ms) > 8.64e15) return null;
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString().replace("T", " ").slice(0, 19);
}

async function recordQuotaSuccess(db, sourceId, quota) {
  const q = quota || {};
  const total = Number.isFinite(q.total) ? q.total : null;
  const upload = Number.isFinite(q.upload) ? q.upload : null;
  const download = Number.isFinite(q.download) ? q.download : null;
  const expiresAt = toSqlTime(q.expire);
  const title = q.title ? s(q.title, 200) : null;
  const used = upload !== null && download !== null ? upload + download : null;
  const remaining = total !== null && total > 0 && used !== null ? Math.max(0, total - used) : null;
  const supplied = [total, upload, download, expiresAt, title].filter(v => v !== null).length;

  if (supplied === 0) {
    // 抓取成功，但机场这次没给额度信息：不动历史数据，只记“本次未获取”
    await db.prepare(
      `INSERT INTO source_quota(source_id, status, last_attempt_at, error_message)
       VALUES(?, 'none', CURRENT_TIMESTAMP, '本次响应未提供额度信息')
       ON CONFLICT(source_id) DO UPDATE SET
         status = 'none',
         last_attempt_at = CURRENT_TIMESTAMP,
         error_message = '本次响应未提供额度信息',
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(sourceId).run();
    return "none";
  }

  // 完整 = 总额 + 用量 + 到期 都有；缺任意一项即“部分获取”
  const status = total !== null && used !== null && expiresAt !== null ? "ok" : "partial";
  await db.prepare(
    `INSERT INTO source_quota(source_id, profile_title, total_bytes, upload_bytes, download_bytes, used_bytes, remaining_bytes, expires_at, status, last_success_at, last_attempt_at, error_message)
     VALUES(?,?,?,?,?,?,?,?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '')
     ON CONFLICT(source_id) DO UPDATE SET
       profile_title   = COALESCE(excluded.profile_title, source_quota.profile_title),
       total_bytes     = COALESCE(excluded.total_bytes, source_quota.total_bytes),
       upload_bytes    = COALESCE(excluded.upload_bytes, source_quota.upload_bytes),
       download_bytes  = COALESCE(excluded.download_bytes, source_quota.download_bytes),
       used_bytes      = COALESCE(excluded.used_bytes, source_quota.used_bytes),
       remaining_bytes = COALESCE(excluded.remaining_bytes, source_quota.remaining_bytes),
       expires_at      = COALESCE(excluded.expires_at, source_quota.expires_at),
       status = excluded.status, last_success_at = CURRENT_TIMESTAMP, last_attempt_at = CURRENT_TIMESTAMP,
       error_message = '', updated_at = CURRENT_TIMESTAMP`,
  ).bind(sourceId, title, total, upload, download, used, remaining, expiresAt, status).run();
  return status;
}

/** 失败只更新状态与时间，绝不覆盖上一次成功的数据。 */
async function recordQuotaFailure(db, sourceId, message) {
  await db.prepare(
    `INSERT INTO source_quota(source_id, status, last_attempt_at, error_message)
     VALUES(?, 'unavailable', CURRENT_TIMESTAMP, ?)
     ON CONFLICT(source_id) DO UPDATE SET
       status = CASE WHEN source_quota.last_success_at IS NULL THEN 'unavailable' ELSE 'stale' END,
       last_attempt_at = CURRENT_TIMESTAMP,
       error_message = excluded.error_message,
       updated_at = CURRENT_TIMESTAMP`,
  ).bind(sourceId, s(message, 200)).run();
}

/**
 * 单源同步：抓取 → 解析 → 匹配历史节点 → Stage → 封存 → 原子提交。
 * 缺失节点默认只计数；仅当 SYNC_DISABLE_MISSING=1 且不是“断崖式变少”时，才在提交批次里把它们 enabled=0。
 * 任何情况下都不删除节点行、不改 fingerprint。
 */
async function syncSource(db, source, opts = {}) {
  const { actorUserId, triggerKind, ctx, env } = opts;
  const startedAt = Date.now();
  const lease = await acquireLease(db, source.id, actorUserId, triggerKind);
  if (!lease) {
    return { source_id: source.id, source_name: source.name, status: "busy", error: "该订阅源已有同步任务在执行" };
  }
  let quotaRecorded = false;
  try {
    // 同步开始（best-effort：失败不影响主流程，也不写敏感内容）
    try {
      await db.prepare(
        `INSERT INTO admin_audit_events(actor_user_id, effective_user_id, action, target_type, target_id, request_id, detail, result)
         VALUES(?,?, 'sync.start', 'source', ?, ?, ?, 'ok')`,
      ).bind(ctx?.actorId || null, ctx?.effectiveId || null, source.id, s(ctx?.requestId, 80),
        `task=${lease.taskId}; generation=${lease.generation}; trigger=${triggerKind}`).run();
    } catch { /* 审计不可用不阻断同步 */ }
    const fetched = await fetchSubscription(source.url);
    try {
      await recordQuotaSuccess(db, source.id, fetched.quota);
      quotaRecorded = true;
    } catch { /* 额度写入失败不影响节点同步 */ }
    const parsed = await parseSubscription(fetched.text, source);

    const existing = await db.prepare("SELECT id, fingerprint FROM node_records WHERE source_id = ?").bind(source.id).all();
    const byFingerprint = new Map((existing.results || []).map(r => [r.fingerprint, r.id]));
    const aliases = await db.prepare("SELECT identity_key, fingerprint FROM node_identity_aliases WHERE source_id = ?").bind(source.id).all();
    const aliasMap = new Map((aliases.results || []).map(r => [r.identity_key, r.fingerprint]));

    const records = [];
    const seen = new Set();
    let added = 0, updated = 0;
    for (const node of parsed.nodes) {
      let id = byFingerprint.get(node.fingerprint);
      let targetFp = node.fingerprint;
      if (!id) {
        const aliasFp = aliasMap.get(node.identityKey);
        if (aliasFp && byFingerprint.has(aliasFp)) {
          targetFp = aliasFp;
          id = byFingerprint.get(aliasFp);
        }
      }
      if (id) updated += 1;
      else { id = newId(); added += 1; }
      seen.add(targetFp);
      records.push({
        v: CANON_VERSION, k: node.identityKey, n: node.name, p: node.protocol,
        h: node.server, o: node.port, t: node.tier, fp: targetFp, id, u: node.uri, sn: s(source.name, 100),
      });
    }
    const previousCount = byFingerprint.size;
    const missing = [...byFingerprint.keys()].filter(fp => !seen.has(fp)).length;
    // 订阅“断崖式变少”时不自动停用，避免一次异常响应把整源节点全停掉。
    const suspiciousShrink = previousCount >= 10 && records.length < Math.ceil(previousCount * 0.5);
    const disableMissing = String(opts.env?.SYNC_DISABLE_MISSING || "") === "1" && !suspiciousShrink;

    await stageNodes(db, lease, records);
    const manifestHash = await sealTask(db, lease, records.length);
    await commitTask(db, lease, source, {
      records: records.length, added, updated, missing, malformed: parsed.malformed,
      triggerKind: triggerKind || "manual", durationMs: Date.now() - startedAt,
      manifestHash, ctx, disableMissing, suspiciousShrink,
    });

    return {
      source_id: source.id, source_name: source.name, status: "success",
      total_nodes: records.length, added_nodes: added, updated_nodes: updated,
      missing_nodes: missing, disabled_missing: disableMissing ? missing : 0,
      suspicious_shrink: suspiciousShrink,
      manifest_hash: manifestHash, task_id: lease.taskId, generation: lease.generation,
    };
  } catch (e) {
    if (!quotaRecorded) {
      try { await recordQuotaFailure(db, source.id, e?.message || "订阅获取失败"); } catch { /* 忽略 */ }
    }
    await failTask(db, lease, e?.message, ctx);
    return {
      source_id: source.id, source_name: source.name, status: "failed",
      total_nodes: 0, added_nodes: 0, updated_nodes: 0, error: s(e?.message || "同步失败", MAX_LOG_ERROR),
      task_id: lease.taskId, generation: lease.generation,
    };
  }
}

/** 多源同步：单源失败不阻断其他源。 */
async function runSync(db, sources, opts) {
  const results = [];
  for (const source of sources) {
    try {
      results.push(await syncSource(db, source, opts));
    } catch (e) {
      results.push({ source_id: source.id, source_name: source.name, status: "failed", error: s(e?.message, MAX_LOG_ERROR) });
    }
  }
  const success = results.filter(r => r.status === "success").length;
  const failed = results.filter(r => r.status === "failed").length;
  const busy = results.filter(r => r.status === "busy").length;
  return { results, success, failed, busy, total: results.length };
}

/* ────────────────────────────── 用户态：访问控制助手 ────────────────────────────── */

function requireUser(ctx) {
  if (!ctx) return fail("未登录", 401);
  return null;
}
function isMaskedUrl(v) {
  return typeof v === "string" && /^https?:\/\/[^/]+\/•••$/.test(v.trim());
}

/** 取当前生效身份可访问的订阅源；super 非协助态可访问全部。 */
async function loadSourceForCtx(db, ctx, sourceId) {
  const row = await db.prepare("SELECT * FROM subscription_sources WHERE id = ?").bind(sourceId).first();
  if (!row) return null;
  if (ctx.isSuper && ctx.actorId === ctx.effectiveId) return row;
  const own = await db.prepare("SELECT 1 AS ok FROM source_ownership WHERE source_id = ? AND user_id = ?")
    .bind(sourceId, ctx.effectiveId).first();
  return own ? row : null;
}

/** 订阅节点的归属：必须通过 source_ownership 走到当前用户。 */
async function loadSubscriptionNode(db, ctx, nodeId) {
  const row = await db.prepare("SELECT * FROM node_records WHERE id = ?").bind(nodeId).first();
  if (!row) return null;
  if (ctx.isSuper && ctx.actorId === ctx.effectiveId) return row;
  const own = await db.prepare("SELECT 1 AS ok FROM source_ownership WHERE source_id = ? AND user_id = ?")
    .bind(row.source_id, ctx.effectiveId).first();
  return own ? row : null;
}

async function loadManualNode(db, ctx, nodeId) {
  return db.prepare("SELECT * FROM user_manual_nodes WHERE id = ? AND user_id = ?")
    .bind(nodeId, ctx.effectiveId).first();
}

/** 任一节点：返回 {kind, row} 或 null。 */
async function loadAnyNode(db, ctx, nodeId) {
  const manual = await loadManualNode(db, ctx, nodeId);
  if (manual) return { kind: "manual", row: manual };
  const sub = await loadSubscriptionNode(db, ctx, nodeId);
  if (sub) return { kind: "subscription", row: sub };
  return null;
}

function overrideMap(rows) {
  const out = {};
  for (const r of rows || []) out[r.field_name] = r.override_value;
  return out;
}

function composeEffective(row, ov, kind) {
  const base = kind === "manual"
    ? { id: row.id, name: row.name, protocol: row.protocol, server: row.server, port: row.port, tier: row.tier, enabled: row.enabled }
    : { id: row.id, name: row.name, protocol: row.protocol, server: row.server, port: row.port, tier: row.tier, enabled: row.enabled };
  const out = { ...base };
  if (ov.name !== undefined) out.name = ov.name;
  if (ov.protocol !== undefined) out.protocol = ov.protocol;
  if (ov.server !== undefined) out.server = ov.server;
  if (ov.port !== undefined) out.port = Number(ov.port);
  if (ov.tier !== undefined) out.tier = ov.tier;
  if (ov.enabled !== undefined) out.enabled = Number(ov.enabled);
  return out;
}

/* ────────────────────────────── 用户态：订阅源 ────────────────────────────── */

async function userSourcesRoute(req, env, url, ctx) {
  const db = env.DB;
  const method = req.method;
  const path = url.pathname;
  const seg = path.split("/").filter(Boolean);   // api, user, sources, :id, enabled

  if (seg.length === 3 && method === "GET") {
    const rows = ctx.isSuper && ctx.actorId === ctx.effectiveId
      ? await db.prepare(
        `SELECT s.*, so.user_id AS owner_user_id, ap.status AS approval_status
           FROM subscription_sources s
           LEFT JOIN source_ownership so ON so.source_id = s.id
           LEFT JOIN source_approvals ap ON ap.source_id = s.id
          ORDER BY s.priority ASC, s.created_at ASC`).all()
      : await db.prepare(
        `SELECT s.*, so.user_id AS owner_user_id, ap.status AS approval_status
           FROM subscription_sources s
           JOIN source_ownership so ON so.source_id = s.id AND so.user_id = ?
           LEFT JOIN source_approvals ap ON ap.source_id = s.id
          ORDER BY s.priority ASC, s.created_at ASC`).bind(ctx.effectiveId).all();
    return json({
      ok: true,
      data: (rows.results || []).map(r => ({
        id: r.id, name: r.name, url: maskSubscriptionUrl(r.url), tier: r.tier, enabled: r.enabled,
        priority: r.priority, remark: r.remark, created_at: r.created_at, updated_at: r.updated_at,
        owner_user_id: r.owner_user_id ?? null,   // 未分配必须为 null，不能伪装成管理员所有
        approval_status: r.approval_status ?? "approved",
      })),
    });
  }

  if (seg.length === 3 && method === "POST") {
    const body = await readJson(req);
    const name = s(body.name, 120);
    const rawUrl = s(body.url, 2048);
    const tier = s(body.tier, 30) || "free";
    const priority = num(body.priority, 100);
    if (!name) return fail("来源名称不能为空", 400);
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(tier)) return fail("tier 格式不正确", 400);
    if (!Number.isInteger(priority) || priority < 0 || priority > 100000) return fail("priority 必须为 0-100000 的整数", 400);
    try { validateSubscriptionUrl(rawUrl); } catch (e) { return fail(e.message, 400); }

    const id = newId();
    const ownerId = ctx.effectiveId;
    // 审核机制：管理员直建=已批准；普通用户（含协助代建）=待审核，且先停用
    const adminDirect = ctx.isSuper && ctx.actorId === ctx.effectiveId;
    const approvalStatus = adminDirect ? "approved" : "pending";
    const enabled = adminDirect && body.enabled !== false ? 1 : 0;
    await userBatch(db, ctx, [
      db.prepare("INSERT INTO subscription_sources(id, name, url, tier, enabled, priority, remark) VALUES(?,?,?,?,?,?,?)")
        .bind(id, name, rawUrl, tier, enabled, priority, s(body.remark, 500)),
      db.prepare("INSERT INTO source_ownership(source_id, user_id, assigned_by) VALUES(?,?,?)")
        .bind(id, ownerId, ctx.actorId),
      db.prepare(
        `INSERT INTO source_approvals(source_id, status, requested_by, reviewed_by, reviewed_at)
         VALUES(?,?,?,?, CASE WHEN ? = 'approved' THEN CURRENT_TIMESTAMP ELSE NULL END)`,
      ).bind(id, approvalStatus, ctx.actorId, adminDirect ? ctx.actorId : null, approvalStatus),
      auditStmt(db, ctx, {
        action: "source.create", targetType: "source", targetId: id,
        after: { name, tier, priority, owner: ownerId, approval: approvalStatus },
        detail: adminDirect ? "管理员直建，自动批准" : "普通用户创建，待管理员审核",
      }),
    ]);
    return json({ ok: true, data: { id, approval_status: approvalStatus, enabled } }, 201);
  }

  const id = seg[3];
  if (!id || !validId(id)) return fail("来源 ID 无效", 400);
  const source = await loadSourceForCtx(db, ctx, id);
  if (!source) {
    await auditDenied(db, ctx, "source.access", "来源不存在或无权限", "source", id);
    return fail("订阅源不存在", 404);
  }

  if (seg.length === 5 && seg[4] === "enabled" && method === "PATCH") {
    const body = await readJson(req);
    const enabled = parseBool01(body.enabled);
    if (enabled === null) return fail("enabled 只能是 true/false/1/0", 400);
    if (enabled === 1) {
      const ap = await db.prepare("SELECT status FROM source_approvals WHERE source_id = ?").bind(id).first();
      if (ap && ap.status !== "approved") {
        return fail("该订阅源尚未通过审核，不能启用", 409, { code: "SOURCE_NOT_APPROVED", approval_status: ap.status });
      }
    }
    await userBatch(db, ctx, [
      db.prepare("UPDATE subscription_sources SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(enabled, id),
      auditStmt(db, ctx, { action: "source.enabled", targetType: "source", targetId: id, before: { enabled: source.enabled }, after: { enabled } }),
    ]);
    return json({ ok: true, data: { id, enabled } });
  }

  if (seg.length === 4 && method === "PUT") {
    const body = await readJson(req);
    let rawUrl = s(body.url, 2048);
    if (isMaskedUrl(rawUrl)) rawUrl = source.url;          // 前端拿到的是脱敏 URL
    const name = s(body.name, 120);
    const tier = s(body.tier, 30) || "free";
    const priority = num(body.priority, 100);
    if (!name) return fail("来源名称不能为空", 400);
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(tier)) return fail("tier 格式不正确", 400);
    if (!Number.isInteger(priority) || priority < 0 || priority > 100000) return fail("priority 必须为 0-100000 的整数", 400);
    try { validateSubscriptionUrl(rawUrl); } catch (e) { return fail(e.message, 400); }

    const urlChanged = rawUrl !== source.url;
    const adminDirect = ctx.isSuper && ctx.actorId === ctx.effectiveId;
    // 安全字段（订阅地址）变更：必须重新审核，并在同一批次里停用
    const requiresReview = urlChanged && !adminDirect;
    const stmts = [
      db.prepare(
        urlChanged
          ? "UPDATE subscription_sources SET name=?, url=?, tier=?, priority=?, remark=?, enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
          : "UPDATE subscription_sources SET name=?, url=?, tier=?, priority=?, remark=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
      ),
    ];
    if (urlChanged) {
      stmts[0] = stmts[0].bind(name, rawUrl, tier, priority, s(body.remark, 500), requiresReview ? 0 : source.enabled, id);
      if (requiresReview) {
        stmts.push(
          db.prepare(
            `INSERT INTO source_approvals(source_id, status, requested_by, reviewed_by, reviewed_at, reason)
             VALUES(?, 'pending', ?, NULL, NULL, '订阅地址变更，需重新审核')
             ON CONFLICT(source_id) DO UPDATE SET
               status='pending', requested_by=excluded.requested_by, reviewed_by=NULL,
               reviewed_at=NULL, reason=excluded.reason, created_at=CURRENT_TIMESTAMP`,
          ).bind(id, ctx.actorId),
        );
      } else if (adminDirect) {
        // 管理员直接改地址：数据库审批状态必须与返回值一致（approved），不改变 enabled
        stmts.push(
          db.prepare(
            `INSERT INTO source_approvals(source_id, status, requested_by, reviewed_by, reviewed_at, reason)
             VALUES(?, 'approved', ?, ?, CURRENT_TIMESTAMP, '管理员直接修改地址')
             ON CONFLICT(source_id) DO UPDATE SET
               status='approved', reviewed_by=excluded.reviewed_by,
               reviewed_at=CURRENT_TIMESTAMP, reason=excluded.reason`,
          ).bind(id, ctx.actorId, ctx.actorId),
        );
      }
    } else {
      stmts[0] = stmts[0].bind(name, rawUrl, tier, priority, s(body.remark, 500), id);
    }
    stmts.push(auditStmt(db, ctx, {
      action: requiresReview ? "source.update.re_review" : "source.update",
      targetType: "source", targetId: id,
      before: { name: source.name, tier: source.tier, priority: source.priority, url: maskSubscriptionUrl(source.url), enabled: source.enabled },
      after: { name, tier, priority, url: maskSubscriptionUrl(rawUrl), enabled: requiresReview ? 0 : source.enabled },
      detail: requiresReview ? "订阅地址变更：已停用并重新进入待审核" : (urlChanged ? "管理员直接修改地址，保持已批准" : "仅修改非安全字段"),
      reason: requiresReview ? "url_changed" : "",
    }));
    await userBatch(db, ctx, stmts);
    return json({
      ok: true,
      data: {
        id,
        url_changed: urlChanged,
        approval_status: requiresReview ? "pending" : (adminDirect && urlChanged ? "approved" : undefined),
        enabled: requiresReview ? 0 : source.enabled,
        requires_review: requiresReview,
      },
    });
  }

  if (seg.length === 5 && seg[4] === "sync" && method === "POST") {
    // 用户态手动同步：严格归属 + 审批 + 启用状态，三者都满足才允许
    const scopeDenied = requireScope(ctx, "operate");
    if (scopeDenied) return scopeDenied;
    const own = await db.prepare("SELECT user_id FROM source_ownership WHERE source_id = ?").bind(id).first();
    if (!own) {
      await auditDenied(db, ctx, "source.sync", "未分配来源不可同步", "source", id);
      return fail("该来源尚未分配归属，不能同步", 409, { code: "SOURCE_UNASSIGNED" });
    }
    if (ctx.actorId === ctx.effectiveId && !ctx.isSuper && own.user_id !== ctx.effectiveId) {
      return fail("订阅源不存在", 404);
    }
    const ap = await db.prepare("SELECT status FROM source_approvals WHERE source_id = ?").bind(id).first();
    if (ap && ap.status !== "approved") {
      return fail("该来源尚未通过审核，不能同步", 409, { code: "SOURCE_NOT_APPROVED", approval_status: ap.status });
    }
    if (Number(source.enabled) !== 1) {
      return fail("该来源已停用，不能同步", 409, { code: "SOURCE_DISABLED" });
    }
    const result = await syncSource(db, {
      id: source.id, name: source.name, url: source.url, tier: source.tier,
    }, { actorUserId: ctx.actorId, triggerKind: "manual", ctx, env });
    return json({ ok: result.status === "success", data: result });
  }

  if (seg.length === 4 && method === "DELETE") {
    // 历史保留规则：任何情况下都不物理删除来源，只停用归档。
    const nodes = await db.prepare("SELECT COUNT(*) AS n FROM node_records WHERE source_id = ?").bind(id).first();
    const tasks = await db.prepare(
      "SELECT COUNT(*) AS n FROM sync_tasks WHERE source_id = ? AND status IN ('staging','staged')",
    ).bind(id).first();
    await userBatch(db, ctx, [
      db.prepare("UPDATE subscription_sources SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id),
      // 解除归属：用户列表里消失，但来源与节点保留在库里（备份给超管），不会物理删除
      db.prepare("DELETE FROM source_ownership WHERE source_id = ? AND user_id = ?").bind(id, ctx.effectiveId),
      auditStmt(db, ctx, {
        action: "source.archive", targetType: "source", targetId: id, result: "ok",
        reason: "用户删除：解除归属并停用，数据保留为超管备份",
        detail: `history_nodes=${Number(nodes?.n || 0)}; pending_tasks=${Number(tasks?.n || 0)}`,
      }),
    ]);
    return json({
      ok: true,
      data: { id, archived: true, node_count: Number(nodes?.n || 0) },
      message: "已从你的列表移除并停用；订阅源与节点作为备份保留在超管后台",
    });
  }

  return fail("不支持的订阅源操作", 405);
}

/* ── 用户转换分组（转换结果的节点分组）── */
async function userConvertGroupsRoute(req, env, url, ctx) {
  const db = env.DB;
  if (req.method !== "GET") return fail("接口不存在", 404);
  const rows = await db.prepare(
    `SELECT group_name, COUNT(*) AS links, SUM(hits) AS hits, MIN(created_at) AS first_at, MAX(COALESCE(last_used_at, created_at)) AS last_at
       FROM convert_links WHERE owner_user_id = ? GROUP BY group_name ORDER BY last_at DESC`,
  ).bind(ctx.effectiveId).all();
  return json({ ok: true, data: rows.results || [] });
}

/* ────────────────────────────── 用户态：节点列表 ────────────────────────────── */

function buildNodeListQuery(ctx, params) {
  const cte = `
    WITH eff AS (
      SELECT n.id AS id, 'subscription' AS node_kind, n.source_id AS source_id, n.source_name AS source_name,
             COALESCE(ovn.override_value, n.name) AS name,
             COALESCE(ovp.override_value, n.protocol) AS protocol,
             COALESCE(ovs.override_value, n.server) AS server,
             CASE WHEN ovr.override_value IS NOT NULL THEN CAST(ovr.override_value AS INTEGER) ELSE n.port END AS port,
             COALESCE(ovt.override_value, n.tier) AS tier,
             CASE WHEN ove.override_value IS NOT NULL THEN CAST(ove.override_value AS INTEGER) ELSE n.enabled END AS enabled,
             n.last_seen AS last_seen, n.created_at AS created_at, n.updated_at AS updated_at
        FROM node_records n
        JOIN source_ownership so ON so.source_id = n.source_id AND so.user_id = ?
        LEFT JOIN node_overrides ovn ON ovn.user_id = ? AND ovn.node_id = n.id AND ovn.field_name = 'name'
        LEFT JOIN node_overrides ovp ON ovp.user_id = ? AND ovp.node_id = n.id AND ovp.field_name = 'protocol'
        LEFT JOIN node_overrides ovs ON ovs.user_id = ? AND ovs.node_id = n.id AND ovs.field_name = 'server'
        LEFT JOIN node_overrides ovr ON ovr.user_id = ? AND ovr.node_id = n.id AND ovr.field_name = 'port'
        LEFT JOIN node_overrides ovt ON ovt.user_id = ? AND ovt.node_id = n.id AND ovt.field_name = 'tier'
        LEFT JOIN node_overrides ove ON ove.user_id = ? AND ove.node_id = n.id AND ove.field_name = 'enabled'
      UNION ALL
      SELECT m.id, 'manual', NULL, '', m.name, m.protocol, m.server, m.port, m.tier, m.enabled,
             m.updated_at, m.created_at, m.updated_at
        FROM user_manual_nodes m WHERE m.user_id = ?
    )`;
  const uid = ctx.effectiveId;
  const binds = [uid, uid, uid, uid, uid, uid, uid, uid];
  const where = [];
  const whereBinds = [];

  if (s(params.source_id, 80)) { where.push("source_id = ?"); whereBinds.push(s(params.source_id, 80)); }
  if (s(params.protocol, 20)) { where.push("protocol = ?"); whereBinds.push(s(params.protocol, 20).toLowerCase()); }
  if (s(params.tier, 30)) { where.push("tier = ?"); whereBinds.push(s(params.tier, 30)); }
  if (params.enabled === "0" || params.enabled === "1") { where.push("enabled = ?"); whereBinds.push(Number(params.enabled)); }
  if (s(params.kind, 20)) { where.push("node_kind = ?"); whereBinds.push(s(params.kind, 20)); }
  if (s(params.q, 100)) {
    where.push(`(name LIKE ? OR server LIKE ? OR source_name LIKE ?
      OR EXISTS (SELECT 1 FROM node_user_metadata md
                  WHERE md.user_id = ? AND md.node_kind = eff.node_kind AND md.node_id = eff.id AND md.remark LIKE ?))`);
    const like = `%${s(params.q, 100)}%`;
    whereBinds.push(like, like, like, uid, like);
  }
  if (s(params.group_id, 80)) {
    where.push(`EXISTS (SELECT 1 FROM node_group_members g
      WHERE g.user_id = ? AND g.group_id = ? AND g.node_kind = eff.node_kind AND g.node_id = eff.id)`);
    whereBinds.push(uid, s(params.group_id, 80));
  }
  if (params.favorite === "1") {
    where.push(`EXISTS (SELECT 1 FROM node_user_metadata md
      WHERE md.user_id = ? AND md.node_kind = eff.node_kind AND md.node_id = eff.id AND md.favorite = 1)`);
    whereBinds.push(uid);
  }

  const sortKey = s(params.sort, 40).split(":")[0] || "updated_at";
  const dir = (s(params.sort, 40).split(":")[1] || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";
  const sortCol = SORTABLE_COLUMNS.has(sortKey) ? sortKey : "updated_at";

  const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
  const selectSql = `${cte}
    SELECT eff.*,
      (SELECT remark FROM node_user_metadata md WHERE md.user_id = ? AND md.node_kind = eff.node_kind AND md.node_id = eff.id) AS remark,
      (SELECT favorite FROM node_user_metadata md WHERE md.user_id = ? AND md.node_kind = eff.node_kind AND md.node_id = eff.id) AS favorite,
      (SELECT sort_order FROM node_user_metadata md WHERE md.user_id = ? AND md.node_kind = eff.node_kind AND md.node_id = eff.id) AS sort_order
    FROM eff${whereSql}
    ORDER BY ${sortCol} ${dir}, id ASC
    LIMIT ? OFFSET ?`;
  const countSql = `${cte} SELECT COUNT(*) AS total FROM eff${whereSql}`;

  return {
    selectSql,
    selectBinds: [...binds, uid, uid, uid, ...whereBinds, 0, 0],
    countSql,
    countBinds: [...binds, ...whereBinds],
  };
}

async function userNodesRoute(req, env, url, ctx) {
  const db = env.DB;
  const method = req.method;
  const seg = url.pathname.split("/").filter(Boolean);   // api,user,nodes,...

  if (seg.length === 3 && method === "GET") {
    const p = Object.fromEntries(url.searchParams.entries());
    const paging = parsePaging(p);
    if (paging.error) return fail(paging.error, 400);
    const { limit, offset } = paging;
    const q = buildNodeListQuery(ctx, p);
    const total = await db.prepare(q.countSql).bind(...q.countBinds).first();
    const rows = await db.prepare(q.selectSql).bind(...q.selectBinds.slice(0, -2), limit, offset).all();
    return json({ ok: true, data: rows.results || [], total: Number(total?.total || 0), limit, offset });
  }

  // 手动节点
  if (seg[3] === "manual") {
    if (seg.length === 4 && method === "POST") {
      const body = await readJson(req);
      const built = buildManualNode(body);
      if (built.error) return fail(built.error, 400);
      const id = newId();
      await userBatch(db, ctx, [
        db.prepare(
          `INSERT INTO user_manual_nodes(id, user_id, name, protocol, server, port, uri, tier, enabled, remark)
           VALUES(?,?,?,?,?,?,?,?,?,?)`,
        ).bind(id, ctx.effectiveId, built.node.name, built.node.protocol, built.node.server, built.node.port,
          built.node.uri, built.node.tier, built.node.enabled, built.node.remark),
        auditStmt(db, ctx, { action: "manual_node.create", targetType: "manual_node", targetId: id, after: built.node }),
      ]);
      return json({ ok: true, data: { id } }, 201);
    }
    const id = seg[4];
    if (!id || !validId(id)) return fail("节点 ID 无效", 400);
    const existing = await loadManualNode(db, ctx, id);
    if (!existing) {
      await auditDenied(db, ctx, "manual_node.access", "手动节点不存在或无权限", "manual_node", id);
      return fail("节点不存在", 404);
    }
    if (seg.length === 5 && method === "PUT") {
      const body = await readJson(req);
      const built = buildManualNode({ ...existing, ...body }, existing);
      if (built.error) return fail(built.error, 400);
      await userBatch(db, ctx, [
        db.prepare(
          `UPDATE user_manual_nodes SET name=?, protocol=?, server=?, port=?, uri=?, tier=?, enabled=?, remark=?,
                  updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`,
        ).bind(built.node.name, built.node.protocol, built.node.server, built.node.port, built.node.uri,
          built.node.tier, built.node.enabled, built.node.remark, id, ctx.effectiveId),
        auditStmt(db, ctx, {
          action: "manual_node.update", targetType: "manual_node", targetId: id,
          before: pickNode(existing), after: built.node,
        }),
      ]);
      return json({ ok: true, data: { id } });
    }
    if (seg.length === 5 && method === "DELETE") {
      await userBatch(db, ctx, [
        db.prepare("DELETE FROM user_manual_nodes WHERE id = ? AND user_id = ?").bind(id, ctx.effectiveId),
        db.prepare("DELETE FROM node_user_metadata WHERE user_id = ? AND node_kind = 'manual' AND node_id = ?").bind(ctx.effectiveId, id),
        db.prepare("DELETE FROM node_group_members WHERE user_id = ? AND node_kind = 'manual' AND node_id = ?").bind(ctx.effectiveId, id),
        auditStmt(db, ctx, { action: "manual_node.delete", targetType: "manual_node", targetId: id, before: pickNode(existing) }),
      ]);
      return json({ ok: true, data: { id } });
    }
    return fail("不支持的手动节点操作", 405);
  }

  const id = seg[3];
  if (!id || !validId(id)) return fail("节点 ID 无效", 400);

  if (seg.length === 4 && method === "GET") {
    const node = await loadSubscriptionNode(db, ctx, id);
    if (!node) {
      const manual = await loadManualNode(db, ctx, id);
      if (!manual) {
        await auditDenied(db, ctx, "node.access", "节点不存在或无权限", "node", id);
        return fail("节点不存在", 404);
      }
      return json({ ok: true, data: { kind: "manual", node: manual, effective: manual } });
    }
    const ovRows = await db.prepare("SELECT field_name, override_value, updated_at FROM node_overrides WHERE user_id = ? AND node_id = ?")
      .bind(ctx.effectiveId, id).all();
    const ov = overrideMap(ovRows.results);
    return json({ ok: true, data: { kind: "subscription", node, effective: composeEffective(node, ov, "subscription"), overrides: ov } });
  }

  if (seg.length === 5 && seg[4] === "effective" && method === "GET") {
    const node = await loadSubscriptionNode(db, ctx, id);
    if (!node) return fail("节点不存在", 404);
    const ovRows = await db.prepare("SELECT field_name, override_value FROM node_overrides WHERE user_id = ? AND node_id = ?")
      .bind(ctx.effectiveId, id).all();
    const ov = overrideMap(ovRows.results);
    return json({ ok: true, data: { effective: composeEffective(node, ov, "subscription"), overrides: ov } });
  }

  if (seg.length === 5 && seg[4] === "enabled" && method === "PATCH") {
    const body = await readJson(req);
    const enabled = parseBool01(body.enabled);
    if (enabled === null) return fail("enabled 只能是 true/false/1/0", 400);
    const node = await loadSubscriptionNode(db, ctx, id);
    if (node) {
      await userBatch(db, ctx, [
        db.prepare(
          `INSERT INTO node_overrides(user_id, node_id, field_name, override_value, updated_by)
           VALUES(?,?, 'enabled', ?, ?)
           ON CONFLICT(user_id, node_id, field_name) DO UPDATE SET
             override_value=excluded.override_value, updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`,
        ).bind(ctx.effectiveId, id, String(enabled), ctx.actorId),
        auditStmt(db, ctx, {
          action: "node.override.enabled", targetType: "node", targetId: id,
          before: { enabled: node.enabled }, after: { enabled },
        }),
      ]);
      return json({ ok: true, data: { id, enabled } });
    }
    const manual = await loadManualNode(db, ctx, id);
    if (!manual) return fail("节点不存在", 404);
    await userBatch(db, ctx, [
      db.prepare("UPDATE user_manual_nodes SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
        .bind(enabled, id, ctx.effectiveId),
      auditStmt(db, ctx, { action: "manual_node.enabled", targetType: "manual_node", targetId: id, before: { enabled: manual.enabled }, after: { enabled } }),
    ]);
    return json({ ok: true, data: { id, enabled } });
  }

  return fail("不支持的节点操作", 405);
}

function pickNode(row) {
  return {
    name: row.name, protocol: row.protocol, server: row.server, port: row.port,
    tier: row.tier, enabled: row.enabled, remark: row.remark,
  };
}

function buildManualNode(input, existing = null) {
  const name = s(input.name, 160);
  const protocol = s(input.protocol, 20).toLowerCase();
  const server = s(input.server, 255);
  const port = num(input.port, null);
  const tier = s(input.tier, 30) || (existing?.tier || "free");
  const uri = s(input.uri, 4000) || (existing?.uri || "");
  const remark = s(input.remark, 500);
  let enabled = existing ? existing.enabled : 1;
  if (input.enabled !== undefined) {
    const parsed = parseBool01(input.enabled);
    if (parsed === null) return { error: "enabled 只能是 true/false/1/0" };
    enabled = parsed;
  }

  if (!name) return { error: "节点名称不能为空" };
  if (!ALLOWED_PROTOCOLS.has(protocol)) return { error: "协议必须是 vless/vmess/trojan/ss" };
  if (!server || /[\s]/.test(server) || server.length > 253) return { error: "服务器地址不合法" };
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: "端口必须是 1-65535 的整数" };
  if (!/^[A-Za-z0-9_-]{1,30}$/.test(tier)) return { error: "tier 格式不正确" };
  if (uri && uri.length > 4000) return { error: "uri 过长" };
  if (uri && !/^(vless|vmess|trojan|ss):\/\//i.test(uri)) return { error: "uri 必须是 vless/vmess/trojan/ss 链接" };
  return { node: { name, protocol, server, port, tier, uri, remark, enabled } };
}

/* ────────────────────────────── 用户态：字段覆盖 ────────────────────────────── */

async function userOverridesRoute(req, env, url, ctx) {
  const db = env.DB;
  const method = req.method;
  const seg = url.pathname.split("/").filter(Boolean);   // api,user,nodes,:id,overrides,:field
  const nodeId = seg[3];
  if (!nodeId || !validId(nodeId)) return fail("节点 ID 无效", 400);

  const node = await loadSubscriptionNode(db, ctx, nodeId);
  if (!node) {
    await auditDenied(db, ctx, "node.override.access", "节点不存在或无权限", "node", nodeId);
    return fail("节点不存在", 404);
  }

  if (seg.length === 5 && seg[4] === "overrides" && method === "GET") {
    const rows = await db.prepare(
      "SELECT field_name, override_value, updated_by, updated_at, reason FROM node_overrides WHERE user_id = ? AND node_id = ?",
    ).bind(ctx.effectiveId, nodeId).all();
    return json({ ok: true, data: rows.results || [] });
  }

  const field = seg[5];
  if (seg.length === 6 && seg[4] === "overrides") {
    if (!ALLOWED_OVERRIDE_FIELDS.has(field)) return fail("该字段不允许覆盖", 400);

    if (method === "PUT") {
      const body = await readJson(req);
      const checked = validateOverrideValue(field, body.value ?? body[field]);
      if (checked.error) return fail(checked.error, 400);
      const before = composeEffective(node, overrideMap(
        (await db.prepare("SELECT field_name, override_value FROM node_overrides WHERE user_id = ? AND node_id = ?")
          .bind(ctx.effectiveId, nodeId).all()).results,
      ), "subscription");

      await userBatch(db, ctx, [
        db.prepare(
          `INSERT INTO node_overrides(user_id, node_id, field_name, override_value, updated_by, reason)
           VALUES(?,?,?,?,?,?)
           ON CONFLICT(user_id, node_id, field_name) DO UPDATE SET
             override_value=excluded.override_value, updated_by=excluded.updated_by,
             updated_at=CURRENT_TIMESTAMP, reason=excluded.reason`,
        ).bind(ctx.effectiveId, nodeId, field, checked.value, ctx.actorId, s(body.reason, 200)),
        auditStmt(db, ctx, {
          action: "node.override.set", targetType: "node", targetId: nodeId,
          before: { [field]: before[field] }, after: { [field]: checked.value }, reason: s(body.reason, 200),
        }),
      ]);
      return json({ ok: true, data: { node_id: nodeId, field, value: checked.value } });
    }

    if (method === "DELETE") {
      const existing = await db.prepare(
        "SELECT override_value FROM node_overrides WHERE user_id = ? AND node_id = ? AND field_name = ?",
      ).bind(ctx.effectiveId, nodeId, field).first();
      if (!existing) return fail("该字段没有覆盖记录", 404);
      await userBatch(db, ctx, [
        db.prepare("DELETE FROM node_overrides WHERE user_id = ? AND node_id = ? AND field_name = ?")
          .bind(ctx.effectiveId, nodeId, field),
        auditStmt(db, ctx, {
          action: "node.override.remove", targetType: "node", targetId: nodeId,
          before: { [field]: existing.override_value }, after: { [field]: node[field] },
        }),
      ]);
      return json({ ok: true, data: { node_id: nodeId, field, restored: node[field] } });
    }
  }
  return fail("不支持的覆盖操作", 405);
}

function validateOverrideValue(field, raw) {
  switch (field) {
    case "name": {
      const v = s(raw, 160);
      if (!v) return { error: "名称不能为空" };
      return { value: v };
    }
    case "protocol": {
      const v = s(raw, 20).toLowerCase();
      if (!ALLOWED_PROTOCOLS.has(v)) return { error: "协议必须是 vless/vmess/trojan/ss" };
      return { value: v };
    }
    case "server": {
      const v = s(raw, 253);
      if (!v || /[\s]/.test(v)) return { error: "服务器地址不合法" };
      return { value: v };
    }
    case "port": {
      const v = Number(raw);
      if (!Number.isInteger(v) || v < 1 || v > 65535) return { error: "端口必须是 1-65535 的整数" };
      return { value: String(v) };
    }
    case "tier": {
      const v = s(raw, 30);
      if (!/^[A-Za-z0-9_-]{1,30}$/.test(v)) return { error: "tier 格式不正确" };
      return { value: v };
    }
    case "enabled": {
      const v = raw === true || raw === 1 || raw === "1" ? "1" : raw === false || raw === 0 || raw === "0" ? "0" : null;
      if (v === null) return { error: "enabled 只能是 0/1 或布尔值" };
      return { value: v };
    }
    default:
      return { error: "该字段不允许覆盖" };
  }
}

/* ────────────────────────────── 用户态：分组 / 备注元数据 ────────────────────────────── */

async function userGroupsRoute(req, env, url, ctx) {
  const db = env.DB;
  const method = req.method;
  const seg = url.pathname.split("/").filter(Boolean);   // api,user,node-groups,...

  if (seg.length === 3 && method === "GET") {
    const rows = await db.prepare(
      `SELECT g.*, (SELECT COUNT(*) FROM node_group_members m WHERE m.user_id = g.user_id AND m.group_id = g.id) AS member_count
         FROM node_groups g WHERE g.user_id = ? ORDER BY g.sort_order ASC, g.created_at ASC`,
    ).bind(ctx.effectiveId).all();
    return json({ ok: true, data: rows.results || [] });
  }

  if (seg.length === 3 && method === "POST") {
    const body = await readJson(req);
    const name = s(body.name, 60);
    if (!name) return fail("分组名称不能为空", 400);
    const sortOrder = num(body.sort_order, 0);
    if (!Number.isInteger(sortOrder) || Math.abs(sortOrder) > 1_000_000) return fail("sort_order 不合法", 400);
    const id = newId();
    await userBatch(db, ctx, [
      db.prepare("INSERT INTO node_groups(id, user_id, name, sort_order, remark) VALUES(?,?,?,?,?)")
        .bind(id, ctx.effectiveId, name, sortOrder, s(body.remark, 200)),
      auditStmt(db, ctx, { action: "group.create", targetType: "group", targetId: id, after: { name, sort_order: sortOrder } }),
    ]);
    return json({ ok: true, data: { id } }, 201);
  }

  const groupId = seg[3];
  if (!groupId || !validId(groupId)) return fail("分组 ID 无效", 400);
  const group = await db.prepare("SELECT * FROM node_groups WHERE id = ? AND user_id = ?")
    .bind(groupId, ctx.effectiveId).first();
  if (!group) {
    await auditDenied(db, ctx, "group.access", "分组不存在或无权限", "group", groupId);
    return fail("分组不存在", 404);
  }

  if (seg.length === 4 && method === "PUT") {
    const body = await readJson(req);
    const name = s(body.name, 60) || group.name;
    const sortOrder = body.sort_order === undefined ? group.sort_order : num(body.sort_order, group.sort_order);
    if (!Number.isInteger(sortOrder)) return fail("sort_order 不合法", 400);
    const remark = body.remark === undefined ? group.remark : s(body.remark, 200);
    await userBatch(db, ctx, [
      db.prepare("UPDATE node_groups SET name=?, sort_order=?, remark=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?")
        .bind(name, sortOrder, remark, groupId, ctx.effectiveId),
      auditStmt(db, ctx, {
        action: "group.update", targetType: "group", targetId: groupId,
        before: { name: group.name, sort_order: group.sort_order }, after: { name, sort_order: sortOrder },
      }),
    ]);
    return json({ ok: true, data: { id: groupId } });
  }

  if (seg.length === 4 && method === "DELETE") {
    await userBatch(db, ctx, [
      db.prepare("DELETE FROM node_groups WHERE id = ? AND user_id = ?").bind(groupId, ctx.effectiveId),
      db.prepare("DELETE FROM node_group_members WHERE group_id = ? AND user_id = ?").bind(groupId, ctx.effectiveId),
      auditStmt(db, ctx, { action: "group.delete", targetType: "group", targetId: groupId, before: { name: group.name } }),
    ]);
    return json({ ok: true, data: { id: groupId } });
  }

  if (seg.length === 5 && seg[4] === "members") {
    if (method === "POST") {
      const body = await readJson(req);
      const kind = s(body.node_kind, 20);
      const nodeId = s(body.node_id, 80);
      if (!["subscription", "manual"].includes(kind)) return fail("node_kind 必须是 subscription 或 manual", 400);
      if (!validId(nodeId)) return fail("node_id 无效", 400);
      // 关键：验证节点真实归属，不能只信 group_id
      const owned = kind === "subscription"
        ? await loadSubscriptionNode(db, ctx, nodeId)
        : await loadManualNode(db, ctx, nodeId);
      if (!owned) {
        await auditDenied(db, ctx, "group.member.add", "节点不存在或不属于当前用户", "node", nodeId);
        return fail("节点不存在", 404);
      }
      await userBatch(db, ctx, [
        db.prepare("INSERT OR IGNORE INTO node_group_members(user_id, group_id, node_kind, node_id) VALUES(?,?,?,?)")
          .bind(ctx.effectiveId, groupId, kind, nodeId),
        auditStmt(db, ctx, { action: "group.member.add", targetType: "group", targetId: groupId, after: { node_kind: kind, node_id: nodeId } }),
      ]);
      return json({ ok: true, data: { group_id: groupId, node_kind: kind, node_id: nodeId } }, 201);
    }
    if (method === "DELETE") {
      const kind = s(url.searchParams.get("node_kind"), 20);
      const nodeId = s(url.searchParams.get("node_id"), 80);
      if (!["subscription", "manual"].includes(kind) || !validId(nodeId)) return fail("参数无效", 400);
      await userBatch(db, ctx, [
        db.prepare("DELETE FROM node_group_members WHERE user_id = ? AND group_id = ? AND node_kind = ? AND node_id = ?")
          .bind(ctx.effectiveId, groupId, kind, nodeId),
        auditStmt(db, ctx, { action: "group.member.remove", targetType: "group", targetId: groupId, before: { node_kind: kind, node_id: nodeId } }),
      ]);
      return json({ ok: true, data: { group_id: groupId, node_kind: kind, node_id: nodeId } });
    }
  }

  return fail("不支持的分组操作", 405);
}

async function userMetadataRoute(req, env, url, ctx) {
  const db = env.DB;
  if (req.method !== "PUT") return fail("只支持 PUT", 405);
  const seg = url.pathname.split("/").filter(Boolean);   // api,user,nodes,:id,metadata
  const nodeId = seg[3];
  if (!nodeId || !validId(nodeId)) return fail("节点 ID 无效", 400);

  const found = await loadAnyNode(db, ctx, nodeId);
  if (!found) {
    await auditDenied(db, ctx, "node.metadata", "节点不存在或无权限", "node", nodeId);
    return fail("节点不存在", 404);
  }
  const body = await readJson(req);
  // 部分更新：未传的字段保留原值，避免“只改备注把收藏/排序清空”
  const prev = await db.prepare(
    "SELECT remark, favorite, sort_order FROM node_user_metadata WHERE user_id = ? AND node_kind = ? AND node_id = ?",
  ).bind(ctx.effectiveId, found.kind, nodeId).first();
  const remark = body.remark === undefined ? (prev?.remark ?? "") : s(body.remark, 500);
  let favorite = prev?.favorite ?? 0;
  if (body.favorite !== undefined) {
    const parsed = parseBool01(body.favorite);
    if (parsed === null) return fail("favorite 只能是 true/false/1/0", 400);
    favorite = parsed;
  }
  const sortOrder = body.sort_order === undefined ? (prev?.sort_order ?? 0) : num(body.sort_order, NaN);
  if (!Number.isInteger(sortOrder) || Math.abs(sortOrder) > 1_000_000) return fail("sort_order 不合法", 400);

  await userBatch(db, ctx, [
    db.prepare(
      `INSERT INTO node_user_metadata(user_id, node_kind, node_id, remark, favorite, sort_order)
       VALUES(?,?,?,?,?,?)
       ON CONFLICT(user_id, node_kind, node_id) DO UPDATE SET
         remark=excluded.remark, favorite=excluded.favorite, sort_order=excluded.sort_order, updated_at=CURRENT_TIMESTAMP`,
    ).bind(ctx.effectiveId, found.kind, nodeId, remark, favorite, sortOrder),
    auditStmt(db, ctx, {
      action: "node.metadata", targetType: "node", targetId: nodeId,
      after: { node_kind: found.kind, remark, favorite, sort_order: sortOrder },
    }),
  ]);
  return json({ ok: true, data: { node_id: nodeId, node_kind: found.kind, remark, favorite, sort_order: sortOrder } });
}

/* ────────────────────────────── 总管理员 ────────────────────────────── */

async function superRoute(req, env, url, ctx) {
  const db = env.DB;
  const method = req.method;
  const seg = url.pathname.split("/").filter(Boolean);   // api,super,...

  if (!ctx || !ctx.isSuper) {
    await auditDenied(db, ctx || { actorId: null, effectiveId: null, requestId: "" }, "super.access", "非超级管理员", "path", url.pathname);
    return fail("需要超级管理员权限", 403);
  }
  // 纵深防御：即使路由层被改动，协助会话也不能在这里通过
  // 例外：结束自己的协助会话
  const selfEnd = url.pathname === "/api/super/impersonation/end" && req.method === "POST" && !!ctx.session;
  if (ctx.actorId !== ctx.effectiveId && !selfEnd) {
    await auditDenied(db, ctx, "super.access", "协助会话不得访问总后台", "path", url.pathname);
    return fail("协助会话不能访问总管理员接口", 403, { code: "IMPERSONATION_FORBIDDEN" });
  }

  if (seg[2] === "users" && seg.length === 3) {
    if (method === "GET") {
      const paging = parsePaging(url.searchParams);
      if (paging.error) return fail(paging.error, 400);
      const total = await db.prepare("SELECT COUNT(*) AS total FROM app_users").first();
      const rows = await db.prepare(
        `SELECT u.id, u.username, u.display_name, u.role, u.status, u.created_at, u.last_login_at,
                (SELECT COUNT(*) FROM source_ownership so WHERE so.user_id = u.id) AS source_count
           FROM app_users u ORDER BY u.created_at ASC LIMIT ? OFFSET ?`,
      ).bind(paging.limit, paging.offset).all();
      return json({ ok: true, data: rows.results || [], total: Number(total?.total || 0), limit: paging.limit, offset: paging.offset });
    }
    if (method === "POST") {
      const body = await readJson(req);
      const username = s(body.username, 32).toLowerCase();
      const password = String(body.password ?? "");
      const role = s(body.role, 20) || "user";
      if (!USERNAME_RE.test(username)) return fail("用户名格式不正确", 400);
      if (password.length < 10) return fail("密码至少 10 位", 400);
      if (!["user", "super_admin"].includes(role)) return fail("role 不合法", 400);
      if (await db.prepare("SELECT id FROM app_users WHERE username = ?").bind(username).first()) {
        return fail("用户名已存在", 409);
      }
      const id = newId();
      const hash = await hashPassword(password);
      await userBatch(db, ctx, [
        db.prepare("INSERT INTO app_users(id, username, display_name, password_hash, role, status) VALUES(?,?,?,?,?, 'active')")
          .bind(id, username, s(body.display_name, 60), hash, role),
        auditStmt(db, ctx, { action: "super.user.create", targetType: "user", targetId: id, after: { username, role } }),
      ]);
      if (role === "user") await grantTrial(db, id).catch(() => {});
      return json({ ok: true, data: { id, username, role, trial_days: role === "user" ? VIP_TRIAL_DAYS : 0 } }, 201);
    }
  }

  if (seg[2] === "users" && seg.length === 4 && method === "PUT") {
    const targetId = seg[3];
    if (!validId(targetId)) return fail("用户 ID 无效", 400);
    const target = await db.prepare("SELECT id, role, status, display_name FROM app_users WHERE id = ?").bind(targetId).first();
    if (!target) return fail("用户不存在", 404);
    const body = await readJson(req);
    const status = s(body.status, 20) || target.status;
    const role = s(body.role, 20) || target.role;
    if (!["active", "disabled", "locked"].includes(status)) return fail("status 不合法", 400);
    if (!["user", "super_admin"].includes(role)) return fail("role 不合法", 400);

    // 防锁死：把“是否还有别的有效超管”做成 batch 内的断言，消除“先查后改”的并发窗口
    const losingSuper = target.role === "super_admin" && (role !== "super_admin" || status !== "active");
    const stmts = [
      db.prepare("UPDATE app_users SET status=?, role=?, display_name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(status, role, s(body.display_name, 60) || target.display_name, targetId),
      auditStmt(db, ctx, {
        action: "super.user.update", targetType: "user", targetId,
        before: { role: target.role, status: target.status }, after: { role, status },
      }),
    ];
    if (status !== "active") {
      stmts.push(db.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL").bind(targetId));
    }
    if (body.password) {
      const pw = String(body.password);
      if (pw.length < 10) return fail("密码至少 10 位", 400);
      stmts.push(db.prepare("UPDATE app_users SET password_hash=? WHERE id=?").bind(await hashPassword(pw), targetId));
      stmts.push(db.prepare("UPDATE user_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=? AND revoked_at IS NULL").bind(targetId));
    }
    if (losingSuper) {
      stmts.unshift(assertStmt(
        db,
        "EXISTS (SELECT 1 FROM app_users WHERE role='super_admin' AND status='active' AND id <> ?)",
        [targetId],
      ));
    }
    try {
      await userBatch(db, ctx, stmts);
    } catch (e) {
      if (/assert-failed|malformed JSON/i.test(String(e?.message || ""))) {
        await auditDenied(db, ctx, "super.user.update", "最后一个总管理员不可降级/停用", "user", targetId);
        return fail("这是最后一个有效总管理员，不能降级或停用；请先创建另一个总管理员", 409, { code: "LAST_SUPER_ADMIN" });
      }
      throw e;
    }
    return json({ ok: true, data: { id: targetId, status, role } });
  }

  if (seg[2] === "users" && seg.length === 5 && seg[4] === "overview" && method === "GET") {
    const targetId = s(seg[3], 80);
    if (!validId(targetId)) return fail("用户 ID 无效", 400);
    if (!(await db.prepare("SELECT 1 AS ok FROM app_users WHERE id = ?").bind(targetId).first())) return fail("用户不存在", 404);
    const counts = await db.prepare(
      `SELECT
        (SELECT COUNT(*) FROM subscription_sources s JOIN source_ownership so ON so.source_id=s.id WHERE so.user_id=?) AS sources,
        (SELECT COUNT(*) FROM node_records n JOIN source_ownership so ON so.source_id=n.source_id WHERE so.user_id=?) AS subscription_nodes,
        (SELECT COUNT(*) FROM user_manual_nodes WHERE user_id=?) AS manual_nodes,
        (SELECT COUNT(*) FROM node_groups WHERE user_id=?) AS groups,
        (SELECT COUNT(*) FROM node_overrides WHERE user_id=?) AS overrides`,
    ).bind(targetId, targetId, targetId, targetId, targetId).first();
    return json({ ok: true, data: counts || {} });
  }

  if (seg[2] === "users" && seg.length === 5 && seg[4] === "nodes" && method === "GET") {
    const targetId = s(seg[3], 80);
    if (!validId(targetId)) return fail("用户 ID 无效", 400);
    if (!(await db.prepare("SELECT 1 AS ok FROM app_users WHERE id = ?").bind(targetId).first())) return fail("用户不存在", 404);
    const p = Object.fromEntries(url.searchParams.entries());
    const paging = parsePaging(p);
    if (paging.error) return fail(paging.error, 400);
    const { limit, offset } = paging;
    const listCtx = { ...ctx, effectiveId: targetId };
    const q = buildNodeListQuery(listCtx, p);
    const total = await db.prepare(q.countSql).bind(...q.countBinds).first();
    const rows = await db.prepare(q.selectSql).bind(...q.selectBinds.slice(0, -2), limit, offset).all();
    return json({ ok: true, data: rows.results || [], total: Number(total?.total || 0), limit, offset, user_id: targetId });
  }

  if (seg[2] === "audit" && method === "GET") {
    const limitR = intParam(url.searchParams.get("limit"), { min: 1, max: 200, def: 50, name: "limit" });
    if (limitR.error) return fail(limitR.error, 400);
    const limit = limitR.value;
    const actor = s(url.searchParams.get("actor_user_id"), 80);
    const rows = actor
      ? await db.prepare("SELECT * FROM admin_audit_events WHERE actor_user_id = ? ORDER BY id DESC LIMIT ?").bind(actor, limit).all()
      : await db.prepare("SELECT * FROM admin_audit_events ORDER BY id DESC LIMIT ?").bind(limit).all();
    return json({ ok: true, data: rows.results || [] });
  }

  if (seg[2] === "users" && seg.length === 5 && seg[4] === "scopes" && method === "POST") {
    const targetId = s(seg[3], 80);
    const body = await readJson(req);
    const scope = s(body.scope, 20);
    if (!ALLOWED_SCOPES.has(scope)) return fail("scope 必须是 read/operate/manage", 400);
    const target = await db.prepare("SELECT id FROM app_users WHERE id = ?").bind(targetId).first();
    if (!target) return fail("目标用户不存在", 404);
    // 有效期规则：不传=24h；1-720=指定小时；0/负数/非整数=拒绝；永久必须显式 permanent + reason
    let permanent = false;
    let expiresModifier = "+24 hours";
    if (body.permanent === true) {
      if (!s(body.reason, 200)) return fail("永久授权必须填写 reason", 400);
      permanent = true;
    } else if (body.expires_in_hours !== undefined) {
      const hours = Number(body.expires_in_hours);
      if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
        return fail("expires_in_hours 必须是 1-720 的整数；永久授权请显式传 permanent=true", 400);
      }
      expiresModifier = `+${hours} hours`;
    }
    // 已有一条“仍然有效”的相同授权 → 直接拒绝（避免唯一索引冲突变成 500）
    const activeDup = await db.prepare(
      `SELECT id FROM admin_user_scopes
        WHERE admin_user_id = ? AND target_user_id = ? AND scope = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
    ).bind(ctx.actorId, targetId, scope).first();
    if (activeDup) return fail("已存在有效的相同授权，请先撤销或等待过期", 409, { code: "SCOPE_ALREADY_ACTIVE" });

    const id = newId();
    try {
      await userBatch(db, ctx, [
      // 先把这个 (admin,target,scope) 下“已过期但未撤销”的记录置为 revoked，释放唯一索引
      db.prepare(
        `UPDATE admin_user_scopes SET revoked_at = CURRENT_TIMESTAMP
          WHERE admin_user_id = ? AND target_user_id = ? AND scope = ? AND revoked_at IS NULL
            AND expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')`,
      ).bind(ctx.actorId, targetId, scope),
      db.prepare(
        `INSERT INTO admin_user_scopes(id, admin_user_id, target_user_id, scope, granted_by, reason, expires_at)
         VALUES(?,?,?,?,?,?, CASE WHEN ? = 1 THEN NULL ELSE datetime('now', ?) END)`,
      ).bind(id, ctx.actorId, targetId, scope, ctx.actorId, s(body.reason, 200), permanent ? 1 : 0, expiresModifier),
      auditStmt(db, ctx, {
        action: "super.scope.grant", targetType: "user", targetId,
        after: { scope, permanent, expires: permanent ? null : expiresModifier, reason: s(body.reason, 200) },
        detail: permanent ? "永久授权" : "限时授权",
      }),
      ]);
    } catch (e) {
      if (/UNIQUE|constraint/i.test(String(e?.message || ""))) {
        return fail("并发授权冲突：已存在相同有效授权", 409, { code: "SCOPE_ALREADY_ACTIVE" });
      }
      throw e;
    }
    return json({ ok: true, data: { id, target_user_id: targetId, scope, permanent, expires: permanent ? null : expiresModifier } }, 201);
  }

  if (seg[2] === "scopes" && seg.length === 4 && method === "DELETE") {
    const scopeId = s(seg[3], 80);
    const row = await db.prepare("SELECT * FROM admin_user_scopes WHERE id = ?").bind(scopeId).first();
    if (!row) return fail("授权不存在", 404);
    await userBatch(db, ctx, [
      db.prepare("UPDATE admin_user_scopes SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").bind(scopeId),
      db.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE scope_id = ? AND revoked_at IS NULL").bind(scopeId),
      auditStmt(db, ctx, {
        action: "super.scope.revoke", targetType: "user", targetId: row.target_user_id,
        before: { scope: row.scope },
      }),
    ]);
    return json({ ok: true, data: { id: scopeId, revoked: true } });
  }

  if (seg[2] === "source-quotas" && method === "GET") {
    const paging = parsePaging(url.searchParams);
    if (paging.error) return fail(paging.error, 400);
    const q = s(url.searchParams.get("q"), 100);
    const filter = s(url.searchParams.get("filter"), 20) || "all";
    const sort = s(url.searchParams.get("sort"), 20) || "expires";
    if (!["all", "expiring", "low"].includes(filter)) return fail("filter 只能是 all/expiring/low", 400);
    if (!["expires", "remaining", "name", "updated"].includes(sort)) return fail("sort 只能是 expires/remaining/name/updated", 400);

    const where = [], binds = [];
    if (q) {
      where.push("(s.name LIKE ? OR s.remark LIKE ? OR q.profile_title LIKE ?)");
      binds.push(`%${q}%`, `%${q}%`, `%${q}%`);
    }
    if (filter === "expiring") {
      where.push("q.expires_at IS NOT NULL AND datetime(q.expires_at) <= datetime('now', '+7 days')");
    }
    if (filter === "low") {
      where.push("q.total_bytes > 0 AND q.remaining_bytes IS NOT NULL AND q.remaining_bytes * 10 <= q.total_bytes");
    }
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
    const orderSql = sort === "remaining"
      ? "ORDER BY q.remaining_bytes IS NULL, q.remaining_bytes ASC, s.name ASC"
      : sort === "name"
        ? "ORDER BY s.name ASC"
        : sort === "updated"
          ? "ORDER BY q.last_success_at IS NULL, q.last_success_at DESC, s.name ASC"
          : "ORDER BY q.expires_at IS NULL, q.expires_at ASC, s.name ASC";

    const total = await db.prepare(
      `SELECT COUNT(*) AS total FROM subscription_sources s LEFT JOIN source_quota q ON q.source_id = s.id${whereSql}`,
    ).bind(...binds).first();
    const rows = await db.prepare(
      `SELECT s.id AS source_id, s.name, s.remark, s.enabled, s.priority, s.tier,
              q.profile_title, q.total_bytes, q.upload_bytes, q.download_bytes, q.used_bytes,
              q.remaining_bytes, q.expires_at, q.status, q.last_success_at, q.last_attempt_at, q.error_message
         FROM subscription_sources s LEFT JOIN source_quota q ON q.source_id = s.id
         ${whereSql} ${orderSql} LIMIT ? OFFSET ?`,
    ).bind(...binds, paging.limit, paging.offset).all();

    const now = Date.now();
    const data = (rows.results || []).map(r => ({
      ...r,
      has_data: r.last_success_at !== null && r.last_success_at !== undefined,
      days_left: (() => {
        if (!r.expires_at) return null;
        const t = Date.parse(String(r.expires_at).replace(" ", "T") + "Z");
        return Number.isFinite(t) ? Math.ceil((t - now) / 86400000) : null;
      })(),
    }));
    return json({ ok: true, data, total: Number(total?.total || 0), limit: paging.limit, offset: paging.offset });
  }

  if (seg[2] === "sources" && seg.length === 5 && seg[4] === "quota" && method === "GET") {
    const sourceId = s(seg[3], 80);
    if (!validId(sourceId)) return fail("来源 ID 无效", 400);
    const row = await db.prepare(
      `SELECT s.id AS source_id, s.name, s.remark, s.enabled, s.priority, s.tier,
              q.profile_title, q.total_bytes, q.upload_bytes, q.download_bytes, q.used_bytes,
              q.remaining_bytes, q.expires_at, q.status, q.last_success_at, q.last_attempt_at, q.error_message
         FROM subscription_sources s LEFT JOIN source_quota q ON q.source_id = s.id
        WHERE s.id = ?`,
    ).bind(sourceId).first();
    if (!row) return fail("订阅源不存在", 404);
    const now = Date.now();
    return json({
      ok: true,
      data: {
        ...row,
        has_data: row.last_success_at !== null && row.last_success_at !== undefined,
        days_left: (() => {
        if (!row.expires_at) return null;
        const t = Date.parse(String(row.expires_at).replace(" ", "T") + "Z");
        return Number.isFinite(t) ? Math.ceil((t - now) / 86400000) : null;
      })(),
      },
    });
  }

  if (seg[2] === "app-entitlements" && seg.length === 3 && method === "GET") {
    const paging = parsePaging(url.searchParams);
    if (paging.error) return fail(paging.error, 400);
    const status = s(url.searchParams.get("status"), 20);
    const where = status ? " WHERE status = ?" : "";
    const binds = status ? [status] : [];
    const total = await db.prepare(`SELECT COUNT(*) AS total FROM app_entitlements${where}`).bind(...binds).first();
    const rows = await db.prepare(
      `SELECT e.id, e.admin_user_id, e.device_id, e.status, e.starts_at, e.expires_at, e.purge_at,
              u.username AS admin_name,
              CAST(ROUND((julianday(e.expires_at) - julianday('now'))) AS INTEGER) AS days_left
         FROM app_entitlements e LEFT JOIN app_users u ON u.id = e.admin_user_id
         ${where} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, paging.limit, paging.offset).all();
    return json({ ok: true, data: rows.results || [], total: Number(total?.total || 0), limit: paging.limit, offset: paging.offset });
  }

  if (seg[2] === "convert-links" && seg.length === 3 && method === "GET") {
    const paging = parsePaging(url.searchParams);
    if (paging.error) return fail(paging.error, 400);
    const group = s(url.searchParams.get("group"), 60);
    const where = group ? " WHERE group_name = ?" : "";
    const binds = group ? [group] : [];
    const total = await db.prepare(`SELECT COUNT(*) AS total FROM convert_links${where}`).bind(...binds).first();
    const rows = await db.prepare(
      `SELECT id, targets, group_name, owner_user_id, hits, created_at, last_used_at, expires_at, revoked_at,
              (SELECT COUNT(*) FROM convert_links) AS _all
         FROM convert_links${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, paging.limit, paging.offset).all();
    const groups = await db.prepare(
      "SELECT group_name, COUNT(*) AS n FROM convert_links GROUP BY group_name ORDER BY n DESC",
    ).all();
    return json({
      ok: true,
      data: (rows.results || []).map(r => {
        const { _all, ...rest } = r;
        return rest;
      }),
      groups: groups.results || [],
      total: Number(total?.total || 0), limit: paging.limit, offset: paging.offset,
    });
  }

  if (seg[2] === "convert-links" && seg.length === 5 && seg[4] === "group" && method === "PATCH") {
    const id = s(seg[3], 40);
    const body = await readJson(req);
    const group = s(body.group, 60);
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(group) && !/^[\u4e00-\u9fa5A-Za-z0-9 _-]{1,30}$/.test(group)) {
      return fail("分组名只能是 1-30 位中英文/数字/空格/下划线", 400);
    }
    const row = await db.prepare("SELECT id, group_name FROM convert_links WHERE id = ?").bind(id).first();
    if (!row) return fail("链接不存在", 404);
    await userBatch(db, ctx, [
      db.prepare("UPDATE convert_links SET group_name = ? WHERE id = ?").bind(group, id),
      auditStmt(db, ctx, {
        action: "convert.regroup", targetType: "convert_link", targetId: id,
        before: { group: row.group_name }, after: { group },
      }),
    ]);
    return json({ ok: true, data: { id, group } });
  }

  if (seg[2] === "convert-groups" && seg.length === 4 && seg[3] === "rename" && method === "POST") {
    const body = await readJson(req);
    const from = s(body.from, 60), to = s(body.to, 60);
    if (!from || !to) return fail("原分组名和新分组名都要填", 400);
    if (!/^[\u4e00-\u9fa5A-Za-z0-9 _-]{1,30}$/.test(to)) return fail("新分组名不合法", 400);
    const res = await db.prepare("UPDATE convert_links SET group_name = ? WHERE group_name = ?").bind(to, from).run();
    const changed = Number(res.meta?.changes || 0);
    if (changed) {
      await userBatch(db, ctx, [auditStmt(db, ctx, {
        action: "convert.group.rename", targetType: "convert_group", targetId: from,
        before: { from }, after: { to, links: changed },
      })]);
    }
    return json({ ok: true, data: { from, to, links: changed } });
  }

  // 超级管理员查看原始订阅源（含 token，默认脱敏，reveal=1 才给完整值；每次查看写审计）
  if (seg[2] === "convert-links" && seg.length === 5 && seg[4] === "sources" && method === "GET") {
    const id = s(seg[3], 40);
    if (!/^[A-Za-z0-9]{6,40}$/.test(id)) return fail("链接 ID 无效", 400);
    const row = await db.prepare("SELECT payload, group_name, owner_user_id, owner_key, created_at, expires_at FROM convert_links WHERE id = ?").bind(id).first();
    if (!row) return fail("链接不存在", 404);
    let data;
    try { data = await openJson(env, row.payload); } catch { return fail("无法解密该记录", 500); }
    const reveal = url.searchParams.get("reveal") === "1";
    const sources = (data.sources || []).map(x => ({
      url: reveal ? x.url : maskSubscriptionUrl(x.url),
      nodes: x.nodes ?? null, error: x.error || null,
    }));
    if (reveal) {
      await auditStmt(db, ctx, {
        action: "convert.sources.reveal", targetType: "convert_link", targetId: id,
        detail: `完整订阅源 ${sources.length} 条`,
      }).run().catch(() => {});
    }
    return json({
      ok: true,
      data: {
        id, group: row.group_name, owner: row.owner_user_id || row.owner_key || null,
        created_at: row.created_at, expires_at: row.expires_at,
        sources, revealed: reveal,
      },
    });
  }

  if (seg[2] === "convert-links" && seg.length === 5 && seg[4] === "revoke" && method === "POST") {
    const id = s(seg[3], 40);
    if (!/^[A-Za-z0-9]{6,40}$/.test(id)) return fail("链接 ID 无效", 400);
    const row = await db.prepare("SELECT id, group_name, revoked_at FROM convert_links WHERE id = ?").bind(id).first();
    if (!row) return fail("链接不存在", 404);
    if (row.revoked_at) return json({ ok: true, data: { id, revoked_at: row.revoked_at, already: true } });
    await userBatch(db, ctx, [
      db.prepare("UPDATE convert_links SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id),
      auditStmt(db, ctx, {
        action: "convert.revoke", targetType: "convert_link", targetId: id,
        before: { revoked_at: null }, after: { revoked_at: "now" }, detail: `group=${row.group_name}`,
      }),
    ]);
    return json({ ok: true, data: { id, revoked: true } });
  }

  if (seg[2] === "source-approvals" && method === "GET") {
    const status = s(url.searchParams.get("status"), 20) || "pending";
    if (!["pending", "approved", "rejected", "all"].includes(status)) return fail("status 不合法", 400);
    const rows = status === "all"
      ? await db.prepare(
        `SELECT a.*, s.name, s.url, s.tier, s.enabled, s.priority, s.created_at AS source_created_at
           FROM source_approvals a LEFT JOIN subscription_sources s ON s.id = a.source_id
          ORDER BY a.created_at DESC LIMIT 100`).all()
      : await db.prepare(
        `SELECT a.*, s.name, s.url, s.tier, s.enabled, s.priority, s.created_at AS source_created_at
           FROM source_approvals a LEFT JOIN subscription_sources s ON s.id = a.source_id
          WHERE a.status = ? ORDER BY a.created_at DESC LIMIT 100`).bind(status).all();
    return json({
      ok: true,
      data: (rows.results || []).map(r => ({ ...r, url: r.url ? maskSubscriptionUrl(r.url) : null })),
    });
  }

  if (seg[2] === "sources" && seg.length === 5 && (seg[4] === "approve" || seg[4] === "reject") && method === "POST") {
    const sourceId = s(seg[3], 80);
    if (!validId(sourceId)) return fail("来源 ID 无效", 400);
    const body = await readJson(req, { allowEmpty: true });
    const source = await db.prepare("SELECT id, name FROM subscription_sources WHERE id = ?").bind(sourceId).first();
    if (!source) return fail("订阅源不存在", 404);
    const approval = await db.prepare("SELECT status FROM source_approvals WHERE source_id = ?").bind(sourceId).first();
    if (!approval) return fail("该订阅源没有待审核记录（既有来源默认已批准）", 409);
    const approve = seg[4] === "approve";
    const reason = s(body.reason, 200);
    if (!approve && !reason) return fail("拒绝必须填写原因", 400);
    // 审批只决定"能不能用"，不碰运营开关：
    // - 通过：不改 enabled（避免把管理员手动停用的来源重新启用）
    // - 拒绝：强制停用（不能继续同步）
    const stmts = [
      db.prepare(
        `UPDATE source_approvals SET status = ?, reviewed_by = ?, reviewed_at = CURRENT_TIMESTAMP, reason = ?
          WHERE source_id = ?`,
      ).bind(approve ? "approved" : "rejected", ctx.actorId, reason, sourceId),
    ];
    if (!approve) {
      stmts.push(
        db.prepare("UPDATE subscription_sources SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .bind(sourceId),
      );
    }
    stmts.push(auditStmt(db, ctx, {
      action: approve ? "super.source.approve" : "super.source.reject",
      targetType: "source", targetId: sourceId,
      before: { approval: approval.status }, after: { approval: approve ? "approved" : "rejected" },
      reason,
      detail: approve ? "审核通过（不改变启用状态，需手动启用）" : "审核拒绝并停用",
    }));
    await userBatch(db, ctx, stmts);
    return json({
      ok: true,
      data: { source_id: sourceId, approval_status: approve ? "approved" : "rejected", enabled_auto_changed: !approve },
    });
  }

  if (seg[2] === "sources" && seg.length === 3 && method === "GET") {
    const paging = parsePaging(url.searchParams);
    if (paging.error) return fail(paging.error, 400);
    const q = s(url.searchParams.get("q"), 100);
    const assigned = s(url.searchParams.get("assigned"), 20) || "all";
    if (!["all", "assigned", "unassigned"].includes(assigned)) return fail("assigned 只能是 all/assigned/unassigned", 400);
    const where = [], binds = [];
    if (q) { where.push("(s.name LIKE ? OR s.remark LIKE ?)"); binds.push(`%${q}%`, `%${q}%`); }
    if (assigned === "assigned") where.push("so.user_id IS NOT NULL");
    if (assigned === "unassigned") where.push("so.user_id IS NULL");
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
    const total = await db.prepare(
      `SELECT COUNT(*) AS total FROM subscription_sources s
         LEFT JOIN source_ownership so ON so.source_id = s.id${whereSql}`,
    ).bind(...binds).first();
    const rows = await db.prepare(
      `SELECT s.id AS source_id, s.name, s.url, s.remark, s.tier, s.enabled, s.priority,
              so.user_id AS owner_user_id, ap.status AS approval_status
         FROM subscription_sources s
         LEFT JOIN source_ownership so ON so.source_id = s.id
         LEFT JOIN source_approvals ap ON ap.source_id = s.id
         ${whereSql} ORDER BY s.priority ASC, s.created_at ASC LIMIT ? OFFSET ?`,
    ).bind(...binds, paging.limit, paging.offset).all();
    return json({
      ok: true,
      data: (rows.results || []).map(r => ({ ...r, url: maskSubscriptionUrl(r.url || "") })),
      total: Number(total?.total || 0), limit: paging.limit, offset: paging.offset,
    });
  }

  if (seg[2] === "sources" && seg.length === 5 && seg[4] === "assign" && method === "POST") {
    const sourceId = s(seg[3], 80);
    const body = await readJson(req);
    const targetId = s(body.user_id, 80);
    if (!validId(sourceId) || !validId(targetId)) return fail("参数无效", 400);
    const source = await db.prepare("SELECT id, name FROM subscription_sources WHERE id = ?").bind(sourceId).first();
    if (!source) return fail("订阅源不存在", 404);
    const target = await db.prepare("SELECT id, status FROM app_users WHERE id = ?").bind(targetId).first();
    if (!target) return fail("用户不存在", 404);
    if (target.status !== "active") return fail("目标用户已停用", 409);
    const previous = await db.prepare("SELECT user_id FROM source_ownership WHERE source_id = ?").bind(sourceId).first();
    // 事务外读只用于 before 审计；批内再断言归属未变化，防止并发转移导致审计与实际不一致
    const stmts = [
      previous
        ? assertStmt(db, "EXISTS (SELECT 1 FROM source_ownership WHERE source_id = ? AND user_id = ?)", [sourceId, previous.user_id])
        : assertStmt(db, "NOT EXISTS (SELECT 1 FROM source_ownership WHERE source_id = ?)", [sourceId]),
      db.prepare(
        `INSERT INTO source_ownership(source_id, user_id, assigned_by) VALUES(?,?,?)
         ON CONFLICT(source_id) DO UPDATE SET user_id=excluded.user_id, assigned_by=excluded.assigned_by, assigned_at=CURRENT_TIMESTAMP`,
      ).bind(sourceId, targetId, ctx.actorId),
      auditStmt(db, ctx, {
        action: previous ? "super.source.reassign" : "super.source.assign",
        targetType: "source", targetId: sourceId,
        before: { owner: previous?.user_id ?? null }, after: { owner: targetId },
      }),
    ];
    try {
      await userBatch(db, ctx, stmts);
    } catch (e) {
      if (/malformed JSON|assert-failed/i.test(String(e?.message || ""))) {
        return fail("来源归属在操作期间已变化，请刷新后重试", 409, { code: "OWNERSHIP_CHANGED" });
      }
      throw e;
    }
    return json({ ok: true, data: { source_id: sourceId, user_id: targetId, previous_owner: previous?.user_id ?? null } });
  }

  if (seg[2] === "sources" && seg.length === 5 && seg[4] === "assign" && method === "DELETE") {
    const sourceId = s(seg[3], 80);
    if (!validId(sourceId)) return fail("来源 ID 无效", 400);
    const source = await db.prepare("SELECT id, name, enabled FROM subscription_sources WHERE id = ?").bind(sourceId).first();
    if (!source) return fail("订阅源不存在", 404);
    const current = await db.prepare("SELECT user_id FROM source_ownership WHERE source_id = ?").bind(sourceId).first();
    if (!current) return fail("该来源当前未分配", 404, { code: "SOURCE_UNASSIGNED" });

    // 解除分配：只删归属 + 停用来源（避免 Cron/手动继续选中），其他数据一律保留
    try {
      await userBatch(db, ctx, [
        assertStmt(db, "EXISTS (SELECT 1 FROM source_ownership WHERE source_id = ? AND user_id = ?)", [sourceId, current.user_id]),
        db.prepare("DELETE FROM source_ownership WHERE source_id = ?").bind(sourceId),
        db.prepare("UPDATE subscription_sources SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(sourceId),
        auditStmt(db, ctx, {
          action: "super.source.unassign", targetType: "source", targetId: sourceId,
          before: { owner: current.user_id, enabled: source.enabled }, after: { owner: null, enabled: 0 },
          detail: "解除归属并停用；节点、覆盖、同步记录与审计全部保留",
        }),
      ]);
    } catch (e) {
      if (/malformed JSON|assert-failed/i.test(String(e?.message || ""))) {
        return fail("来源归属在操作期间已变化，请刷新后重试", 409, { code: "OWNERSHIP_CHANGED" });
      }
      throw e;
    }
    return json({ ok: true, data: { source_id: sourceId, owner: null, enabled: 0 } });
  }

  if (seg[2] === "impersonation" && seg[3] === "start" && method === "POST") {
    const body = await readJson(req);
    const targetId = s(body.user_id, 80);
    if (!validId(targetId)) return fail("user_id 无效", 400);
    if (targetId === ctx.actorId) return fail("无需协助自己", 400);
    const target = await db.prepare("SELECT id, status FROM app_users WHERE id = ?").bind(targetId).first();
    if (!target) return fail("目标用户不存在", 404);
    if (target.status !== "active") return fail("目标用户已停用", 409);

    let grant = await db.prepare(
      `SELECT id, scope FROM admin_user_scopes
        WHERE admin_user_id = ? AND target_user_id = ? AND revoked_at IS NULL
          AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))
        ORDER BY CASE scope WHEN 'manage' THEN 3 WHEN 'operate' THEN 2 ELSE 1 END DESC LIMIT 1`,
    ).bind(ctx.actorId, targetId).first();
    if (!grant) {
      await auditDenied(db, ctx, "super.impersonation.start", "缺少有效授权", "user", targetId);
      return fail("尚未授予该用户的协助权限，请先创建 scope", 403);
    }

    const token = newSessionToken();
    const tokenHash = await sessionTokenHash(token, env);
    const minutes = Math.min(240, Math.max(5, num(env.IMPERSONATION_TTL_MINUTES, 30)));
    const sessionId = newId();
    await userBatch(db, ctx, [
      db.prepare(
        `INSERT INTO user_sessions(id, user_id, token_hash, acting_as_user_id, scope_id, expires_at, user_agent)
         VALUES(?,?,?,?,?,datetime('now', ?),?)`,
      ).bind(sessionId, ctx.actorId, tokenHash, targetId, grant.id, `+${minutes} minutes`, "impersonation"),
      auditStmt(db, { ...ctx, effectiveId: targetId }, {
        action: "super.impersonation.start", targetType: "user", targetId,
        after: { session_id: sessionId, scope: grant.scope, minutes, reason: s(body.reason, 200) },
      }),
    ]);
    return json({
      ok: true,
      data: { token, expires_in_minutes: minutes, actor_user_id: ctx.actorId, effective_user_id: targetId, scope: grant.scope },
    });
  }

  if (seg[2] === "impersonation" && seg[3] === "end" && method === "POST") {
    const body = await readJson(req, { allowEmpty: true });
    const wanted = s(body.session_id, 80);
    let target = null;

    if (ctx.actorId !== ctx.effectiveId && ctx.session) {
      // 用协助 token 结束自己
      target = ctx.session.id;
    } else if (wanted) {
      const row = await db.prepare(
        "SELECT id, user_id, acting_as_user_id FROM user_sessions WHERE id = ? AND revoked_at IS NULL",
      ).bind(wanted).first();
      if (!row || row.user_id !== ctx.actorId || !row.acting_as_user_id) {
        return fail("协助会话不存在或不属于当前账号", 404);
      }
      target = row.id;
    } else {
      return fail("当前不是协助会话；如需结束指定协助会话请传 session_id", 409, { code: "NOT_IMPERSONATING" });
    }

    // 再确认一次：目标必须是协助会话，绝不动普通登录会话
    const check = await db.prepare(
      "SELECT acting_as_user_id FROM user_sessions WHERE id = ? AND user_id = ? AND revoked_at IS NULL",
    ).bind(target, ctx.actorId).first();
    if (!check || !check.acting_as_user_id) {
      return fail("目标不是协助会话，拒绝撤销", 409, { code: "NOT_IMPERSONATING" });
    }

    await db.batch([
      db.prepare("UPDATE user_sessions SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND acting_as_user_id IS NOT NULL")
        .bind(target),
      auditStmt(db, { ...ctx, effectiveId: check.acting_as_user_id }, {
        action: "super.impersonation.end", targetType: "session", targetId: target,
        detail: `effective=${check.acting_as_user_id}`,
      }),
    ]);
    return json({ ok: true, data: { ended: true, session_id: target } });
  }

  return fail("接口不存在", 404);
}

/* ────────────────────────────── 订阅转换（公开）────────────────────────────── */
/**
 * 把「订阅链接 / 手贴节点」转换成多种客户端配置，并存成短链。
 * - 只保存转换结果与来源信息，且整块用 AES-GCM 加密（密钥由 SESSION_PEPPER 派生）。
 * - 抓取复用 fetchSubscription（HTTPS / 443 / 禁内网 / 禁重定向 / 1 MiB / 10s）。
 */

const CONVERT_TARGETS = new Set(["clash", "v2ray", "singbox", "list", "surfboard", "surge", "loon", "qx"]);
const CONVERT_MAX_SOURCES = 8;
const CONVERT_MAX_NODES = 500;
const CONVERT_TTL_DAYS = 730;   // 2 年；每次正常访问自动续期
const CONVERT_RATE_LIMIT = 20;      // 每 IP 每小时最多创建次数
const CONVERT_GLOBAL_HOURLY = 500;  // 全站每小时上限（防多 IP 刷；可用变量覆盖）
const CONVERT_GLOBAL_MINUTE = 20;   // 全站每分钟上限（防瞬时洪峰）
const CONVERT_MAX_TEXT = 20000;     // 手贴节点文本上限

function yamlStr(v) {
  return JSON.stringify(String(v ?? "").replace(/\r?\n/g, " "));
}

/** 从 URI 里取出生成配置所需的完整字段。 */
function parseNodeFull(uri) {
  const raw = String(uri || "").trim();
  if (/^vmess:\/\//i.test(raw)) {
    const b64 = raw.slice(8).split("#")[0];
    const o = JSON.parse(b64urlDecode(b64));
    const port = Number(o.port);
    if (!o.add || !Number.isInteger(port)) throw new Error("vmess 缺少地址或端口");
    const net = String(o.net || "tcp").toLowerCase();
    const tls = String(o.tls || "").toLowerCase();
    return {
      protocol: "vmess", name: s(decodeURIComponentSafe2(raw.split("#")[1] || o.ps || o.add), 120),
      server: String(o.add), port, uuid: String(o.id || ""), alterId: Number(o.aid || 0),
      cipher: String(o.scy || "auto"), network: net, tls: tls === "tls",
      sni: String(o.sni || o.host || ""), host: String(o.host || ""),
      path: String(o.path || ""), uri: raw,
    };
  }
  if (/^ss:\/\//i.test(raw)) {
    const u = parseSsFull(raw);
    return u;
  }
  if (/^(hysteria2|hy2):\/\//i.test(raw)) {
    const u = new URL(raw.replace(/^hy2:/i, "hysteria2:"));
    const q = u.searchParams;
    return {
      protocol: "hysteria2", name: s(decodeURIComponentSafe2(u.hash.replace(/^#/, "")) || u.hostname, 120),
      server: u.hostname, port: Number(u.port || 443),
      password: decodeURIComponentSafe2(u.username || "") + (u.password ? ":" + decodeURIComponentSafe2(u.password) : ""),
      sni: q.get("sni") || "", tls: true, insecure: q.get("insecure") === "1" || q.get("insecure") === "true",
      obfs: q.get("obfs") || "", obfsPassword: q.get("obfs-password") || "", network: "tcp", uri: raw,
    };
  }
  if (/^tuic:\/\//i.test(raw)) {
    const u = new URL(raw);
    const q = u.searchParams;
    return {
      protocol: "tuic", name: s(decodeURIComponentSafe2(u.hash.replace(/^#/, "")) || u.hostname, 120),
      server: u.hostname, port: Number(u.port || 443),
      uuid: decodeURIComponentSafe2(u.username || ""), password: decodeURIComponentSafe2(u.password || ""),
      sni: q.get("sni") || "", alpn: q.get("alpn") || "", tls: true,
      congestion: q.get("congestion_control") || q.get("congestion-controller") || "bbr",
      udpRelayMode: q.get("udp_relay_mode") || "native", network: "tcp", uri: raw,
    };
  }
  if (/^anytls:\/\//i.test(raw)) {
    const u = new URL(raw);
    const q = u.searchParams;
    return {
      protocol: "anytls", name: s(decodeURIComponentSafe2(u.hash.replace(/^#/, "")) || u.hostname, 120),
      server: u.hostname, port: Number(u.port || 443),
      password: decodeURIComponentSafe2(u.username || ""), sni: q.get("sni") || "",
      insecure: q.get("insecure") === "1", tls: true, network: "tcp", uri: raw,
    };
  }

  const u = new URL(raw);
  const protocol = u.protocol.replace(":", "").toLowerCase();
  if (!["vless", "trojan"].includes(protocol)) throw new Error("不支持的协议");
  const port = Number(u.port || 443);
  const q = u.searchParams;
  const net = (q.get("type") || "tcp").toLowerCase();
  const security = (q.get("security") || "").toLowerCase();
  return {
    protocol,
    name: s(decodeURIComponentSafe2(u.hash.replace(/^#/, "")) || u.hostname, 120),
    server: u.hostname, port,
    uuid: protocol === "vless" ? decodeURIComponentSafe2(u.username || "") : "",
    password: protocol === "trojan" ? decodeURIComponentSafe2(u.username || "") : "",
    network: net, tls: security === "tls" || security === "reality",
    reality: security === "reality", sni: q.get("sni") || q.get("host") || "",
    host: q.get("host") || "", path: q.get("path") || "", serviceName: q.get("serviceName") || "",
    flow: q.get("flow") || "", pbk: q.get("pbk") || "", sid: q.get("sid") || "", fp: q.get("fp") || "",
    uri: raw,
  };
}
function decodeURIComponentSafe2(v) { try { return decodeURIComponent(v); } catch { return v; } }

function parseSsFull(raw) {
  const hashAt = raw.indexOf("#");
  const name = hashAt >= 0 ? decodeURIComponentSafe2(raw.slice(hashAt + 1)) : "";
  let body = (hashAt >= 0 ? raw.slice(5, hashAt) : raw.slice(5)).split("?")[0];
  let credential = "", hostpart = "";
  if (body.includes("@")) {
    const at = body.lastIndexOf("@");
    const auth = body.slice(0, at);
    hostpart = body.slice(at + 1);
    credential = decodeURIComponentSafe2(auth);
    if (!credential.includes(":")) { try { credential = b64urlDecode(auth); } catch { /* keep */ } }
  } else {
    const decoded = b64urlDecode(body);
    const at = decoded.lastIndexOf("@");
    credential = decoded.slice(0, at);
    hostpart = decoded.slice(at + 1);
  }
  const [method, ...rest] = credential.split(":");
  const hp = new URL("http://" + hostpart);
  const port = Number(hp.port || 0);
  if (!method || !Number.isInteger(port) || port <= 0) throw new Error("ss 解析失败");
  return {
    protocol: "ss", name: s(name || hp.hostname, 120), server: hp.hostname, port,
    cipher: method, password: rest.join(":"), network: "tcp", tls: false, uri: raw,
  };
}

/** 名称过滤与重命名（仅登录用户可用） */
function applyNodeFilters(nodes, filters) {
  if (!filters || typeof filters !== "object") return nodes;
  const include = (Array.isArray(filters.include) ? filters.include : []).map(x => String(x).toLowerCase()).filter(Boolean);
  const exclude = (Array.isArray(filters.exclude) ? filters.exclude : []).map(x => String(x).toLowerCase()).filter(Boolean);
  const rename = (Array.isArray(filters.rename) ? filters.rename : [])
    .map(r => ({ from: String(r?.from ?? ""), to: String(r?.to ?? "") }))
    .filter(r => r.from);
  let out = nodes.slice();
  if (include.length) out = out.filter(n => include.some(k => String(n.name).toLowerCase().includes(k)));
  if (exclude.length) out = out.filter(n => !exclude.some(k => String(n.name).toLowerCase().includes(k)));
  if (rename.length) {
    out = out.map(n => {
      let name = String(n.name);
      for (const r of rename) name = name.split(r.from).join(r.to);
      return { ...n, name: s(name, 120) };
    });
  }
  const seen = new Set(); const uniq = [];
  for (const n of out) { if (!seen.has(n.name)) { seen.add(n.name); uniq.push(n); } }
  return uniq;
}

function buildClash(nodes) {
  const lines = [
    "# StarJump 订阅转换", "mixed-port: 7890", "allow-lan: false", "mode: rule",
    "log-level: info", "proxies:",
  ];
  for (const n of nodes) {
    const parts = [`name: ${yamlStr(n.name)}`, `server: ${yamlStr(n.server)}`, `port: ${n.port}`];
    if (n.protocol === "vless") {
      parts.unshift("type: vless");
      parts.push(`uuid: ${yamlStr(n.uuid)}`, "udp: true");
      if (n.flow) parts.push(`flow: ${yamlStr(n.flow)}`);
      if (n.tls) parts.push("tls: true");
      if (n.sni) parts.push(`servername: ${yamlStr(n.sni)}`);
      if (n.reality) {
        parts.push("reality-opts:", `  public-key: ${yamlStr(n.pbk)}`, `  short-id: ${yamlStr(n.sid)}`);
        if (n.fp) parts.push(`client-fingerprint: ${yamlStr(n.fp)}`);
      }
      if (n.network === "ws") {
        parts.push("network: ws", "ws-opts:", `  path: ${yamlStr(n.path || "/")}`);
        if (n.host) parts.push("  headers:", `    Host: ${yamlStr(n.host)}`);
      } else if (n.network === "grpc") {
        parts.push("network: grpc", "grpc-opts:", `  grpc-service-name: ${yamlStr(n.serviceName || "")}`);
      }
    } else if (n.protocol === "vmess") {
      parts.unshift("type: vmess");
      parts.push(`uuid: ${yamlStr(n.uuid)}`, `alterId: ${n.alterId || 0}`, "cipher: auto", "udp: true");
      if (n.tls) parts.push("tls: true");
      if (n.sni) parts.push(`servername: ${yamlStr(n.sni)}`);
      if (n.network === "ws") {
        parts.push("network: ws", "ws-opts:", `  path: ${yamlStr(n.path || "/")}`);
        if (n.host) parts.push("  headers:", `    Host: ${yamlStr(n.host)}`);
      }
    } else if (n.protocol === "trojan") {
      parts.unshift("type: trojan");
      parts.push(`password: ${yamlStr(n.password)}`, "udp: true");
      if (n.sni) parts.push(`sni: ${yamlStr(n.sni)}`);
      if (n.network === "ws") {
        parts.push("network: ws", "ws-opts:", `  path: ${yamlStr(n.path || "/")}`);
        if (n.host) parts.push("  headers:", `    Host: ${yamlStr(n.host)}`);
      }
    } else if (n.protocol === "ss") {
      parts.unshift("type: ss");
      parts.push(`cipher: ${yamlStr(n.cipher)}`, `password: ${yamlStr(n.password)}`, "udp: true");
    } else if (n.protocol === "hysteria2") {
      parts.unshift("type: hysteria2");
      parts.push(`password: ${yamlStr(n.password)}`);
      if (n.sni) parts.push(`sni: ${yamlStr(n.sni)}`);
      if (n.insecure) parts.push("skip-cert-verify: true");
      if (n.obfs) parts.push(`obfs: ${yamlStr(n.obfs)}`, `obfs-password: ${yamlStr(n.obfsPassword)}`);
      parts.push("up: \"50 Mbps\"", "down: \"200 Mbps\"");
    } else if (n.protocol === "tuic") {
      parts.unshift("type: tuic");
      parts.push(`uuid: ${yamlStr(n.uuid)}`, `password: ${yamlStr(n.password)}`);
      if (n.sni) parts.push(`sni: ${yamlStr(n.sni)}`);
      if (n.alpn) parts.push(`alpn: [${n.alpn.split(",").map(x => yamlStr(x.trim())).join(", ")}]`);
      parts.push(`congestion-controller: ${yamlStr(n.congestion)}`, `udp-relay-mode: ${yamlStr(n.udpRelayMode)}`, "skip-cert-verify: true");
    } else if (n.protocol === "anytls") {
      parts.unshift("type: anytls");
      parts.push(`password: ${yamlStr(n.password)}`);
      if (n.sni) parts.push(`sni: ${yamlStr(n.sni)}`);
      parts.push("skip-cert-verify: true");
    }
    lines.push("  - { " + parts.join(", ") + " }");
  }
  const names = nodes.map(n => yamlStr(n.name)).join(", ");
  lines.push("proxy-groups:");
  lines.push(`  - { name: "节点选择", type: select, proxies: ["自动选择", ${names}] }`);
  lines.push(`  - { name: "自动选择", type: url-test, proxies: [${names}], url: "http://www.gstatic.com/generate_204", interval: 300 }`);
  lines.push("rules:");
  lines.push("  - MATCH,节点选择");
  return lines.join("\n") + "\n";
}

function buildSingbox(nodes) {
  const outbounds = nodes.map(n => {
    if (n.protocol === "vless") {
      const o = { type: "vless", tag: n.name, server: n.server, server_port: n.port, uuid: n.uuid };
      if (n.flow) o.flow = n.flow;
      if (n.tls) o.tls = { enabled: true, server_name: n.sni || n.server };
      if (n.reality) { o.tls = o.tls || { enabled: true }; o.tls.reality = { enabled: true, public_key: n.pbk, short_id: n.sid }; }
      if (n.network === "ws") o.transport = { type: "ws", path: n.path || "/", headers: n.host ? { Host: n.host } : {} };
      if (n.network === "grpc") o.transport = { type: "grpc", service_name: n.serviceName || "" };
      return o;
    }
    if (n.protocol === "vmess") {
      const o = { type: "vmess", tag: n.name, server: n.server, server_port: n.port, uuid: n.uuid, security: n.cipher || "auto", alter_id: n.alterId || 0 };
      if (n.tls) o.tls = { enabled: true, server_name: n.sni || n.server };
      if (n.network === "ws") o.transport = { type: "ws", path: n.path || "/", headers: n.host ? { Host: n.host } : {} };
      return o;
    }
    if (n.protocol === "trojan") {
      const o = { type: "trojan", tag: n.name, server: n.server, server_port: n.port, password: n.password };
      if (n.sni) o.tls = { enabled: true, server_name: n.sni };
      return o;
    }
    if (n.protocol === "hysteria2") {
      const o = { type: "hysteria2", tag: n.name, server: n.server, server_port: n.port, password: n.password };
      o.tls = { enabled: true, server_name: n.sni || n.server, insecure: !!n.insecure };
      if (n.obfs) o.obfs = { type: n.obfs, password: n.obfsPassword };
      return o;
    }
    if (n.protocol === "tuic") {
      const o = { type: "tuic", tag: n.name, server: n.server, server_port: n.port, uuid: n.uuid, password: n.password };
      o.tls = { enabled: true, server_name: n.sni || n.server, insecure: true };
      o.congestion_control = n.congestion || "bbr";
      o.udp_relay_mode = n.udpRelayMode || "native";
      return o;
    }
    if (n.protocol === "anytls") {
      return { type: "anytls", tag: n.name, server: n.server, server_port: n.port, password: n.password,
        tls: { enabled: true, server_name: n.sni || n.server, insecure: true } };
    }
    return { type: "shadowsocks", tag: n.name, server: n.server, server_port: n.port, method: n.cipher, password: n.password };
  });
  const cfg = {
    log: { level: "info" },
    outbounds: [{ type: "selector", tag: "节点选择", outbounds: ["自动选择", ...nodes.map(n => n.name)] },
      { type: "urltest", tag: "自动选择", outbounds: nodes.map(n => n.name), url: "http://www.gstatic.com/generate_204", interval: "5m" },
      ...outbounds, { type: "direct", tag: "DIRECT" }],
    route: { rules: [{ action: "route", outbound: "节点选择" }], final: "节点选择" },
  };
  return JSON.stringify(cfg, null, 2) + "\n";
}

function buildV2rayBase64(nodes) {
  const text = nodes.map(n => n.uri).join("\n");
  return b64(new TextEncoder().encode(text));
}

function buildNodeList(nodes) {
  return nodes.map(n => n.uri).join("\n") + "\n";
}

function surgeLine(n, style) {
  const head = `${n.name} = ${n.protocol}`;
  const parts = [n.server, String(n.port)];
  if (n.protocol === "vless") parts.push(`username=${n.uuid}`);
  if (n.protocol === "vmess") parts.push(`username=${n.uuid}`, "vmess-aead=true");
  if (n.protocol === "trojan") parts.push(`password=${n.password}`);
  if (n.protocol === "ss") parts.push(`encrypt-method=${n.cipher}`, `password=${n.password}`);
  if (n.tls) parts.push("tls=true");
  if (n.sni) parts.push(`sni=${n.sni}`);
  if (n.network === "ws") { parts.push("ws=true", `ws-path=${n.path || "/"}`); if (n.host) parts.push(`ws-headers=Host:${n.host}`); }
  if (style === "surfboard" && n.protocol === "ss") parts[0] = n.server;
  return `${head}, ${parts.join(", ")}`;
}
function buildSurgeLike(nodes, style) {
  const usable = nodes.filter(n => ["vless", "vmess", "trojan", "ss"].includes(n.protocol));
  const lines = ["[General]", "loglevel = notify", "", "[Proxy]"];
  for (const n of usable) lines.push(surgeLine(n, style));
  lines.push("", "[Proxy Group]", "PROXY = select, " + usable.map(n => n.name).join(", ") + ", DIRECT");
  lines.push("", "[Rule]", "FINAL,PROXY");
  return lines.join("\n") + "\n";
}
function buildLoon(nodes) {
  const usable = nodes.filter(n => ["vless", "vmess", "trojan", "ss"].includes(n.protocol));
  const lines = ["[Proxy]"];
  for (const n of usable) {
    const p = [n.server, String(n.port)];
    if (n.protocol === "vless") p.push(n.uuid);
    if (n.protocol === "vmess") p.push(`"${n.uuid}"`);
    if (n.protocol === "trojan") p.push(n.password);
    if (n.protocol === "ss") p.push(n.cipher, `"${n.password}"`);
    const opts = [];
    if (n.tls) opts.push("over-tls=true", `tls-name=${n.sni || n.server}`, "skip-cert-verify=true");
    if (n.network === "ws") opts.push("transport=ws", `path=${n.path || "/"}`, `host=${n.host || n.sni || n.server}`);
    const proto = { vless: "VLESS", vmess: "VMess", trojan: "Trojan", ss: "Shadowsocks" }[n.protocol];
    lines.push(`${n.name} = ${proto}, ${p.concat(opts).join(", ")}`);
  }
  lines.push("", "[Proxy Group]", "PROXY = select, " + usable.map(n => n.name).join(", ") + ", DIRECT");
  lines.push("", "[Rule]", "FINAL,PROXY");
  return lines.join("\n") + "\n";
}
function buildQuantumultX(nodes) {
  const usable = nodes.filter(n => ["vless", "vmess", "trojan", "ss"].includes(n.protocol));
  const lines = ["[server_local]"];
  for (const n of usable) {
    const parts = [`${n.protocol === "ss" ? "" : n.protocol}=${n.server}:${n.port}`];
    if (n.protocol === "ss") parts[0] = `shadowsocks=${n.server}:${n.port}`;
    if (n.protocol === "ss") { parts.push(`method=${n.cipher}`, `password=${n.password}`); }
    else if (n.protocol === "trojan") { parts.push(`password=${n.password}`, "over-tls=true"); }
    else { parts.push(`method=none`, `password=${n.uuid}`); }
    if (n.tls) parts.push("tls-verification=false");
    if (n.network === "ws") { parts.push("obfs=wss"); if (n.host) parts.push(`obfs-host=${n.host}`); parts.push(`obfs-uri=${n.path || "/"}`); }
    parts.push("fast-open=false", "udp-relay=false", `tag=${n.name}`);
    lines.push(parts.join(", "));
  }
  return lines.join("\n") + "\n";
}

async function convertKey(env) {
  const secret = String(env.CONVERT_KEY || env.SESSION_PEPPER || "starjump-convert");
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode("starjump-convert-v1"), iterations: 100000 },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"],
  );
}
async function sealJson(env, obj) {
  const key = await convertKey(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(obj)));
  const all = new Uint8Array(iv.length + ct.byteLength);
  all.set(iv, 0); all.set(new Uint8Array(ct), iv.length);
  return b64(all);
}
async function openJson(env, sealed) {
  const raw = unb64(sealed);
  const iv = raw.slice(0, 12), ct = raw.slice(12);
  const key = await convertKey(env);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

/** 全局计数：桶不存在就建，超过阈值返回 false。表缺失时放行（不因限流表故障挡住业务）。 */
async function bumpGlobalLimit(db, key, limit) {
  return true;
}
async function checkGlobalLimit(db, env) {
  const hourly = Math.max(1, num(env.CONVERT_HOURLY_LIMIT, CONVERT_GLOBAL_HOURLY));
  const perMin = Math.max(1, num(env.CONVERT_MINUTE_LIMIT, CONVERT_GLOBAL_MINUTE));
  const now = new Date();
  const ymdh = now.toISOString().slice(0, 13).replace(/[-T:]/g, "");
  const ymdhm = now.toISOString().slice(0, 16).replace(/[-T:]/g, "");
  try {
    for (const [bucket, limit] of [[`g:h:${ymdh}`, hourly], [`g:m:${ymdhm}`, perMin]]) {
      await db.prepare(
        `INSERT INTO rate_limits(bucket, count) VALUES(?, 1)
         ON CONFLICT(bucket) DO UPDATE SET count = count + 1, updated_at = CURRENT_TIMESTAMP`,
      ).bind(bucket).run();
      const row = await db.prepare("SELECT count FROM rate_limits WHERE bucket = ?").bind(bucket).first();
      if (Number(row?.count || 0) > limit) return { ok: false, limit, scope: bucket.startsWith("g:m:") ? "minute" : "hour" };
    }
    return { ok: true };
  } catch {
    return { ok: true };   // 表还没建时不影响转换
  }
}

async function resolveOwnerKey(env, ownerId, guestKey) {
  if (ownerId) return `u:${ownerId}`;
  const key = String(guestKey || "");
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(key)) {
    throw sessionError("GUEST_KEY_REQUIRED", "匿名用户缺少有效 guest_key，请刷新页面后重试");
  }
  const pepper = requiredSecret(env, "SESSION_PEPPER", 32);
  const hash = await sha256Hex(`${key}|${pepper}`);
  return `g:${hash.slice(0, 24)}`;
}

function clientIp(req) {
  return s(req.headers.get("CF-Connecting-IP") || req.headers.get("x-forwarded-for") || "unknown", 60);
}

async function convertRoute(req, env, url, ctx) {
  const db = env.DB;

  // GET /c/<id>?t=clash —— 直接返回配置文本，供客户端当订阅使用
  if (url.pathname.startsWith("/c/") && req.method === "GET") {
    const id = s(url.pathname.slice(3), 40);
    if (!/^[A-Za-z0-9]{6,40}$/.test(id)) return fail("链接无效", 404);
    const row = await db.prepare(
      "SELECT payload, expires_at, revoked_at FROM convert_links WHERE id = ?",
    ).bind(id).first();
    if (!row) return fail("链接不存在或已失效", 404);
    if (row.revoked_at) return fail("链接已被手动失效", 410);
    const expired = await db.prepare("SELECT 1 AS ok WHERE datetime(?) <= datetime('now')").bind(row.expires_at).first();
    if (expired) return fail("链接已过期", 410);
    let data;
    try { data = await openJson(env, row.payload); } catch { return fail("链接内容无法解析", 500); }
    const t = s(url.searchParams.get("t"), 20) || "v2ray";
    if (!CONVERT_TARGETS.has(t)) return fail("不支持的格式", 400);
    const text = data.formats?.[t];
    if (!text) return fail("该链接没有生成这种格式", 404);
    // 正常访问 → 计数 + 刷新“最后使用时间”，并顺延 2 年（规则：中途使用重新计时）
    await db.prepare(
      `UPDATE convert_links SET hits = hits + 1, last_used_at = CURRENT_TIMESTAMP,
              expires_at = datetime('now', ?) WHERE id = ?`,
    ).bind(`+${CONVERT_TTL_DAYS} days`, id).run().catch(() => {});
    const ext = t === "clash" ? ".yaml" : t === "singbox" ? ".json" : (t === "surge" || t === "surfboard") ? ".conf" : ".txt";
    const filename = `${data.meta?.filename || "starjump"}-${t}${ext}`;
    return new Response(text, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `inline; filename="${filename}"`,
        "cache-control": "no-store",
        "profile-update-interval": "24",
        "subscription-userinfo": data.meta?.userinfo || "",
      },
    });
  }

  // 分组列表：登录用户看自己的；未注册用户凭本地 guest key 看自己的
  if (url.pathname === "/api/convert/groups" && req.method === "GET") {
    let ownerId = null;
    try {
      const maybe = await resolveSession(req, env);
      if (maybe && !maybe.legacy) ownerId = maybe.effectiveId;
    } catch { /* 匿名 */ }
    const guestKey = s(url.searchParams.get("guest_key"), 64);
    const ownerKey = await resolveOwnerKey(env, ownerId, guestKey);
    const rows = await db.prepare(
      `SELECT group_name, COUNT(*) AS links, SUM(hits) AS hits, MAX(COALESCE(last_used_at, created_at)) AS last_at
         FROM convert_links WHERE owner_key = ? GROUP BY group_name ORDER BY last_at DESC`,
    ).bind(ownerKey).all();
    return json({ ok: true, data: rows.results || [], owner: ownerKey.split(":")[0] });
  }

  // 普通用户（含未注册）查看/管理自己的分组与链接
  if (url.pathname === "/api/convert/links" && req.method === "GET") {
    let ownerId = null;
    try { const m = await resolveSession(req, env); if (m && !m.legacy) ownerId = m.effectiveId; } catch {}
    const ownerKey = await resolveOwnerKey(env, ownerId, s(url.searchParams.get("guest_key"), 64));
    const rows = await db.prepare(
      `SELECT id, group_name, targets, hits, created_at, last_used_at, expires_at, revoked_at
         FROM convert_links WHERE owner_key = ? ORDER BY created_at DESC LIMIT 200`,
    ).bind(ownerKey).all();
    return json({ ok: true, data: rows.results || [] });
  }

  if (url.pathname.startsWith("/api/convert/links/") && url.pathname.endsWith("/revoke") && req.method === "POST") {
    const body = await readJson(req, { allowEmpty: true });
    let ownerId = null;
    try { const m = await resolveSession(req, env); if (m && !m.legacy) ownerId = m.effectiveId; } catch {}
    const ownerKey = await resolveOwnerKey(env, ownerId, s(req.headers.get("x-guest-key") || body.guest_key, 64));
    const id = s(url.pathname.split("/")[4], 40);
    if (!/^[A-Za-z0-9]{6,40}$/.test(id)) return fail("链接 ID 无效", 400);
    const row = await db.prepare("SELECT id, owner_key, revoked_at FROM convert_links WHERE id = ?").bind(id).first();
    if (!row || row.owner_key !== ownerKey) return fail("链接不存在", 404);
    if (row.revoked_at) return json({ ok: true, data: { id, already: true } });
    await db.prepare("UPDATE convert_links SET revoked_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id).run();
    return json({ ok: true, data: { id, revoked: true } });
  }

  if (url.pathname === "/api/convert/groups/rename" && req.method === "POST") {
    const body = await readJson(req);
    let ownerId = null;
    try { const m = await resolveSession(req, env); if (m && !m.legacy) ownerId = m.effectiveId; } catch {}
    const ownerKey = await resolveOwnerKey(env, ownerId, s(req.headers.get("x-guest-key") || body.guest_key, 64));
    const from = s(body.from, 30), to = s(body.to, 30);
    if (!from || !to) return fail("原分组名和新分组名都要填", 400);
    if (!/^[\u4e00-\u9fa5A-Za-z0-9 _-]{1,30}$/.test(to)) return fail("分组名不合法", 400);
    const res = await db.prepare(
      "UPDATE convert_links SET group_name = ? WHERE owner_key = ? AND group_name = ?",
    ).bind(to, ownerKey, from).run();
    return json({ ok: true, data: { from, to, links: Number(res.meta?.changes || 0) } });
  }

  if (url.pathname === "/api/convert" && req.method === "POST") {
    const body = await readJson(req);
    // 归属键：登录用户 u:<id>；未注册用户用浏览器本地 guest key（g:<hash>）；都没有则共享访客组
    let ownerId = null;
    try {
      const maybe = await resolveSession(req, env);
      if (maybe && !maybe.legacy) ownerId = maybe.effectiveId;
    } catch { /* 匿名继续 */ }
    const guestKey = s(req.headers.get("x-guest-key") || body.guest_key, 64);
    const ownerKey = await resolveOwnerKey(env, ownerId, guestKey);
    const sources = Array.isArray(body.sources) ? body.sources.filter(x => typeof x === "string").slice(0, CONVERT_MAX_SOURCES) : [];
    const manual = String(body.nodes || "").slice(0, CONVERT_MAX_TEXT);
    const targets = (Array.isArray(body.targets) ? body.targets : []).map(x => s(x, 20)).filter(x => CONVERT_TARGETS.has(x));
    if (!sources.length && !manual.trim()) return fail("请提供订阅链接或节点", 400);
    if (!targets.length) return fail("请至少选择一种输出格式", 400);

    // 限流：每 IP 每小时最多 CONVERT_RATE_LIMIT 次
    const ipHash = await sha256Hex(`${clientIp(req)}|${env.SESSION_PEPPER || ""}`);
    const recent = await db.prepare(
      "SELECT COUNT(*) AS n FROM convert_links WHERE ip_hash = ? AND created_at > datetime('now','-1 hour')",
    ).bind(ipHash).first();
    if (Number(recent?.n || 0) >= CONVERT_RATE_LIMIT) {
      return fail(`转换太频繁，请稍后再试（每小时最多 ${CONVERT_RATE_LIMIT} 次）`, 429);
    }
    const globalCheck = await checkGlobalLimit(db, env);
    if (!globalCheck.ok) {
      return fail("服务当前请求较多，请稍后再试", 429, { code: "GLOBAL_RATE_LIMITED", scope: globalCheck.scope });
    }

    // 抓取每个来源（复用带 SSRF 防护的实现）
    const uris = [];
    const sourceInfo = [];
    let userinfo = "";
    for (const rawUrl of sources) {
      try {
        const parsedUrl = validateSubscriptionUrl(rawUrl);
        const hostRule = String(env.CONVERT_HOST_ALLOWLIST || "").trim();
        if (hostRule) {
          const allowed = hostRule.split(",").map(x => x.trim().toLowerCase()).filter(Boolean)
            .some(suffix => parsedUrl.hostname.toLowerCase().endsWith(suffix.replace(/^\*/, "")));
          if (!allowed) throw new Error("该订阅域名不在允许列表内");
        }
        const fetched = await fetchSubscription(rawUrl);
        const parsed = await parseSubscription(fetched.text, { id: "convert", name: "convert", tier: "free" });
        uris.push(...parsed.nodes.map(n => n.uri));
        sourceInfo.push({ url: rawUrl, nodes: parsed.nodes.length });
        if (!userinfo && fetched.quota && Number.isFinite(fetched.quota.total)) {
          const parts = [];
          if (Number.isFinite(fetched.quota.upload)) parts.push(`upload=${fetched.quota.upload}`);
          if (Number.isFinite(fetched.quota.download)) parts.push(`download=${fetched.quota.download}`);
          parts.push(`total=${fetched.quota.total}`);
          if (Number.isFinite(fetched.quota.expire)) parts.push(`expire=${fetched.quota.expire}`);
          userinfo = parts.join("; ");
        }
      } catch (e) {
        sourceInfo.push({ url: rawUrl, error: s(e?.message || "抓取失败", 120) });
      }
    }
    for (const line of manual.split(/\r?\n/)) {
      const t = line.trim();
      if (/^(vless|vmess|trojan|ss|hysteria2|hy2|tuic|anytls):\/\//i.test(t)) uris.push(t);
    }
    if (!uris.length) {
      return fail("没有取到任何节点；请检查订阅链接是否可访问（来源错误见 sources）", 400, { sources: sourceInfo });
    }

    const seen = new Set();
    const nodes = [];
    for (const uri of uris) {
      const key = uri.trim();
      if (seen.has(key)) continue;
      seen.add(key);
      try { nodes.push(parseNodeFull(key)); } catch { /* 单条解析失败跳过 */ }
      if (nodes.length >= CONVERT_MAX_NODES) break;
    }
    if (!nodes.length) return fail("节点解析失败，请确认内容格式", 400);

    // 过滤/重命名仅对登录用户开放（VIP 功能）
    const filtered = applyNodeFilters(nodes, body.filters);
    if (!filtered.length) return fail("过滤后没有剩余节点，请放宽条件", 400);
    const finalNodes = filtered;

    const formats = {};
    if (targets.includes("clash")) formats.clash = buildClash(finalNodes);
    if (targets.includes("v2ray")) formats.v2ray = buildV2rayBase64(finalNodes);
    if (targets.includes("singbox")) formats.singbox = buildSingbox(finalNodes);
    if (targets.includes("list")) formats.list = buildNodeList(finalNodes);
    if (targets.includes("surge")) formats.surge = buildSurgeLike(finalNodes, "surge");
    if (targets.includes("surfboard")) formats.surfboard = buildSurgeLike(finalNodes, "surfboard");
    if (targets.includes("loon")) formats.loon = buildLoon(finalNodes);
    if (targets.includes("qx")) formats.qx = buildQuantumultX(finalNodes);

    const id = newId().slice(0, 12);
    const rawGroup = s(body.group, 30);
    const groupName = rawGroup || "我的默认分组";
    if (!/^[\u4e00-\u9fa5A-Za-z0-9 _-]{1,30}$/.test(groupName)) {
      return fail("分组名只能是 1-30 位中英文/数字/空格/下划线", 400);
    }
    const meta = { filename: s(body.filename, 60) || "starjump", userinfo, owner: ownerId };
    await db.prepare(
      `INSERT INTO convert_links(id, payload, targets, group_name, owner_user_id, owner_key, ip_hash, expires_at)
       VALUES(?,?,?,?,?,?,?,datetime('now', ?))`,
    ).bind(id, await sealJson(env, { formats, meta, sources: sourceInfo }), targets.join(","),
      groupName, ownerId, ownerKey, ipHash, `+${CONVERT_TTL_DAYS} days`).run();

    const origin = new URL(req.url).origin;
    const links = {};
    for (const t of targets) links[t] = `${origin}/c/${id}?t=${t}`;
    return json({
      ok: true,
      data: {
        id, links, expires_in_days: CONVERT_TTL_DAYS,
        group: groupName,
        stats: { sources: sources.length, nodes: finalNodes.length, skipped: uris.length - finalNodes.length },
        sources: sourceInfo.map(x => ({ ...x, url: maskSubscriptionUrl(x.url) })),
      },
    }, 201);
  }

  return fail("接口不存在", 404);
}

/* ────────────────────────────── 管理员 VIP 卡密 ────────────────────────────── */
/**
 * 规则（见《时间限制与生命周期总表》）：
 * - 新用户自动赠送 7 天体验（kind=trial），不算正式 VIP。
 * - 正式 VIP 只能由卡密激活（kind=formal），并保留激活历史。
 * - 续费：未到期从原到期时间叠加；已到期从本次激活时间起算。
 */

const VIP_TRIAL_DAYS = 7;
const VIP_MAX_DAYS = 3650;
const VIP_CARD_CODE_LEN = 16;

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(VIP_CARD_CODE_LEN));
  return [...bytes].map(b => chars[b % chars.length]).join("");
}

async function vipStatus(db, userId) {
  // 当前有效期必须同时满足 starts_at <= now < ends_at；is_formal 保留历史语义。
  try {
    const row = await db.prepare(
      `SELECT
         MAX(CASE WHEN datetime(starts_at) <= datetime('now') AND datetime(ends_at) > datetime('now') THEN ends_at END) AS until,
         MAX(CASE WHEN kind='formal' AND datetime(starts_at) <= datetime('now') AND datetime(ends_at) > datetime('now') THEN 1 ELSE 0 END) AS active_formal,
         SUM(CASE WHEN kind='formal' THEN 1 ELSE 0 END) AS formal_count,
         SUM(CASE WHEN kind='trial' THEN 1 ELSE 0 END) AS trial_count
       FROM admin_vip_activations WHERE user_id = ?`,
    ).bind(userId).first();
    const until = row?.until || null;
    return {
      until,
      active: !!until,
      is_formal: Number(row?.formal_count || 0) > 0,
      active_formal: Number(row?.active_formal || 0) > 0,
      has_trial: Number(row?.trial_count || 0) > 0,
    };
  } catch {
    return { until: null, active: false, is_formal: false, active_formal: false, has_trial: false, unavailable: true };
  }
}

async function grantTrial(db, userId) {
  const existing = await db.prepare("SELECT 1 AS x FROM admin_vip_activations WHERE user_id = ? LIMIT 1").bind(userId).first();
  if (existing) return false;
  await db.prepare(
    `INSERT INTO admin_vip_activations(id, user_id, card_id, days, kind, starts_at, ends_at)
     VALUES(?,?,NULL,?, 'trial', CURRENT_TIMESTAMP, datetime('now', ?))`,
  ).bind(newId(), userId, VIP_TRIAL_DAYS, `+${VIP_TRIAL_DAYS} days`).run();
  return true;
}

async function userVipRoute(req, env, url, ctx) {
  const db = env.DB;
  if (url.pathname === "/api/user/vip" && req.method === "GET") {
    return json({ ok: true, data: await vipStatus(db, ctx.effectiveId) });
  }
  if (url.pathname === "/api/user/vip/activate" && req.method === "POST") {
    const body = await readJson(req);
    const code = s(body.code, 40).toUpperCase();
    if (!/^[A-Z0-9]{8,24}$/.test(code)) return fail("卡密格式不正确", 400);
    const card = await db.prepare("SELECT id, days, status FROM admin_vip_cards WHERE code = ?").bind(code).first();
    if (!card) return fail("卡密不存在", 404);
    if (card.status !== "unused") return fail("卡密已被使用", 409);
    const days = Number(card.days);
    if (!Number.isInteger(days) || days < 1 || days > VIP_MAX_DAYS) return fail("卡密天数异常", 400);

    const cur = await vipStatus(db, ctx.effectiveId);
    // 未到期 → 从原到期时间叠加；已到期/无 → 从当前时间起算
    const sql = cur.active
      ? `INSERT INTO admin_vip_activations(id, user_id, card_id, days, kind, starts_at, ends_at)
         VALUES(?,?,?,?, 'formal', CURRENT_TIMESTAMP, datetime(?, ?))`
      : `INSERT INTO admin_vip_activations(id, user_id, card_id, days, kind, starts_at, ends_at)
         VALUES(?,?,?,?, 'formal', CURRENT_TIMESTAMP, datetime('now', ?))`;
    const id = newId();
    const binds = cur.active
      ? [id, ctx.effectiveId, card.id, days, cur.until, `+${days} days`]
      : [id, ctx.effectiveId, card.id, days, `+${days} days`];

    await userBatch(db, ctx, [
      assertStmt(db, "EXISTS (SELECT 1 FROM admin_vip_cards WHERE id = ? AND status = 'unused')", [card.id]),
      db.prepare(
        "UPDATE admin_vip_cards SET status='used', used_by=?, used_at=CURRENT_TIMESTAMP WHERE id=? AND status='unused'",
      ).bind(ctx.effectiveId, card.id),
      db.prepare(sql).bind(...binds),
      auditStmt(db, ctx, {
        action: "vip.activate", targetType: "user", targetId: ctx.effectiveId,
        before: { until: cur.until, active: cur.active }, after: { days, card_id: card.id },
        detail: cur.active ? "未到期续费：叠加" : "已到期/未激活：从当前起算",
      }),
    ]);
    return json({ ok: true, data: { ...(await vipStatus(db, ctx.effectiveId)), days } });
  }
  return fail("接口不存在", 404);
}

async function superVipRoute(req, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.split("/").filter(Boolean);   // api,super,vip-cards,...
  if (seg[2] !== "vip-cards") return fail("接口不存在", 404);

  if (seg.length === 3 && req.method === "GET") {
    const paging = parsePaging(url.searchParams);
    if (paging.error) return fail(paging.error, 400);
    const status = s(url.searchParams.get("status"), 20);
    const where = status ? " WHERE status = ?" : "";
    const binds = status ? [status] : [];
    const total = await db.prepare(`SELECT COUNT(*) AS total FROM admin_vip_cards${where}`).bind(...binds).first();
    const rows = await db.prepare(
      `SELECT id, code, days, status, note, created_at, used_by, used_at FROM admin_vip_cards${where}
        ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, paging.limit, paging.offset).all();
    return json({ ok: true, data: rows.results || [], total: Number(total?.total || 0), limit: paging.limit, offset: paging.offset });
  }

  if (seg.length === 3 && req.method === "POST") {
    const body = await readJson(req);
    const count = num(body.count, 1);
    const days = num(body.days, 30);
    if (!Number.isInteger(count) || count < 1 || count > 100) return fail("单次最多生成 100 张", 400);
    if (!Number.isInteger(days) || days < 1 || days > VIP_MAX_DAYS) return fail("天数必须是 1-3650 的整数", 400);
    const codes = [];
    const stmts = [];
    for (let i = 0; i < count; i++) {
      const code = randomCode();
      codes.push(code);
      stmts.push(
        db.prepare("INSERT INTO admin_vip_cards(id, code, days, status, note, created_by) VALUES(?,?,?,'unused',?,?)")
          .bind(newId(), code, days, s(body.note, 100), ctx.actorId),
      );
    }
    stmts.push(auditStmt(db, ctx, {
      action: "vip.card.create", targetType: "vip_card", targetId: "-",
      after: { count, days }, detail: `生成 ${count} 张 ${days} 天卡密`,
    }));
    await userBatch(db, ctx, stmts);
    return json({ ok: true, data: { count, days, codes } }, 201);
  }
  return fail("接口不存在", 404);
}

/* ────────────────────────────── APP 卡密与 VIP 到期失活 ────────────────────────────── */
/**
 * 规则（见《时间限制与生命周期总表》）：
 * - 管理员 VIP 到期满 3 天后，才失活其名下「正常、未激活、未使用、未手动停用、未过期」的 APP 卡密。
 * - 管理员续费后自动恢复「因 VIP 到期而失活」的卡密；手动停用/已使用/已过期/已核销的不恢复。
 * - 库存上限：未激活 5000 张、总记录 20000 条；单次批量 ≤300。
 */

const APP_CARD_BATCH_MAX = 300;
const APP_CARD_STOCK_MAX = 5000;
const APP_CARD_TOTAL_MAX = 20000;
const VIP_GRACE_DAYS = 3;

function appCardCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map(x => chars[x % chars.length]).join("");
}

/** 管理员 VIP 到期满 3 天？ */
async function vipExpiredOverGrace(db, userId) {
  const row = await db.prepare(
    "SELECT MAX(ends_at) AS until FROM admin_vip_activations WHERE user_id = ?",
  ).bind(userId).first();
  const until = row?.until;
  if (!until) return false;
  const gracePassed = await db.prepare(
    "SELECT 1 AS ok WHERE datetime(?) <= datetime('now', ?)",
  ).bind(until, `-${VIP_GRACE_DAYS} days`).first();
  return !!gracePassed;
}

async function vipActiveNow(db, userId) {
  const row = await db.prepare(
    "SELECT 1 AS ok FROM admin_vip_activations WHERE user_id = ? AND datetime(ends_at) > datetime('now') LIMIT 1",
  ).bind(userId).first();
  return !!row;
}

async function deactivateCardsForAdmin(db, userId) {
  const res = await db.prepare(
    `UPDATE app_cards SET status = 'inactive', inactive_reason = 'admin_vip_expired', inactive_at = CURRENT_TIMESTAMP
      WHERE admin_user_id = ? AND status = 'normal' AND manual_disabled = 0
        AND activated_at IS NULL AND used_at IS NULL
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
  ).bind(userId).run();
  return Number(res.meta?.changes || 0);
}

async function restoreCardsForAdmin(db, userId) {
  const res = await db.prepare(
    `UPDATE app_cards SET status = 'normal', inactive_reason = '', restored_at = CURRENT_TIMESTAMP
      WHERE admin_user_id = ? AND status = 'inactive' AND inactive_reason = 'admin_vip_expired'
        AND manual_disabled = 0
        AND activated_at IS NULL AND used_at IS NULL
        AND (expires_at IS NULL OR datetime(expires_at) > datetime('now'))`,
  ).bind(userId).run();
  return Number(res.meta?.changes || 0);
}

/** Cron 调用的维护任务：失活 + 恢复。 */
async function runVipCardMaintenance(db, ctx) {
  const users = await db.prepare(
    `SELECT DISTINCT admin_user_id AS id FROM app_cards`,
  ).all();
  let deactivated = 0, restored = 0;
  for (const u of users.results || []) {
    if (await vipActiveNow(db, u.id)) {
      restored += await restoreCardsForAdmin(db, u.id);
    } else if (await vipExpiredOverGrace(db, u.id)) {
      deactivated += await deactivateCardsForAdmin(db, u.id);
    }
  }
  if (deactivated || restored) {
    await db.prepare(
      "INSERT INTO admin_audit(action, detail) VALUES('app_cards.maintenance', ?)",
    ).bind(JSON.stringify({ deactivated, restored })).run().catch(() => {});
    await auditStmt(db, ctx || { actorId: "cron", effectiveId: null, requestId: "" }, {
      action: "app_cards.maintenance", targetType: "app_card", targetId: "-",
      after: { deactivated, restored }, detail: "Cron：VIP 到期失活 / 续费恢复",
    }).run().catch(() => {});
  }
  return { deactivated, restored };
}

async function userAppCardsRoute(req, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.split("/").filter(Boolean);   // api,user,app-cards,...

  if (seg.length === 3 && req.method === "GET") {
    const st = s(url.searchParams.get("status"), 20);
    const from = s(url.searchParams.get("from"), 20);
    const to = s(url.searchParams.get("to"), 20);
    let sql = `SELECT id, code, days, status, inactive_reason, inactive_at, restored_at, manual_disabled,
                      activated_at, used_at, created_at
                 FROM app_cards WHERE admin_user_id = ?`;
    const binds = [ctx.effectiveId];
    if (["normal", "inactive", "used"].includes(st)) { sql += " AND status = ?"; binds.push(st); }
    if (st === "unactivated") sql += " AND activated_at IS NULL AND used_at IS NULL";
    if (from) { sql += " AND datetime(created_at) >= datetime(?)"; binds.push(from); }
    if (to) { sql += " AND datetime(created_at) <= datetime(?)"; binds.push(to); }
    sql += " ORDER BY created_at DESC LIMIT 500";
    const rows = await db.prepare(sql).bind(...binds).all();
    const stats = await db.prepare(
      `SELECT status, COUNT(*) AS n FROM app_cards WHERE admin_user_id = ? GROUP BY status`,
    ).bind(ctx.effectiveId).all();
    return json({ ok: true, data: rows.results || [], stats: stats.results || [] });
  }

  if (seg.length === 3 && req.method === "POST") {
    const body = await readJson(req);
    const count = num(body.count, 1);
    const days = num(body.days, 30);
    if (!Number.isInteger(count) || count < 1 || count > APP_CARD_BATCH_MAX) return fail(`单次最多 ${APP_CARD_BATCH_MAX} 张`, 400);
    if (!Number.isInteger(days) || days < 1 || days > VIP_MAX_DAYS) return fail("天数必须是 1-3650 的整数", 400);

    const total = await db.prepare("SELECT COUNT(*) AS n FROM app_cards WHERE admin_user_id = ?").bind(ctx.effectiveId).first();
    if (Number(total?.n || 0) + count > APP_CARD_TOTAL_MAX) return fail(`总记录上限 ${APP_CARD_TOTAL_MAX} 张`, 409);
    const stock = await db.prepare(
      "SELECT COUNT(*) AS n FROM app_cards WHERE admin_user_id = ? AND status='normal' AND activated_at IS NULL AND used_at IS NULL",
    ).bind(ctx.effectiveId).first();
    if (Number(stock?.n || 0) + count > APP_CARD_STOCK_MAX) return fail(`未激活库存上限 ${APP_CARD_STOCK_MAX} 张`, 409);

    const codes = [];
    const stmts = [];
    for (let i = 0; i < count; i++) {
      const code = appCardCode();
      codes.push(code);
      stmts.push(
        db.prepare("INSERT INTO app_cards(id, code, admin_user_id, days, expires_at) VALUES(?,?,?,?,datetime('now', ?))")
          .bind(newId(), code, ctx.effectiveId, days, `+${Math.max(days * 2, 365)} days`),
      );
    }
    stmts.push(auditStmt(db, ctx, {
      action: "app_card.create", targetType: "app_card", targetId: "-",
      after: { count, days }, detail: `生成 ${count} 张 APP 卡密`,
    }));
    await userBatch(db, ctx, stmts);
    return json({ ok: true, data: { count, days, codes } }, 201);
  }

  if (seg.length === 4 && req.method === "DELETE") {
    const id = s(seg[3], 80);
    const card = await db.prepare("SELECT id, status, activated_at, used_at FROM app_cards WHERE id = ? AND admin_user_id = ?")
      .bind(id, ctx.effectiveId).first();
    if (!card) return fail("卡密不存在", 404);
    if (card.activated_at || card.used_at || card.status === 'used') {
      return fail("已激活/已使用的卡密不能删除，只能停用", 409, { code: "CARD_IN_USE" });
    }
    await userBatch(db, ctx, [
      db.prepare(`UPDATE app_cards SET status='inactive', manual_disabled=1, inactive_reason='user_deleted',
                         inactive_at=CURRENT_TIMESTAMP WHERE id = ? AND admin_user_id = ?`).bind(id, ctx.effectiveId),
      auditStmt(db, ctx, {
        action: "app_card.delete", targetType: "app_card", targetId: id,
        before: { status: card.status }, after: { status: 'inactive', reason: 'user_deleted' },
      }),
    ]);
    return json({ ok: true, data: { id, deleted: true } });
  }

  if (seg.length === 5 && seg[4] === "disable" && req.method === "POST") {
    const id = s(seg[3], 80);
    const body = await readJson(req, { allowEmpty: true });
    const card = await db.prepare("SELECT id, status FROM app_cards WHERE id = ? AND admin_user_id = ?")
      .bind(id, ctx.effectiveId).first();
    if (!card) return fail("卡密不存在", 404);
    await userBatch(db, ctx, [
      db.prepare("UPDATE app_cards SET manual_disabled = 1, status = CASE WHEN status='normal' THEN 'inactive' ELSE status END, inactive_reason = CASE WHEN status='normal' THEN 'manual' ELSE inactive_reason END WHERE id = ? AND admin_user_id = ?")
        .bind(id, ctx.effectiveId),
      auditStmt(db, ctx, {
        action: "app_card.disable", targetType: "app_card", targetId: id,
        before: { status: card.status }, after: { manual_disabled: 1 },
        reason: s(body.reason, 200),
      }),
    ]);
    return json({ ok: true, data: { id, disabled: true } });
  }

  if (seg.length === 4 && seg[3] === "events" && req.method === "GET") {
    const rows = await db.prepare(
      `SELECT e.action, e.detail, e.device_id, e.created_at, c.code
         FROM app_card_events e JOIN app_cards c ON c.id = e.card_id
        WHERE e.admin_user_id = ? ORDER BY e.created_at DESC LIMIT 300`,
    ).bind(ctx.effectiveId).all();
    return json({ ok: true, data: rows.results || [] });
  }

  return fail("接口不存在", 404);
}

/* ────────────────────────────── 节点生命周期（只标记不删）────────────────────────────── */
/**
 * 口径（因 Worker 无法探测节点连通性，采用“订阅内是否还在”）：
 * - 首次检测：节点创建满 30 天；之后每 15 天一次。
 * - 失败判定：连续 3 次检测都“不在最近 3 次成功同步里” → 进入 7 天观察期。
 * - 观察期结束仍不在 → 标记 stale（只标记，绝不删行）。
 * - 任何一次检测发现还在 → 立即清零并取消观察。
 */

const LIFECYCLE_FIRST_DAYS = 30;
const LIFECYCLE_INTERVAL_DAYS = 15;
const LIFECYCLE_FAIL_STREAK = 3;
const LIFECYCLE_OBSERVE_DAYS = 7;

async function runNodeLifecycle(db, ctx) {
  const nodes = await db.prepare(
    `SELECT n.id, n.source_id, n.created_at, n.last_seen,
            l.state, l.fail_streak, l.observation_started_at, l.last_check_at
       FROM node_records n
       LEFT JOIN node_lifecycle l ON l.node_id = n.id
      WHERE n.enabled = 1`,
  ).all();

  let checked = 0, failed = 0, observing = 0, stale = 0;
  for (const n of nodes.results || []) {
    const due = await db.prepare(
      `SELECT 1 AS ok WHERE
         (datetime(?) <= datetime('now', ?))
         OR (datetime(?) <= datetime('now', ?) AND ? IS NOT NULL)`,
    ).bind(
      n.created_at, `-${LIFECYCLE_FIRST_DAYS} days`,
      n.created_at, `-${LIFECYCLE_FIRST_DAYS} days`, n.last_check_at,
    ).first();
    if (!due) continue;
    if (n.last_check_at) {
      const recent = await db.prepare("SELECT 1 AS ok WHERE datetime(?) > datetime('now', ?)")
        .bind(n.last_check_at, `-${LIFECYCLE_INTERVAL_DAYS} days`).first();
      if (recent) continue;
    }
    checked++;

    // 最近 3 次成功同步的时间界：节点 last_seen 早于它 → 视为“这 3 次都没出现”
    const threshold = await db.prepare(
      `SELECT created_at FROM sync_tasks WHERE source_id = ? AND status = 'success'
        ORDER BY created_at DESC LIMIT 1 OFFSET 2`,
    ).bind(n.source_id).first();

    let present = true;
    if (threshold) {
      const seen = await db.prepare("SELECT 1 AS ok WHERE datetime(?) >= datetime(?)")
        .bind(n.last_seen, threshold.created_at).first();
      present = !!seen;
    }

    if (present) {
      if ((n.state || "ok") !== "ok" || Number(n.fail_streak || 0) > 0) {
        await db.prepare(
          `INSERT INTO node_lifecycle(node_id, source_id, fail_streak, first_check_at, last_check_at, state, updated_at)
           VALUES(?,?,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'ok',CURRENT_TIMESTAMP)
           ON CONFLICT(node_id) DO UPDATE SET fail_streak=0, observation_started_at=NULL, state='ok',
             last_check_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`,
        ).bind(n.id, n.source_id).run();
        observing++;
      } else {
        await db.prepare(
          `INSERT INTO node_lifecycle(node_id, source_id, fail_streak, first_check_at, last_check_at, state)
           VALUES(?,?,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'ok')
           ON CONFLICT(node_id) DO UPDATE SET last_check_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`,
        ).bind(n.id, n.source_id).run();
      }
      continue;
    }

    failed++;
    const streak = Number(n.fail_streak || 0) + 1;
    if (streak < LIFECYCLE_FAIL_STREAK) {
      await db.prepare(
        `INSERT INTO node_lifecycle(node_id, source_id, fail_streak, first_check_at, last_check_at, state, updated_at)
         VALUES(?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'ok',CURRENT_TIMESTAMP)
         ON CONFLICT(node_id) DO UPDATE SET fail_streak=?, last_check_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP`,
      ).bind(n.id, n.source_id, streak, streak).run();
    } else if (!n.observation_started_at) {
      await db.prepare(
        `INSERT INTO node_lifecycle(node_id, source_id, fail_streak, first_check_at, last_check_at, observation_started_at, state, updated_at)
         VALUES(?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,'observation',CURRENT_TIMESTAMP)
         ON CONFLICT(node_id) DO UPDATE SET fail_streak=?, observation_started_at=CURRENT_TIMESTAMP,
           last_check_at=CURRENT_TIMESTAMP, state='observation', updated_at=CURRENT_TIMESTAMP`,
      ).bind(n.id, n.source_id, streak, streak).run();
    } else {
      const expired = await db.prepare("SELECT 1 AS ok WHERE datetime(?) <= datetime('now', ?)")
        .bind(n.observation_started_at, `-${LIFECYCLE_OBSERVE_DAYS} days`).first();
      if (expired) {
        await db.prepare(
          `UPDATE node_lifecycle SET state='stale', stale_at=COALESCE(stale_at, CURRENT_TIMESTAMP),
                  fail_streak=?, last_check_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
            WHERE node_id = ?`,
        ).bind(streak, n.id).run();
        stale++;
        await auditStmt(db, ctx || { actorId: "cron", effectiveId: null, requestId: "" }, {
          action: "node.lifecycle.stale", targetType: "node", targetId: n.id,
          after: { state: "stale", fail_streak: streak }, detail: "观察期结束仍不在订阅中，仅标记不删除",
        }).run().catch(() => {});
      } else {
        await db.prepare(
          "UPDATE node_lifecycle SET fail_streak=?, last_check_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE node_id=?",
        ).bind(streak, n.id).run();
      }
    }
  }
  // 自动清理：只清理「已被确认失效（stale）且超过 30 天」的节点，其它一律保留
  let purged = 0;
  try {
    const rows = await db.prepare(
      `SELECT node_id FROM node_lifecycle
        WHERE state='stale' AND stale_at IS NOT NULL AND datetime(stale_at) <= datetime('now','-30 days') LIMIT 200`,
    ).all();
    for (const r of rows.results || []) {
      await db.prepare("DELETE FROM node_records WHERE id = ?").bind(r.node_id).run();
      await db.prepare("DELETE FROM node_lifecycle WHERE node_id = ?").bind(r.node_id).run();
      purged++;
    }
    if (purged) {
      await auditStmt(db, ctx || { actorId: "cron", effectiveId: null, requestId: "" }, {
        action: "node.lifecycle.purge", targetType: "node", targetId: "-",
        after: { purged }, detail: "失效满 30 天，自动清理",
      }).run().catch(() => {});
    }
  } catch { /* 表未建时忽略 */ }

  return { checked, failed, observing, stale, purged };
}

async function superNodeLifecycleRoute(req, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.split("/").filter(Boolean);   // api,super,node-lifecycle,<nodeId>,restore

  if (seg.length === 5 && seg[4] === "restore" && req.method === "POST") {
    const nodeId = s(seg[3], 80);
    if (!validId(nodeId)) return fail("节点 ID 无效", 400);
    const row = await db.prepare("SELECT node_id, state FROM node_lifecycle WHERE node_id = ?").bind(nodeId).first();
    if (!row) return fail("没有该节点的生命周期记录", 404);
    await userBatch(db, ctx, [
      db.prepare(
        `UPDATE node_lifecycle SET state='ok', fail_streak=0, observation_started_at=NULL,
                stale_at=NULL, updated_at=CURRENT_TIMESTAMP WHERE node_id = ?`,
      ).bind(nodeId),
      auditStmt(db, ctx, {
        action: "node.lifecycle.restore", targetType: "node", targetId: nodeId,
        before: { state: row.state }, after: { state: "ok" }, detail: "管理员手动恢复",
      }),
    ]);
    return json({ ok: true, data: { node_id: nodeId, state: "ok" } });
  }

  if (req.method !== "GET") return fail("接口不存在", 404);
  const state = s(url.searchParams.get("state"), 20);
  const where = state ? " WHERE state = ?" : "";
  const binds = state ? [state] : [];
  const counts = await db.prepare(
    "SELECT state, COUNT(*) AS n FROM node_lifecycle GROUP BY state",
  ).all();
  const rows = await db.prepare(
    `SELECT l.node_id, l.source_id, l.state, l.fail_streak, l.first_check_at, l.last_check_at,
            l.observation_started_at, l.stale_at, n.name
       FROM node_lifecycle l LEFT JOIN node_records n ON n.id = l.node_id
       ${where.replace("state", "l.state")} ORDER BY l.updated_at DESC LIMIT 100`,
  ).bind(...binds).all();
  return json({ ok: true, data: rows.results || [], counts: counts.results || [] });
}

/* ────────────────────────────── APP 用户授权 ────────────────────────────── */
/**
 * 规则：
 * - APP 卡密核销 → 生成一条独立授权（device_id 为 APP 用户身份）。
 * - 到期当天停止下发；本地节点保留 24 小时后才允许清理（purge_at = expires_at + 24h）。
 * - 新卡密是**新授权**，不复用旧授权实例。
 * - 卡密：必须 normal、未手动停用、未使用、未过期。
 */

const ENT_LOCAL_RETENTION_HOURS = 24;

function b64url(bytes) {
  return b64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 授权令牌：HMAC(pepper, entitlementId|deviceId)，防止别人拿到 device_id 就冒用 */
async function entToken(env, entitlementId, deviceId) {
  const secret = String(env.APP_HMAC_SECRET || env.SESSION_PEPPER || "");
  if (secret.length < 32) {
    throw sessionError("SECRET_NOT_CONFIGURED", "APP_HMAC_SECRET/SESSION_PEPPER 未配置或长度不足");
  }
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${entitlementId}|${deviceId}`));
  return b64url(new Uint8Array(sig));
}
async function verifyEntToken(env, entitlementId, deviceId, token) {
  if (!token) return false;
  const expect = await entToken(env, entitlementId, deviceId);
  return timingSafeEqual(String(token), expect);
}

async function appRedeemRoute(req, env, url, ctx) {
  const db = env.DB;
  if (url.pathname === "/api/app/redeem" && req.method === "POST") {
    const body = await readJson(req);
    const code = s(body.code, 40).toUpperCase();
    const deviceId = s(body.device_id, 80);
    if (!/^[A-Z0-9]{8,24}$/.test(code)) return fail("卡密格式不正确", 400);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) return fail("设备标识无效", 400);

    const card = await db.prepare(
      "SELECT id, admin_user_id, days, status, manual_disabled, activated_at, used_at, expires_at FROM app_cards WHERE code = ?",
    ).bind(code).first();
    if (!card) return fail("卡密不存在", 404);
    if (card.manual_disabled) return fail("卡密已停用", 409, { code: "CARD_DISABLED" });
    if (card.activated_at || card.used_at || card.status === "used") return fail("卡密已被使用", 409, { code: "CARD_USED" });
    if (card.status !== "normal") return fail("卡密当前不可用", 409, { code: "CARD_INACTIVE" });
    const notExpired = await db.prepare("SELECT 1 AS ok WHERE datetime(?) > datetime('now')").bind(card.expires_at).first();
    if (!notExpired) return fail("卡密已过期", 410, { code: "CARD_EXPIRED" });

    const days = Number(card.days);
    const id = newId();
    // Validate the APP token secret before consuming the card or creating the entitlement.
    const token = await entToken(env, id, deviceId);
    await userBatch(db, ctx, [
      assertStmt(db, "EXISTS (SELECT 1 FROM app_cards WHERE id = ? AND status='normal' AND manual_disabled=0 AND activated_at IS NULL AND used_at IS NULL)", [card.id]),
      db.prepare(
        `UPDATE app_cards SET status='used', activated_at=CURRENT_TIMESTAMP, used_at=CURRENT_TIMESTAMP
          WHERE id = ? AND status='normal' AND activated_at IS NULL AND used_at IS NULL`,
      ).bind(card.id),
      db.prepare(
        `INSERT INTO app_entitlements(id, admin_user_id, device_id, card_id, starts_at, expires_at, purge_at, status)
         VALUES(?,?,?,?, CURRENT_TIMESTAMP, datetime('now', ?), datetime('now', ?), 'active')`,
      ).bind(id, card.admin_user_id, deviceId, card.id, `+${days} days`, `+${days + 1} days`),
      // 激活过一次 → 永久保留该管理员的免费分组资格（卡密过期也不收回）
      db.prepare("INSERT OR IGNORE INTO app_free_grants(device_id, admin_user_id) VALUES(?,?)").bind(deviceId, card.admin_user_id),
    ]);
    await db.prepare(
      "INSERT INTO app_card_events(card_id, admin_user_id, action, detail, device_id) VALUES(?,?,?,?,?)",
    ).bind(card.id, card.admin_user_id, "activate", `${days} 天`, deviceId).run().catch(() => {});
    const ent = await db.prepare(
      "SELECT id, expires_at, purge_at, status FROM app_entitlements WHERE id = ?",
    ).bind(id).first();
    return json({
      ok: true,
      data: {
        entitlement: ent,
        admin_user_id: card.admin_user_id,
        token,
        days,
        local_retention_hours: ENT_LOCAL_RETENTION_HOURS,
        note: "到期后停止更新，本地节点保留 24 小时；新卡密属于新授权",
      },
    }, 201);
  }

  if (url.pathname === "/api/app/status" && req.method === "GET") {
    const deviceId = s(url.searchParams.get("device_id"), 80);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) return fail("设备标识无效", 400);
    const row = await db.prepare(
      `SELECT id, expires_at, purge_at, status,
              (SELECT 1 FROM app_entitlements e2 WHERE e2.device_id = e1.device_id AND e2.status='active' AND datetime(e2.expires_at) > datetime('now') LIMIT 1) AS active
         FROM app_entitlements e1 WHERE device_id = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(deviceId).first();
    if (!row) return fail("该设备没有授权", 404);
    return json({ ok: true, data: { ...row, active: row.active === 1 || row.active === true } });
  }

  // 节点下发：按授权返回该管理员「已分配 + 已批准 + 已启用」来源下的节点，按来源分组
  if (url.pathname === "/api/app/nodes" && req.method === "GET") {
    const deviceId = s(url.searchParams.get("device_id"), 80);
    const token = s(url.searchParams.get("token"), 200);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) return fail("设备标识无效", 400);
    const ent = await db.prepare(
      `SELECT id, admin_user_id, expires_at, status FROM app_entitlements
        WHERE device_id = ? AND status = 'active' AND datetime(expires_at) > datetime('now')
        ORDER BY created_at DESC LIMIT 1`,
    ).bind(deviceId).first();
    if (!ent) return fail("授权已过期或不存在", 403, { code: "ENTITLEMENT_EXPIRED" });
    if (!(await verifyEntToken(env, ent.id, deviceId, token))) {
      return fail("授权令牌无效", 403, { code: "BAD_TOKEN" });
    }

    const rows = await db.prepare(
      `SELECT s.name AS group_name, n.id, n.name, n.protocol, n.server, n.port, n.uri, n.tier
         FROM source_ownership so
         JOIN subscription_sources s ON s.id = so.source_id
         JOIN node_records n ON n.source_id = s.id
        WHERE so.user_id = ? AND s.enabled = 1 AND n.enabled = 1
          AND NOT EXISTS (SELECT 1 FROM source_approvals a WHERE a.source_id = s.id AND a.status <> 'approved')
        ORDER BY s.priority ASC, n.name ASC LIMIT 2000`,
    ).bind(ent.admin_user_id).all();

    const groups = new Map();
    for (const r of rows.results || []) {
      if (!groups.has(r.group_name)) groups.set(r.group_name, []);
      groups.get(r.group_name).push({
        id: r.id, name: r.name, protocol: r.protocol, server: r.server, port: r.port, uri: r.uri, tier: r.tier,
      });
    }
    return json({
      ok: true,
      data: {
        expires_at: ent.expires_at,
        purge_at: null,
        groups: [...groups.entries()].map(([name, nodes]) => ({ name, locked: true, nodes })),
        total_nodes: rows.results?.length || 0,
      },
    });
  }

  return fail("接口不存在", 404);
}

/** Cron：到期转 expired（purge_at 起 24h 后可清理） */
async function runEntitlementMaintenance(db) {
  const expired = await db.prepare(
    `UPDATE app_entitlements SET status='expired'
      WHERE status='active' AND datetime(expires_at) <= datetime('now')`,
  ).run();
  const purgeable = await db.prepare(
    `UPDATE app_entitlements SET status='purged'
      WHERE status='expired' AND purge_at IS NOT NULL AND datetime(purge_at) <= datetime('now')`,
  ).run();
  return { expired: Number(expired.meta?.changes || 0), purged: Number(purgeable.meta?.changes || 0) };
}

/* ────────────────────────────── 一键建表（幂等）────────────────────────────── */
/**
 * 让不懂 SQL 的人也能把新表建好：超管在后台点一次按钮即可。
 * 全部是 CREATE TABLE/INDEX IF NOT EXISTS 与一次 ADD COLUMN 尝试，可重复执行。
 */

const MIGRATE_STATEMENTS = [
  ["convert_links", `CREATE TABLE IF NOT EXISTS convert_links (
    id TEXT PRIMARY KEY, payload TEXT NOT NULL, targets TEXT NOT NULL DEFAULT '',
    group_name TEXT NOT NULL DEFAULT '默认分组', owner_user_id TEXT,
    ip_hash TEXT NOT NULL DEFAULT '', hits INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, last_used_at TEXT,
    expires_at TEXT NOT NULL, revoked_at TEXT)`],
  ["ix_convert_links_expires", "CREATE INDEX IF NOT EXISTS ix_convert_links_expires ON convert_links(expires_at)"],
  ["ix_convert_links_ip", "CREATE INDEX IF NOT EXISTS ix_convert_links_ip ON convert_links(ip_hash, created_at)"],
  ["ix_convert_links_group", "CREATE INDEX IF NOT EXISTS ix_convert_links_group ON convert_links(group_name)"],
  ["admin_vip_cards", `CREATE TABLE IF NOT EXISTS admin_vip_cards (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, days INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'unused', note TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    used_by TEXT, used_at TEXT)`],
  ["ix_vip_cards_status", "CREATE INDEX IF NOT EXISTS ix_vip_cards_status ON admin_vip_cards(status, created_at)"],
  ["admin_vip_activations", `CREATE TABLE IF NOT EXISTS admin_vip_activations (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, card_id TEXT, days INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'formal', starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ends_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["ix_vip_activations_user", "CREATE INDEX IF NOT EXISTS ix_vip_activations_user ON admin_vip_activations(user_id, ends_at)"],
  ["app_cards", `CREATE TABLE IF NOT EXISTS app_cards (
    id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, admin_user_id TEXT NOT NULL,
    days INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'normal',
    inactive_reason TEXT NOT NULL DEFAULT '', inactive_at TEXT, restored_at TEXT,
    manual_disabled INTEGER NOT NULL DEFAULT 0, expires_at TEXT, activated_at TEXT,
    used_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["ix_app_cards_admin", "CREATE INDEX IF NOT EXISTS ix_app_cards_admin ON app_cards(admin_user_id, status)"],
  ["ix_app_cards_code", "CREATE INDEX IF NOT EXISTS ix_app_cards_code ON app_cards(code)"],
  ["node_lifecycle", `CREATE TABLE IF NOT EXISTS node_lifecycle (
    node_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, fail_streak INTEGER NOT NULL DEFAULT 0,
    first_check_at TEXT, last_check_at TEXT, observation_started_at TEXT, stale_at TEXT,
    state TEXT NOT NULL DEFAULT 'ok', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["ix_node_lifecycle_state", "CREATE INDEX IF NOT EXISTS ix_node_lifecycle_state ON node_lifecycle(state)"],
  ["ix_node_lifecycle_source", "CREATE INDEX IF NOT EXISTS ix_node_lifecycle_source ON node_lifecycle(source_id)"],
  ["app_entitlements", `CREATE TABLE IF NOT EXISTS app_entitlements (
    id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL, device_id TEXT NOT NULL, card_id TEXT NOT NULL,
    starts_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at TEXT NOT NULL, purge_at TEXT,
    status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["ix_app_ent_device", "CREATE INDEX IF NOT EXISTS ix_app_ent_device ON app_entitlements(device_id, status)"],
  ["ix_app_ent_admin", "CREATE INDEX IF NOT EXISTS ix_app_ent_admin ON app_entitlements(admin_user_id, status)"],
  ["ix_app_ent_expires", "CREATE INDEX IF NOT EXISTS ix_app_ent_expires ON app_entitlements(expires_at)"],
  ["rate_limits", `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket TEXT PRIMARY KEY, count INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["app_links", `CREATE TABLE IF NOT EXISTS app_links (
    id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL, title TEXT NOT NULL, url TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 100, enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["ix_app_links_admin", "CREATE INDEX IF NOT EXISTS ix_app_links_admin ON app_links(admin_user_id, sort)"],
  ["app_groups", `CREATE TABLE IF NOT EXISTS app_groups (
    id TEXT PRIMARY KEY, admin_user_id TEXT NOT NULL, name TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'assigned', sort INTEGER NOT NULL DEFAULT 100,
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["ix_app_groups_admin", "CREATE INDEX IF NOT EXISTS ix_app_groups_admin ON app_groups(admin_user_id, sort)"],
  ["app_group_sources", "CREATE TABLE IF NOT EXISTS app_group_sources (group_id TEXT NOT NULL, source_id TEXT NOT NULL, PRIMARY KEY (group_id, source_id))"],
  ["app_group_members", "CREATE TABLE IF NOT EXISTS app_group_members (group_id TEXT NOT NULL, device_id TEXT NOT NULL, PRIMARY KEY (group_id, device_id))"],
  ["app_free_grants", "CREATE TABLE IF NOT EXISTS app_free_grants (device_id TEXT NOT NULL, admin_user_id TEXT NOT NULL, granted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (device_id, admin_user_id))"],
  ["admin_share_codes", `CREATE TABLE IF NOT EXISTS admin_share_codes (
    admin_user_id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["ix_admin_share_codes_code", "CREATE INDEX IF NOT EXISTS ix_admin_share_codes_code ON admin_share_codes(code)"],
  ["download_links", `CREATE TABLE IF NOT EXISTS download_links (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'global', admin_user_id TEXT,
    title TEXT NOT NULL, url TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 100,
    enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["ix_download_links_scope", "CREATE INDEX IF NOT EXISTS ix_download_links_scope ON download_links(scope, admin_user_id, sort)"],
  ["app_card_events", `CREATE TABLE IF NOT EXISTS app_card_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, card_id TEXT NOT NULL, admin_user_id TEXT NOT NULL,
    action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT '', device_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["ix_card_events_card", "CREATE INDEX IF NOT EXISTS ix_card_events_card ON app_card_events(card_id, created_at)"],
  ["releases", `CREATE TABLE IF NOT EXISTS releases (
    id TEXT PRIMARY KEY, platform TEXT NOT NULL DEFAULT 'android', version_code INTEGER NOT NULL,
    version_name TEXT NOT NULL, min_version_code INTEGER NOT NULL DEFAULT 0, url TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '', force INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["announcements", `CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL DEFAULT 'web', title TEXT NOT NULL, body TEXT NOT NULL DEFAULT '',
    level TEXT NOT NULL DEFAULT 'info', active INTEGER NOT NULL DEFAULT 1, starts_at TEXT, ends_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
  ["admin_app_perms", `CREATE TABLE IF NOT EXISTS admin_app_perms (
    admin_user_id TEXT PRIMARY KEY, links_enabled INTEGER NOT NULL DEFAULT 1,
    max_links INTEGER NOT NULL DEFAULT 1, free_group_enabled INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`],
];

const REQUIRED_TABLES = ["download_links", 
  "convert_links", "admin_vip_cards", "admin_vip_activations", "app_cards", "node_lifecycle",
  "app_entitlements", "rate_limits", "app_links", "admin_app_perms", "app_groups",
  "app_group_sources", "app_group_members", "app_free_grants", "admin_share_codes",
  "releases", "announcements", "app_card_events",
];

async function migrateRoute(req, env, url, ctx) {
  const db = env.DB;

  if (url.pathname === "/api/super/schema-status" && req.method === "GET") {
    const rows = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(() => "?").join(",")})`,
    ).bind(...REQUIRED_TABLES).all();
    const have = (rows.results || []).map(r => r.name);
    return json({
      ok: true,
      data: {
        ready: REQUIRED_TABLES.every(t => have.includes(t)),
        have, missing: REQUIRED_TABLES.filter(t => !have.includes(t)),
      },
    });
  }

  if (url.pathname === "/api/super/migrate" && req.method === "POST") {
    const body = await readJson(req, { allowEmpty: true });
    if (body.confirm !== "yes") return fail("需要确认参数 confirm=yes", 400);
    const done = [];
    const skipped = [];
    const errors = [];
    for (const [name, sql] of MIGRATE_STATEMENTS) {
      try {
        await db.prepare(sql).run();
        done.push(name);
      } catch (e) {
        const msg = String(e?.message || "");
        if (/already exists|duplicate column/i.test(msg)) skipped.push(name);
        else errors.push({ name, error: msg.slice(0, 160) });
      }
    }
    // 旧版 convert_links 可能缺列：逐个尝试补齐（已存在会报 duplicate column，忽略）
    let addedOwner = false;
    for (const [col, ddl] of [
      ["owner_user_id", "ALTER TABLE convert_links ADD COLUMN owner_user_id TEXT"],
      ["owner_key", "ALTER TABLE convert_links ADD COLUMN owner_key TEXT"],
    ]) {
      try {
        await db.prepare(ddl).run();
        addedOwner = true;
      } catch (e) {
        if (!/duplicate column|already exists/i.test(String(e?.message || ""))) {
          errors.push({ name: `convert_links.${col}`, error: String(e?.message || "").slice(0, 160) });
        }
      }
    }
    try { await db.prepare("CREATE INDEX IF NOT EXISTS ix_convert_links_owner ON convert_links(owner_key, group_name)").run(); } catch {}
    for (const ddl of [
      "ALTER TABLE node_sync_logs ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'manual'",
      "ALTER TABLE node_sync_logs ADD COLUMN duration_ms INTEGER NOT NULL DEFAULT 0",
      "ALTER TABLE node_sync_logs ADD COLUMN missing_nodes INTEGER NOT NULL DEFAULT 0",
    ]) { try { await db.prepare(ddl).run(); } catch {} }
    try { await db.prepare("ALTER TABLE admin_app_perms ADD COLUMN free_group_enabled INTEGER NOT NULL DEFAULT 0").run(); } catch {}
    const rows = await db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${REQUIRED_TABLES.map(() => "?").join(",")})`,
    ).bind(...REQUIRED_TABLES).all();
    const have = (rows.results || []).map(r => r.name);
    const missing = REQUIRED_TABLES.filter(t => !have.includes(t));
    await auditStmt(db, ctx, {
      action: "schema.migrate", targetType: "schema", targetId: "v1",
      after: { done: done.length, skipped: skipped.length, missing: missing.length, addedOwner },
      detail: missing.length ? `仍缺：${missing.join(",")}` : "全部就绪",
    }).run().catch(() => {});
    return json({
      ok: missing.length === 0 && errors.length === 0,
      data: { ready: missing.length === 0, done, skipped, errors, missing, owner_column_added: addedOwner },
    }, missing.length === 0 && errors.length === 0 ? 200 : 500);
  }

  return fail("接口不存在", 404);
}

/* ────────────────────────────── 站内提醒（后台横幅）────────────────────────────── */
/**
 * 不依赖 Telegram / 邮件：登录后台时计算一次，展示在顶部。
 * 覆盖：额度将尽、节点标记失效、APP 卡密因 VIP 到期失活、授权即将到期。
 */

async function superAlertsRoute(req, env, url, ctx) {
  const db = env.DB;
  if (req.method !== "GET") return fail("接口不存在", 404);
  const alerts = [];

  // 1) 额度剩余 < 10%
  try {
    const rows = await db.prepare(
      `SELECT q.source_id, s.name, q.total_bytes, q.remaining_bytes,
              CAST(q.remaining_bytes AS REAL) / NULLIF(q.total_bytes, 0) AS ratio
         FROM source_quota q LEFT JOIN subscription_sources s ON s.id = q.source_id
        WHERE q.total_bytes > 0 AND q.remaining_bytes IS NOT NULL
          AND CAST(q.remaining_bytes AS REAL) / q.total_bytes < 0.1
        LIMIT 50`,
    ).all();
    const list = rows.results || [];
    if (list.length) {
      alerts.push({
        level: list.some(r => r.remaining_bytes <= 0) ? "bad" : "warn",
        type: "quota", count: list.length,
        title: `${list.length} 个来源流量将尽`,
        items: list.map(r => `${r.name || r.source_id}：剩余 ${Math.round((r.ratio || 0) * 100)}%`),
      });
    }
  } catch { /* 表未建时忽略 */ }

  // 2) 节点被标记失效
  try {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM node_lifecycle WHERE state = 'stale'").first();
    if (Number(row?.n || 0) > 0) {
      alerts.push({ level: "warn", type: "node", count: Number(row.n), title: `${row.n} 个节点被标记失效`, items: [] });
    }
  } catch {}

  // 3) APP 卡密因 VIP 到期失活
  try {
    const row = await db.prepare(
      "SELECT COUNT(*) AS n FROM app_cards WHERE status='inactive' AND inactive_reason='admin_vip_expired'",
    ).first();
    if (Number(row?.n || 0) > 0) {
      alerts.push({ level: "warn", type: "app_card", count: Number(row.n), title: `${row.n} 张 APP 卡密因 VIP 到期失活`, items: [] });
    }
  } catch {}

  // 4) 授权 7 天内到期
  try {
    const rows = await db.prepare(
      `SELECT device_id, expires_at FROM app_entitlements
        WHERE status='active' AND datetime(expires_at) <= datetime('now','+7 days') LIMIT 50`,
    ).all();
    const list = rows.results || [];
    if (list.length) {
      alerts.push({
        level: "info", type: "entitlement", count: list.length,
        title: `${list.length} 个 APP 授权 7 天内到期`,
        items: list.slice(0, 10).map(r => `${r.device_id}：${String(r.expires_at).slice(0, 10)}`),
      });
    }
  } catch {}

  const total = alerts.reduce((n, a) => n + a.count, 0);
  return json({ ok: true, data: { total, alerts, checked_at: new Date().toISOString() } });
}

/* ────────────────────────────── APP 入口链接与管理员权限 ────────────────────────────── */
/**
 * 管理员给自己名下的 APP 用户配置入口：使用说明 / 客服 / 购买卡密 等。
 * 超管可以替任意管理员维护，并能关闭某管理员的这项能力（links_enabled）与数量上限（max_links）。
 */

const APP_LINK_TITLE_MAX = 30;
const APP_LINK_SORT_DEFAULT = 100;

function validHttpUrl(raw) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (!u.hostname || u.hostname.includes(" ")) return null;
    return u.toString();
  } catch { return null; }
}

async function adminPerms(db, adminId) {
  const row = await db.prepare("SELECT links_enabled, max_links, free_group_enabled FROM admin_app_perms WHERE admin_user_id = ?").bind(adminId).first();
  return {
    links_enabled: row ? Number(row.links_enabled) === 1 : true,
    max_links: Number(row?.max_links ?? 1),
    free_group_enabled: row ? Number(row.free_group_enabled) === 1 : false,
  };
}

async function listAppLinks(db, adminId) {
  const rows = await db.prepare(
    "SELECT id, title, url, sort, enabled, created_at FROM app_links WHERE admin_user_id = ? ORDER BY sort ASC, created_at ASC",
  ).bind(adminId).all();
  return rows.results || [];
}

async function addAppLink(db, ctx, adminId, body) {
  const perms = await adminPerms(db, adminId);
  if (!perms.links_enabled) return fail("该管理员未启用 APP 入口链接", 403, { code: "LINKS_DISABLED" });
  const title = s(body.title, APP_LINK_TITLE_MAX);
  const url = validHttpUrl(body.url);
  if (!title) return fail("标题不能为空", 400);
  if (!url) return fail("链接必须是 http(s) 地址", 400);
  const count = await db.prepare("SELECT COUNT(*) AS n FROM app_links WHERE admin_user_id = ?").bind(adminId).first();
  if (Number(count?.n || 0) >= perms.max_links) return fail(`最多 ${perms.max_links} 个入口`, 409, { code: "LINKS_LIMIT" });
  const id = newId();
  await db.prepare(
    "INSERT INTO app_links(id, admin_user_id, title, url, sort) VALUES(?,?,?,?,?)",
  ).bind(id, adminId, title, url, Number(body.sort) || APP_LINK_SORT_DEFAULT).run();
  await auditStmt(db, ctx, {
    action: "app_link.create", targetType: "app_link", targetId: id,
    after: { title, url, admin: adminId }, detail: "APP 入口链接",
  }).run().catch(() => {});
  return json({ ok: true, data: { id, title, url } }, 201);
}

/* 管理员自己 */
async function userAppLinksRoute(req, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.split("/").filter(Boolean);   // api,user,app-links,...
  if (seg.length === 3 && req.method === "GET") {
    return json({ ok: true, data: await listAppLinks(db, ctx.effectiveId), perms: await adminPerms(db, ctx.effectiveId) });
  }
  if (seg.length === 3 && req.method === "POST") {
    return addAppLink(db, ctx, ctx.effectiveId, await readJson(req));
  }
  if (seg.length === 4 && req.method === "DELETE") {
    const id = s(seg[3], 80);
    const row = await db.prepare("SELECT id FROM app_links WHERE id = ? AND admin_user_id = ?").bind(id, ctx.effectiveId).first();
    if (!row) return fail("入口不存在", 404);
    const cutoff = ctx.appAuthorization?.formalCutoff || null;
    const deleted = cutoff
      ? await db.prepare("DELETE FROM app_links WHERE id = ? AND admin_user_id = ? AND datetime(created_at) <= datetime(?)")
          .bind(id, ctx.effectiveId, cutoff).run()
      : await db.prepare("DELETE FROM app_links WHERE id = ? AND admin_user_id = ?")
          .bind(id, ctx.effectiveId).run();
    if (!deleted.meta?.changes) return fail("入口已变化或不符合历史删除范围", 409);
    return json({ ok: true, data: { id, deleted: true } });
  }
  return fail("接口不存在", 404);
}

/* 超管 */
async function superAppLinksRoute(req, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.split("/").filter(Boolean);   // api,super,app-links | app-perms | app-entitlements

  if (seg[2] === "app-links" && seg.length === 3 && req.method === "GET") {
    const adminId = s(url.searchParams.get("admin"), 80);
    const rows = adminId
      ? await listAppLinks(db, adminId)
      : (await db.prepare(
        `SELECT l.*, u.username FROM app_links l LEFT JOIN app_users u ON u.id = l.admin_user_id
          ORDER BY l.admin_user_id, l.sort LIMIT 500`).all()).results || [];
    return json({ ok: true, data: rows });
  }
  if (seg[2] === "app-links" && seg.length === 3 && req.method === "POST") {
    const body = await readJson(req);
    const adminId = s(body.admin_user_id, 80);
    if (!validId(adminId)) return fail("管理员 ID 无效", 400);
    if (!(await db.prepare("SELECT 1 AS ok FROM app_users WHERE id = ?").bind(adminId).first())) return fail("管理员不存在", 404);
    return addAppLink(db, ctx, adminId, body);
  }
  if (seg[2] === "app-links" && seg.length === 4 && req.method === "DELETE") {
    const id = s(seg[3], 80);
    const row = await db.prepare("SELECT id FROM app_links WHERE id = ?").bind(id).first();
    if (!row) return fail("入口不存在", 404);
    await db.prepare("DELETE FROM app_links WHERE id = ?").bind(id).run();
    return json({ ok: true, data: { id, deleted: true } });
  }
  if (seg[2] === "app-perms" && seg.length === 4 && req.method === "PUT") {
    const adminId = s(seg[3], 80);
    if (!validId(adminId)) return fail("管理员 ID 无效", 400);
    const body = await readJson(req);
    const enabled = body.links_enabled === undefined ? 1 : (body.links_enabled ? 1 : 0);
    const maxLinks = num(body.max_links, 1);
    if (!Number.isInteger(maxLinks) || maxLinks < 0 || maxLinks > 10) return fail("max_links 需为 0-10", 400);
    const cur = await db.prepare("SELECT free_group_enabled FROM admin_app_perms WHERE admin_user_id = ?").bind(adminId).first();
    const freeGroup = body.free_group_enabled === undefined
      ? (cur ? Number(cur.free_group_enabled) : 0)
      : (body.free_group_enabled ? 1 : 0);
    await db.prepare(
      `INSERT INTO admin_app_perms(admin_user_id, links_enabled, max_links, free_group_enabled) VALUES(?,?,?,?)
       ON CONFLICT(admin_user_id) DO UPDATE SET links_enabled=excluded.links_enabled, max_links=excluded.max_links,
         free_group_enabled=excluded.free_group_enabled, updated_at=CURRENT_TIMESTAMP`,
    ).bind(adminId, enabled, maxLinks, freeGroup).run();
    await auditStmt(db, ctx, {
      action: "app_perm.update", targetType: "user", targetId: adminId,
      after: { links_enabled: enabled, max_links: maxLinks, free_group_enabled: freeGroup },
    }).run().catch(() => {});
    return json({ ok: true, data: { admin_user_id: adminId, links_enabled: enabled, max_links: maxLinks, free_group_enabled: freeGroup } });
  }
  if (seg[2] === "app-entitlements" && seg.length === 5 && seg[4] === "rebind" && req.method === "POST") {
    const id = s(seg[3], 80);
    const body = await readJson(req);
    const deviceId = s(body.device_id, 80);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) return fail("设备标识无效", 400);
    const row = await db.prepare("SELECT id, device_id FROM app_entitlements WHERE id = ?").bind(id).first();
    if (!row) return fail("授权不存在", 404);
    await db.prepare("UPDATE app_entitlements SET device_id = ? WHERE id = ?").bind(deviceId, id).run();
    await auditStmt(db, ctx, {
      action: "app_entitlement.rebind", targetType: "app_entitlement", targetId: id,
      before: { device_id: row.device_id }, after: { device_id: deviceId }, detail: "换绑设备",
    }).run().catch(() => {});
    return json({ ok: true, data: { id, device_id: deviceId, token: await entToken(env, id, deviceId) } });
  }
  return fail("接口不存在", 404);
}

/* 免费分组：管理员开启后，不带卡密也能拿到 tier=free 的节点 */
async function appFreeGroupRoute(req, env, url) {
  const db = env.DB;
  let adminId = s(url.searchParams.get("admin"), 80);
  const code = s(url.searchParams.get("code"), 12).toUpperCase();
  if (!adminId && code) {
    const row = await db.prepare("SELECT admin_user_id FROM admin_share_codes WHERE code = ?").bind(code).first();
    if (!row) return fail("编号不存在", 404);
    adminId = row.admin_user_id;
  }
  if (!validId(adminId)) return fail("管理员参数无效", 400);
  const perms = await adminPerms(db, adminId);
  if (!perms.free_group_enabled) return fail("该管理员未开放免费分组", 403, { code: "FREE_GROUP_DISABLED" });
  const rows = await db.prepare(
    `SELECT s.name AS group_name, n.id, n.name, n.protocol, n.server, n.port, n.uri
       FROM source_ownership so
       JOIN subscription_sources s ON s.id = so.source_id
       JOIN node_records n ON n.source_id = s.id
      WHERE so.user_id = ? AND s.enabled = 1 AND n.enabled = 1 AND n.tier = 'free'
        AND NOT EXISTS (SELECT 1 FROM source_approvals a WHERE a.source_id = s.id AND a.status <> 'approved')
      ORDER BY s.priority ASC, n.name ASC LIMIT 500`,
  ).bind(adminId).all();
  const groups = new Map();
  for (const r of rows.results || []) {
    if (!groups.has(r.group_name)) groups.set(r.group_name, []);
    groups.get(r.group_name).push({ id: r.id, name: r.name, protocol: r.protocol, server: r.server, port: r.port, uri: r.uri });
  }
  return json({
    ok: true,
    data: { free: true, groups: [...groups.entries()].map(([name, nodes]) => ({ name, locked: true, nodes })) },
  });
}

/* APP 端读取（凭授权 token） */
async function appLinksForDevice(req, env, url) {
  const db = env.DB;
  const deviceId = s(url.searchParams.get("device_id"), 80);
  const token = s(url.searchParams.get("token"), 200);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) return fail("设备标识无效", 400);
  const ent = await db.prepare(
    `SELECT id, admin_user_id FROM app_entitlements
      WHERE device_id = ? AND status = 'active' AND datetime(expires_at) > datetime('now')
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(deviceId).first();
  if (!ent) return fail("授权已过期或不存在", 403, { code: "ENTITLEMENT_EXPIRED" });
  if (!(await verifyEntToken(env, ent.id, deviceId, token))) return fail("授权令牌无效", 403, { code: "BAD_TOKEN" });
  const perms = await adminPerms(db, ent.admin_user_id);
  if (!perms.links_enabled) return json({ ok: true, data: [] });
  const rows = await db.prepare(
    "SELECT id, title, url FROM app_links WHERE admin_user_id = ? AND enabled = 1 ORDER BY sort ASC, created_at ASC",
  ).bind(ent.admin_user_id).all();
  const list = rows.results || [];
  if (!list.length) return json({ ok: true, data: [{ id: "default", title: "购买卡密", url: "", default: true }] });
  return json({ ok: true, data: list });
}

/* ────────────────────────────── 管理员自定义 APP 分组 ────────────────────────────── */
/**
 * mode:
 * - public   : 该管理员所有「有效卡密用户」可见
 * - assigned : 仅 app_group_members 里指定的设备可见
 * - free     : 激活过该管理员卡密的设备永久可见（卡密过期仍可用）
 */

const APP_GROUP_MODES = new Set(["public", "assigned", "free"]);

async function groupNodeList(db, groupId) {
  const rows = await db.prepare(
    `SELECT s.name AS source_name, n.id, n.name, n.protocol, n.server, n.port, n.uri, n.tier
       FROM app_group_sources gs
       JOIN subscription_sources s ON s.id = gs.source_id
       JOIN node_records n ON n.source_id = s.id
      WHERE gs.group_id = ? AND s.enabled = 1 AND n.enabled = 1
        AND NOT EXISTS (SELECT 1 FROM source_approvals a WHERE a.source_id = s.id AND a.status <> 'approved')
      ORDER BY n.name ASC LIMIT 2000`,
  ).bind(groupId).all();
  return rows.results || [];
}

async function superAppGroupsRoute(req, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.split("/").filter(Boolean);   // api,super,app-groups,<id>,<sub>,<key>
  const id = seg[3];

  if (seg.length === 3 && req.method === "GET") {
    const adminId = s(url.searchParams.get("admin"), 80);
    const rows = adminId
      ? await db.prepare("SELECT * FROM app_groups WHERE admin_user_id = ? ORDER BY sort ASC, created_at ASC").bind(adminId).all()
      : await db.prepare("SELECT * FROM app_groups ORDER BY admin_user_id, sort ASC LIMIT 500").all();
    return json({ ok: true, data: rows.results || [] });
  }
  if (seg.length === 3 && req.method === "POST") {
    const body = await readJson(req);
    const adminId = s(body.admin_user_id, 80);
    const name = s(body.name, 40);
    const mode = s(body.mode, 20) || "assigned";
    if (!validId(adminId)) return fail("管理员 ID 无效", 400);
    if (!name) return fail("分组名不能为空", 400);
    if (!APP_GROUP_MODES.has(mode)) return fail("mode 只能是 public/assigned/free", 400);
    const gid = newId();
    await db.prepare(
      "INSERT INTO app_groups(id, admin_user_id, name, mode, sort) VALUES(?,?,?,?,?)",
    ).bind(gid, adminId, name, mode, num(body.sort, 100)).run();
    return json({ ok: true, data: { id: gid, name, mode } }, 201);
  }
  if (seg.length === 4 && req.method === "PUT") {
    const body = await readJson(req);
    const row = await db.prepare("SELECT * FROM app_groups WHERE id = ?").bind(id).first();
    if (!row) return fail("分组不存在", 404);
    const name = body.name === undefined ? row.name : s(body.name, 40);
    const mode = body.mode === undefined ? row.mode : s(body.mode, 20);
    const enabled = body.enabled === undefined ? row.enabled : (body.enabled ? 1 : 0);
    const sort = body.sort === undefined ? row.sort : num(body.sort, row.sort);
    if (!APP_GROUP_MODES.has(mode)) return fail("mode 不合法", 400);
    await db.prepare("UPDATE app_groups SET name=?, mode=?, enabled=?, sort=? WHERE id=?").bind(name, mode, enabled, sort, id).run();
    return json({ ok: true, data: { id, name, mode, enabled, sort } });
  }
  if (seg.length === 4 && req.method === "DELETE") {
    await db.prepare("DELETE FROM app_groups WHERE id = ?").bind(id).run();
    await db.prepare("DELETE FROM app_group_sources WHERE group_id = ?").bind(id).run();
    await db.prepare("DELETE FROM app_group_members WHERE group_id = ?").bind(id).run();
    return json({ ok: true, data: { id, deleted: true } });
  }
  if (seg.length === 5 && seg[4] === "sources" && req.method === "POST") {
    const body = await readJson(req);
    const sourceId = s(body.source_id, 80);
    const exists = await db.prepare("SELECT 1 AS ok FROM subscription_sources WHERE id = ?").bind(sourceId).first();
    if (!exists) return fail("来源不存在", 404);
    await db.prepare("INSERT OR IGNORE INTO app_group_sources(group_id, source_id) VALUES(?,?)").bind(id, sourceId).run();
    return json({ ok: true, data: { group_id: id, source_id: sourceId } }, 201);
  }
  if (seg.length === 6 && seg[4] === "sources" && req.method === "DELETE") {
    await db.prepare("DELETE FROM app_group_sources WHERE group_id = ? AND source_id = ?").bind(id, s(seg[5], 80)).run();
    return json({ ok: true, data: { removed: true } });
  }
  if (seg.length === 5 && seg[4] === "members" && req.method === "POST") {
    const body = await readJson(req);
    const deviceId = s(body.device_id, 80);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) return fail("设备标识无效", 400);
    await db.prepare("INSERT OR IGNORE INTO app_group_members(group_id, device_id) VALUES(?,?)").bind(id, deviceId).run();
    return json({ ok: true, data: { group_id: id, device_id: deviceId } }, 201);
  }
  if (seg.length === 6 && seg[4] === "members" && req.method === "DELETE") {
    await db.prepare("DELETE FROM app_group_members WHERE group_id = ? AND device_id = ?").bind(id, s(seg[5], 80)).run();
    return json({ ok: true, data: { removed: true } });
  }
  return fail("接口不存在", 404);
}

/** 管理员管理自己的分组（注册用户也能用） */
async function userAppGroupsRoute(req, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.split("/").filter(Boolean);   // api,user,app-groups,<id>,...
  const id = seg[3];
  const own = async (gid) => {
    const row = await db.prepare("SELECT * FROM app_groups WHERE id = ? AND admin_user_id = ?").bind(gid, ctx.effectiveId).first();
    return row;
  };
  if (seg.length === 3 && req.method === "GET") {
    const rows = await db.prepare("SELECT * FROM app_groups WHERE admin_user_id = ? ORDER BY sort, created_at").bind(ctx.effectiveId).all();
    return json({ ok: true, data: rows.results || [] });
  }
  if (seg.length === 3 && req.method === "POST") {
    const body = await readJson(req);
    const name = s(body.name, 40);
    const mode = s(body.mode, 20) || "assigned";
    if (!name) return fail("分组名不能为空", 400);
    if (!APP_GROUP_MODES.has(mode)) return fail("mode 不合法", 400);
    const gid = newId();
    await db.prepare("INSERT INTO app_groups(id, admin_user_id, name, mode, sort) VALUES(?,?,?,?,?)")
      .bind(gid, ctx.effectiveId, name, mode, num(body.sort, 100)).run();
    return json({ ok: true, data: { id: gid, name, mode } }, 201);
  }
  if (seg.length === 4 && req.method === "PUT") {
    const row = await own(id);
    if (!row) return fail("分组不存在", 404);
    const body = await readJson(req);
    const name = body.name === undefined ? row.name : s(body.name, 40);
    const mode = body.mode === undefined ? row.mode : s(body.mode, 20);
    if (!APP_GROUP_MODES.has(mode)) return fail("mode 不合法", 400);
    const updated = await db.prepare("UPDATE app_groups SET name=?, mode=? WHERE id=? AND admin_user_id=?")
      .bind(name, mode, id, ctx.effectiveId).run();
    if (!updated.meta?.changes) return fail("分组已变化或不属于你", 409);
    return json({ ok: true, data: { id, name, mode } });
  }
  if (seg.length === 4 && req.method === "DELETE") {
    if (!(await own(id))) return fail("分组不存在", 404);
    const cutoff = ctx.appAuthorization?.formalCutoff || null;
    const deleted = cutoff
      ? await db.prepare("DELETE FROM app_groups WHERE id = ? AND admin_user_id = ? AND datetime(created_at) <= datetime(?)")
          .bind(id, ctx.effectiveId, cutoff).run()
      : await db.prepare("DELETE FROM app_groups WHERE id = ? AND admin_user_id = ?")
          .bind(id, ctx.effectiveId).run();
    if (!deleted.meta?.changes) return fail("分组已变化或不符合历史删除范围", 409);
    await db.prepare("DELETE FROM app_group_sources WHERE group_id = ?").bind(id).run();
    await db.prepare("DELETE FROM app_group_members WHERE group_id = ?").bind(id).run();
    return json({ ok: true, data: { deleted: true } });
  }
  if (seg.length === 5 && seg[4] === "sources" && req.method === "POST") {
    if (!(await own(id))) return fail("分组不存在", 404);
    const body = await readJson(req);
    const sourceId = s(body.source_id, 80);
    const src = await db.prepare(
      "SELECT s.id FROM subscription_sources s JOIN source_ownership so ON so.source_id = s.id WHERE s.id = ? AND so.user_id = ?",
    ).bind(sourceId, ctx.effectiveId).first();
    if (!src) return fail("来源不存在或不属于你", 404);
    await db.prepare(
      `INSERT OR IGNORE INTO app_group_sources(group_id, source_id)
       SELECT ?, ? WHERE EXISTS (
         SELECT 1 FROM app_groups WHERE id = ? AND admin_user_id = ?
       ) AND EXISTS (
         SELECT 1 FROM source_ownership WHERE source_id = ? AND user_id = ?
       )`,
    ).bind(id, sourceId, id, ctx.effectiveId, sourceId, ctx.effectiveId).run();
    return json({ ok: true, data: { group_id: id, source_id: sourceId } }, 201);
  }
  if (seg.length === 5 && seg[4] === "members" && req.method === "POST") {
    if (!(await own(id))) return fail("分组不存在", 404);
    const body = await readJson(req);
    const deviceId = s(body.device_id, 80);
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) return fail("设备标识无效", 400);
    await db.prepare(
      `INSERT OR IGNORE INTO app_group_members(group_id, device_id)
       SELECT ?, ? WHERE EXISTS (
         SELECT 1 FROM app_groups WHERE id = ? AND admin_user_id = ?
       )`,
    ).bind(id, deviceId, id, ctx.effectiveId).run();
    return json({ ok: true, data: { group_id: id, device_id: deviceId } }, 201);
  }
  return fail("接口不存在", 404);
}

/** APP：按可见性返回分组与节点 */
async function appGroupsForDevice(req, env, url) {
  const db = env.DB;
  const deviceId = s(url.searchParams.get("device_id"), 80);
  const token = s(url.searchParams.get("token"), 200);
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(deviceId)) return fail("设备标识无效", 400);

  const ent = await db.prepare(
    `SELECT id, admin_user_id FROM app_entitlements
      WHERE device_id = ? AND status = 'active' AND datetime(expires_at) > datetime('now')
      ORDER BY created_at DESC LIMIT 1`,
  ).bind(deviceId).first();
  if (!ent) {
    // 没有有效授权：只能用“激活过且仍保留”的免费分组
    const grants = await db.prepare("SELECT admin_user_id FROM app_free_grants WHERE device_id = ?").bind(deviceId).all();
    if (!(grants.results || []).length) return fail("授权已过期或不存在", 403, { code: "ENTITLEMENT_EXPIRED" });
    const out = [];
    for (const g of grants.results) {
      const rows = await db.prepare("SELECT * FROM app_groups WHERE admin_user_id = ? AND mode = 'free' AND enabled = 1 ORDER BY sort").bind(g.admin_user_id).all();
      for (const grp of rows.results || []) {
        out.push({ id: grp.id, name: grp.name, mode: grp.mode, locked: true, free: true, nodes: await groupNodeList(db, grp.id) });
      }
    }
    return json({ ok: true, data: { entitled: false, groups: out } });
  }
  if (!(await verifyEntToken(env, ent.id, deviceId, token))) return fail("授权令牌无效", 403, { code: "BAD_TOKEN" });

  const groups = await db.prepare(
    `SELECT g.* FROM app_groups g
      WHERE g.admin_user_id = ? AND g.enabled = 1 AND (
        g.mode = 'public'
        OR g.mode = 'free'
        OR (g.mode = 'assigned' AND EXISTS (SELECT 1 FROM app_group_members m WHERE m.group_id = g.id AND m.device_id = ?))
      ) ORDER BY CASE g.mode WHEN 'free' THEN 2 ELSE 0 END, g.sort ASC, g.created_at ASC`,
  ).bind(ent.admin_user_id, deviceId).all();

  const out = [];
  for (const grp of groups.results || []) {
    out.push({ id: grp.id, name: grp.name, mode: grp.mode, locked: true, nodes: await groupNodeList(db, grp.id) });
  }
  return json({ ok: true, data: { entitled: true, admin_user_id: ent.admin_user_id, groups: out } });
}

/* ────────────────────────────── 管理员分享编号 ────────────────────────────── */
/** 6 位编号：用户扫码/手输即可绑定到某个管理员（只用于免费分组与入口链接） */

const SHARE_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeShareCode() {
  const b = crypto.getRandomValues(new Uint8Array(6));
  return [...b].map(x => SHARE_CODE_CHARS[x % SHARE_CODE_CHARS.length]).join("");
}

async function ensureShareCode(db, adminId) {
  const row = await db.prepare("SELECT code FROM admin_share_codes WHERE admin_user_id = ?").bind(adminId).first();
  if (row) return row.code;
  for (let i = 0; i < 5; i++) {
    const code = makeShareCode();
    try {
      await db.prepare("INSERT INTO admin_share_codes(admin_user_id, code) VALUES(?,?)").bind(adminId, code).run();
      return code;
    } catch { /* 撞码重试 */ }
  }
  throw new Error("无法生成编号");
}

async function superShareCodeRoute(req, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.split("/").filter(Boolean);   // api,super,admins,<id>,share-code

  if (seg[2] === "admins" && seg.length === 5 && seg[4] === "share-code" && req.method === "GET") {
    const adminId = s(seg[3], 80);
    if (!validId(adminId)) return fail("管理员 ID 无效", 400);
    const user = await db.prepare("SELECT username FROM app_users WHERE id = ?").bind(adminId).first();
    if (!user) return fail("管理员不存在", 404);
    const code = await ensureShareCode(db, adminId);
    return json({ ok: true, data: { code, username: user.username, bind_url: `xingyue://bind?code=${code}` } });
  }
  return fail("接口不存在", 404);
}

/** 管理员查看自己的编号（注册用户也能用） */
async function userShareCodeRoute(req, env, url, ctx) {
  const db = env.DB;
  if (req.method !== "GET") return fail("接口不存在", 404);
  const code = await ensureShareCode(db, ctx.effectiveId);
  const user = await db.prepare("SELECT username FROM app_users WHERE id = ?").bind(ctx.effectiveId).first();
  return json({ ok: true, data: { code, username: user?.username || "", bind_url: `xingyue://bind?code=${code}` } });
}

/** 公开解析：编号 → 管理员（给 APP 绑定用） */
async function appResolveRoute(req, env, url) {
  const db = env.DB;
  const code = s(url.searchParams.get("code"), 12).toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) return fail("编号格式不正确", 400);
  const row = await db.prepare(
    "SELECT c.admin_user_id, u.username FROM admin_share_codes c LEFT JOIN app_users u ON u.id = c.admin_user_id WHERE c.code = ?",
  ).bind(code).first();
  if (!row) return fail("编号不存在", 404);
  const perms = await db.prepare("SELECT free_group_enabled FROM admin_app_perms WHERE admin_user_id = ?").bind(row.admin_user_id).first();
  return json({
    ok: true,
    data: {
      code, admin_user_id: row.admin_user_id, admin_name: row.username,
      free_group_enabled: perms ? Number(perms.free_group_enabled) === 1 : false,
    },
  });
}

/* ────────────────────────────── APP 版本与公告 ────────────────────────────── */

async function pickLatestRelease(db, platform) {
  return db.prepare(
    "SELECT * FROM releases WHERE platform = ? AND active = 1 ORDER BY version_code DESC LIMIT 1",
  ).bind(platform).first();
}

/** APP 检查更新：current 低于 min_version_code 或该版本标了 force → 强制 */
async function appVersionRoute(req, env, url) {
  const db = env.DB;
  const platform = s(url.searchParams.get("platform"), 20) || "android";
  const current = num(url.searchParams.get("current"), 0);
  const latest = await pickLatestRelease(db, platform);
  if (!latest) return json({ ok: true, data: { update: false } });
  const forced = Number(latest.force) === 1 || (Number(latest.min_version_code) > 0 && current < Number(latest.min_version_code));
  const update = current < Number(latest.version_code);
  return json({
    ok: true,
    data: {
      update,
      force: update && forced,
      version_code: Number(latest.version_code),
      version_name: latest.version_name,
      url: latest.url,
      notes: latest.notes,
      min_version_code: Number(latest.min_version_code),
    },
  });
}

async function announcementsRoute(req, env, url) {
  const db = env.DB;
  const scope = s(url.searchParams.get("scope"), 10) || "web";
  if (!["web", "app", "both"].includes(scope)) return fail("scope 不合法", 400);
  const rows = await db.prepare(
    `SELECT id, scope, title, body, level, created_at FROM announcements
      WHERE active = 1 AND (scope = ? OR scope = 'both')
        AND (starts_at IS NULL OR datetime(starts_at) <= datetime('now'))
        AND (ends_at IS NULL OR datetime(ends_at) > datetime('now'))
      ORDER BY created_at DESC LIMIT 20`,
  ).bind(scope).all();
  return json({ ok: true, data: rows.results || [] });
}

async function superReleasesRoute(req, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.split("/").filter(Boolean);   // api,super,releases|announcements,<id>

  if (seg[2] === "releases") {
    if (seg.length === 3 && req.method === "GET") {
      const rows = await db.prepare("SELECT * FROM releases ORDER BY version_code DESC LIMIT 100").all();
      return json({ ok: true, data: rows.results || [] });
    }
    if (seg.length === 3 && req.method === "POST") {
      const body = await readJson(req);
      const versionCode = num(body.version_code, 0);
      const versionName = s(body.version_name, 40);
      const url0 = s(body.url, 500);
      if (!Number.isInteger(versionCode) || versionCode < 1) return fail("version_code 必须是正整数", 400);
      if (!versionName) return fail("版本名不能为空", 400);
      if (!/^https:\/\/.+/.test(url0)) return fail("下载地址必须是 https", 400);
      const id = newId();
      await db.prepare(
        `INSERT INTO releases(id, platform, version_code, version_name, min_version_code, url, notes, force)
         VALUES(?,?,?,?,?,?,?,?)`,
      ).bind(id, s(body.platform, 20) || "android", versionCode, versionName,
        num(body.min_version_code, 0), url0, s(body.notes, 2000), body.force ? 1 : 0).run();
      return json({ ok: true, data: { id, version_code: versionCode } }, 201);
    }
    if (seg.length === 4 && req.method === "DELETE") {
      await db.prepare("DELETE FROM releases WHERE id = ?").bind(s(seg[3], 80)).run();
      return json({ ok: true, data: { deleted: true } });
    }
  }

  if (seg[2] === "announcements") {
    if (seg.length === 3 && req.method === "GET") {
      const rows = await db.prepare("SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100").all();
      return json({ ok: true, data: rows.results || [] });
    }
    if (seg.length === 3 && req.method === "POST") {
      const body = await readJson(req);
      const title = s(body.title, 80);
      const scope = s(body.scope, 10) || "web";
      if (!title) return fail("标题不能为空", 400);
      if (!["web", "app", "both"].includes(scope)) return fail("scope 不合法", 400);
      const id = newId();
      await db.prepare(
        `INSERT INTO announcements(id, scope, title, body, level, starts_at, ends_at) VALUES(?,?,?,?,?,?,?)`,
      ).bind(id, scope, title, s(body.body, 4000), s(body.level, 10) || "info",
        s(body.starts_at, 30) || null, s(body.ends_at, 30) || null).run();
      return json({ ok: true, data: { id } }, 201);
    }
    if (seg.length === 4 && req.method === "PUT") {
      const body = await readJson(req);
      const id = s(seg[3], 80);
      const row = await db.prepare("SELECT id FROM announcements WHERE id = ?").bind(id).first();
      if (!row) return fail("公告不存在", 404);
      await db.prepare("UPDATE announcements SET active = ? WHERE id = ?").bind(body.active ? 1 : 0, id).run();
      return json({ ok: true, data: { id, active: body.active ? 1 : 0 } });
    }
    if (seg.length === 4 && req.method === "DELETE") {
      await db.prepare("DELETE FROM announcements WHERE id = ?").bind(s(seg[3], 80)).run();
      return json({ ok: true, data: { deleted: true } });
    }
  }
  return fail("接口不存在", 404);
}

/* ────────────────────────────── APP 下载链接 ────────────────────────────── */
/** 超管可放全局下载入口（百度/夸克等，可多条）；管理员也可放自己的。 */

function validDownloadUrl(raw) {
  try {
    const u = new URL(String(raw));
    return (u.protocol === "https:" || u.protocol === "http:") ? u.toString() : null;
  } catch { return null; }
}

async function listDownloads(db, adminId) {
  const rows = await db.prepare(
    `SELECT id, scope, title, url, sort FROM download_links
      WHERE enabled = 1 AND (scope = 'global' OR (scope = 'admin' AND admin_user_id = ?))
      ORDER BY CASE scope WHEN 'admin' THEN 0 ELSE 1 END, sort ASC, created_at ASC`,
  ).bind(adminId || "").all();
  return rows.results || [];
}

async function addDownload(db, ctx, scope, adminId, body) {
  const title = s(body.title, 40);
  const url = validDownloadUrl(body.url);
  if (!title) return fail("标题不能为空", 400);
  if (!url) return fail("链接必须是 http(s) 地址", 400);
  const count = await db.prepare(
    "SELECT COUNT(*) AS n FROM download_links WHERE scope = ? AND COALESCE(admin_user_id,'') = ?",
  ).bind(scope, adminId || "").first();
  if (Number(count?.n || 0) >= 20) return fail("最多 20 条下载链接", 409);
  const id = newId();
  await db.prepare(
    "INSERT INTO download_links(id, scope, admin_user_id, title, url, sort) VALUES(?,?,?,?,?,?)",
  ).bind(id, scope, adminId, title, url, num(body.sort, 100)).run();
  return json({ ok: true, data: { id, title, url, scope } }, 201);
}

async function downloadRoute(req, env, url) {
  const db = env.DB;
  const code = s(url.searchParams.get("code"), 12).toUpperCase();
  const adminId = s(url.searchParams.get("admin"), 80);
  let resolved = adminId;
  if (!resolved && code) {
    const row = await db.prepare("SELECT admin_user_id FROM admin_share_codes WHERE code = ?").bind(code).first();
    if (!row) return fail("编号不存在", 404);
    resolved = row.admin_user_id;
  }
  const list = await listDownloads(db, resolved);
  return json({ ok: true, data: list });
}

async function superDownloadsRoute(req, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.split("/").filter(Boolean);   // api,super,downloads,<id>
  if (seg.length === 3 && req.method === "GET") {
    const adminId = s(url.searchParams.get("admin"), 80);
    const rows = adminId
      ? await db.prepare("SELECT * FROM download_links WHERE admin_user_id = ? ORDER BY sort").bind(adminId).all()
      : await db.prepare("SELECT * FROM download_links WHERE scope='global' ORDER BY sort").all();
    return json({ ok: true, data: rows.results || [] });
  }
  if (seg.length === 3 && req.method === "POST") {
    const body = await readJson(req);
    const adminId = s(body.admin_user_id, 80);
    return addDownload(db, ctx, adminId ? "admin" : "global", adminId || null, body);
  }
  if (seg.length === 4 && req.method === "DELETE") {
    await db.prepare("DELETE FROM download_links WHERE id = ?").bind(s(seg[3], 80)).run();
    return json({ ok: true, data: { deleted: true } });
  }
  return fail("接口不存在", 404);
}

async function userDownloadsRoute(req, env, url, ctx) {
  const db = env.DB;
  const seg = url.pathname.split("/").filter(Boolean);   // api,user,downloads,<id>
  if (seg.length === 3 && req.method === "GET") {
    const own = await db.prepare("SELECT * FROM download_links WHERE admin_user_id = ? ORDER BY sort").bind(ctx.effectiveId).all();
    return json({ ok: true, data: own.results || [], global: await listDownloads(db, ctx.effectiveId) });
  }
  if (seg.length === 3 && req.method === "POST") {
    return addDownload(db, ctx, "admin", ctx.effectiveId, await readJson(req));
  }
  if (seg.length === 4 && req.method === "DELETE") {
    const id = s(seg[3], 80);
    const row = await db.prepare("SELECT id FROM download_links WHERE id = ? AND admin_user_id = ?").bind(id, ctx.effectiveId).first();
    if (!row) return fail("链接不存在", 404);
    await db.prepare("DELETE FROM download_links WHERE id = ?").bind(id).run();
    return json({ ok: true, data: { deleted: true } });
  }
  return fail("接口不存在", 404);
}

/* ────────────────────────────── 统计与导出 ────────────────────────────── */

async function userStats(db, userId) {
  const sources = await db.prepare(
    "SELECT COUNT(*) AS n FROM source_ownership WHERE user_id = ?",
  ).bind(userId).first();
  const nodes = await db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN n.enabled = 1 THEN 1 ELSE 0 END) AS enabled,
            SUM(CASE WHEN l.state = 'stale' THEN 1 ELSE 0 END) AS stale
       FROM source_ownership so
       JOIN node_records n ON n.source_id = so.source_id
       LEFT JOIN node_lifecycle l ON l.node_id = n.id
      WHERE so.user_id = ?`,
  ).bind(userId).first();
  const groups = await db.prepare(
    `SELECT g.id, g.name, g.mode,
            (SELECT COUNT(*) FROM app_group_sources gs JOIN node_records n ON n.source_id = gs.source_id WHERE gs.group_id = g.id) AS nodes
       FROM app_groups g WHERE g.admin_user_id = ? ORDER BY g.sort`,
  ).bind(userId).all();
  const cards = await db.prepare(
    `SELECT status, COUNT(*) AS n FROM app_cards WHERE admin_user_id = ? GROUP BY status`,
  ).bind(userId).all();
  return {
    sources: Number(sources?.n || 0),
    nodes: {
      total: Number(nodes?.total || 0),
      enabled: Number(nodes?.enabled || 0),
      stale: Number(nodes?.stale || 0),
    },
    groups: groups.results || [],
    cards: cards.results || [],
  };
}

async function superStats(db) {
  const row = await db.prepare(
    `SELECT (SELECT COUNT(*) FROM app_users WHERE role='user') AS users,
            (SELECT COUNT(*) FROM subscription_sources) AS sources,
            (SELECT COUNT(*) FROM node_records) AS nodes,
            (SELECT COUNT(*) FROM node_lifecycle WHERE state='stale') AS stale,
            (SELECT COUNT(*) FROM app_cards) AS cards,
            (SELECT COUNT(*) FROM app_entitlements WHERE status='active') AS entitlements`,
  ).first();
  return {
    users: Number(row?.users || 0), sources: Number(row?.sources || 0),
    nodes: Number(row?.nodes || 0), stale: Number(row?.stale || 0),
    cards: Number(row?.cards || 0), entitlements: Number(row?.entitlements || 0),
  };
}

function csvCell(v) {
  const s0 = String(v ?? "");
  return /[",\n]/.test(s0) ? '"' + s0.replace(/"/g, '""') + '"' : s0;
}

async function exportCardsCsv(db, adminId, status) {
  const rows = await db.prepare(
    `SELECT code, days, status, inactive_reason, activated_at, used_at, manual_disabled, created_at
       FROM app_cards WHERE admin_user_id = ? ${status ? "AND status = ?" : ""}
      ORDER BY created_at DESC LIMIT 20000`,
  ).bind(...(status ? [adminId, status] : [adminId])).all();
  const head = "卡密,天数,状态,失活原因,激活时间,使用时间,手动停用,创建时间";
  const body = (rows.results || []).map(r => [
    r.code, r.days, r.status, r.inactive_reason || "", r.activated_at || "", r.used_at || "",
    r.manual_disabled ? "是" : "否", r.created_at,
  ].map(csvCell).join(","));
  return "\uFEFF" + head + "\n" + body.join("\n") + "\n";
}

async function syncLogsRoute(req, env, url, ctx) {
  const db = env.DB;
  const rows = await db.prepare(
    `SELECT id, source_id, source_name, status, total_nodes, added_nodes, updated_nodes,
            trigger_kind, duration_ms, missing_nodes, error_message, created_at
       FROM node_sync_logs WHERE source_id IN (
         SELECT source_id FROM source_ownership WHERE user_id = ?
       ) ORDER BY created_at DESC LIMIT 100`,
  ).bind(ctx.effectiveId).all();
  return json({ ok: true, data: rows.results || [] });
}

async function staleNodesRoute(req, env, url, ctx) {
  const db = env.DB;
  const rows = await db.prepare(
    `SELECT n.id, n.name, n.server, n.protocol, l.state, l.stale_at, s.name AS source_name
       FROM node_lifecycle l
       JOIN node_records n ON n.id = l.node_id
       JOIN source_ownership so ON so.source_id = n.source_id
       LEFT JOIN subscription_sources s ON s.id = n.source_id
      WHERE so.user_id = ? AND l.state = 'stale'
      ORDER BY l.stale_at DESC LIMIT 300`,
  ).bind(ctx.effectiveId).all();
  return json({ ok: true, data: rows.results || [] });
}

async function statsRoute(req, env, url, ctx) {
  const db = env.DB;
  if (url.pathname === "/api/user/stats" && req.method === "GET") {
    return json({ ok: true, data: await userStats(db, ctx.effectiveId) });
  }
  if (url.pathname === "/api/super/stats" && req.method === "GET") {
    return json({ ok: true, data: await superStats(db) });
  }
  return fail("接口不存在", 404);
}

async function exportRoute(req, env, url, ctx) {
  const db = env.DB;
  if (url.pathname === "/api/user/app-cards/export" && req.method === "GET") {
    const status = s(url.searchParams.get("status"), 20);
    const csv = await exportCardsCsv(db, ctx.effectiveId, status || null);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="app-cards.csv"',
      },
    });
  }
  return fail("接口不存在", 404);
}

/* ────────────────────────────── 旧后台接口（V0.4.0 兼容层，不可绕过认证）────────────────────────────── */

async function legacyAdminRoute(req, env, url, ctx) {
  const db = env.DB;
  const method = req.method;
  const path = url.pathname;

  if (path === "/api/admin/sources") {
    if (method === "GET") {
      const rows = await db.prepare(
        `SELECT s.*, so.user_id AS owner_user_id FROM subscription_sources s
           LEFT JOIN source_ownership so ON so.source_id = s.id
          ORDER BY s.priority ASC, s.created_at ASC`).all();
      return json({
        ok: true,
        data: (rows.results || []).map(r => ({ ...r, url: maskSubscriptionUrl(r.url) })),
      });
    }
    if (method === "POST") {
      const body = await readJson(req);
      const name = s(body.name, 120);
      const rawUrl = s(body.url, 2048);
      const tier = s(body.tier, 30) || "free";
      const priority = num(body.priority, 100);
      if (!name) return fail("来源名称不能为空", 400);
      if (!/^[A-Za-z0-9_-]{1,30}$/.test(tier)) return fail("tier 格式不正确", 400);
      if (!Number.isInteger(priority) || priority < 0 || priority > 100000) return fail("priority 必须为 0-100000 的整数", 400);
      try { validateSubscriptionUrl(rawUrl); } catch (e) { return fail(e.message, 400); }
      const id = newId();
      // 旧接口不猜归属：一律创建为「未分配 + 停用」，由总管理员在控制台分配归属后再启用。
      // 这样不会出现"无人归属却默认启用"的来源，也不会绕过审核/归属规则。
      await db.batch([
        db.prepare("INSERT INTO subscription_sources(id, name, url, tier, enabled, priority, remark) VALUES(?,?,?,?,0,?,?)")
          .bind(id, name, rawUrl, tier, priority, s(body.remark, 500)),
        db.prepare("INSERT INTO admin_audit(action, detail) VALUES('source.create', ?)")
          .bind(JSON.stringify({ id, name, assigned: false, enabled: 0 })),
        auditStmt(db, ctx, {
          action: "source.create", targetType: "source", targetId: id,
          after: { name, tier, priority, assigned: false, enabled: 0 },
          detail: "旧后台创建：未分配归属且保持停用",
        }),
      ]);
      return json({ ok: true, data: { id } }, 201);
    }
  }

  const m = path.match(/^\/api\/admin\/sources\/([A-Za-z0-9_-]{1,80})(\/enabled)?$/);
  if (m) {
    const id = m[1];
    const source = await db.prepare("SELECT * FROM subscription_sources WHERE id = ?").bind(id).first();
    if (!source) return fail("订阅源不存在", 404);

    if (m[2] === "/enabled" && method === "PATCH") {
      const body = await readJson(req);
      const enabled = parseBool01(body.enabled);
      if (enabled === null) return fail("enabled 只能是 true/false/1/0", 400);

      if (enabled === 1) {
        // 启用前必须满足：有归属 + 审批通过（无审批记录视为既有已批准）
        const own = await db.prepare("SELECT user_id FROM source_ownership WHERE source_id = ?").bind(id).first();
        if (!own) {
          await auditDenied(db, ctx, "source.enabled", "未分配来源不可启用", "source", id);
          return fail("该来源尚未分配归属，不能启用；请先在超管控制台分配", 409, { code: "SOURCE_UNASSIGNED" });
        }
        const ap = await db.prepare("SELECT status FROM source_approvals WHERE source_id = ?").bind(id).first();
        if (ap && ap.status !== "approved") {
          await auditDenied(db, ctx, "source.enabled", "未通过审核不可启用", "source", id);
          return fail("该来源尚未通过审核，不能启用", 409, { code: "SOURCE_NOT_APPROVED", approval_status: ap.status });
        }
      }
      const stmts = [
        db.prepare("UPDATE subscription_sources SET enabled=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(enabled, id),
        db.prepare("INSERT INTO admin_audit(action, detail) VALUES('source.enabled', ?)").bind(JSON.stringify({ id, enabled })),
        auditStmt(db, ctx, { action: "source.enabled", targetType: "source", targetId: id, after: { enabled } }),
      ];
      if (enabled === 1) {
        // 与更新同批的最终断言：并发下归属/审批被改动则整批回滚
        stmts.unshift(assertStmt(
          db,
          `EXISTS (SELECT 1 FROM source_ownership WHERE source_id = ?)
           AND NOT EXISTS (SELECT 1 FROM source_approvals WHERE source_id = ? AND status <> 'approved')`,
          [id, id],
        ));
      }
      try {
        await db.batch(stmts);
      } catch (e) {
        if (/malformed JSON|assert-failed/i.test(String(e?.message || ""))) {
          await auditDenied(db, ctx, "source.enabled", "归属或审批状态在操作期间变化", "source", id);
          return fail("来源归属或审批状态已变化，请刷新后重试", 409, { code: "SOURCE_STATE_CHANGED" });
        }
        throw e;
      }
      return json({ ok: true, data: { id, enabled } });
    }

    if (!m[2] && method === "PUT") {
      const body = await readJson(req);
      let rawUrl = s(body.url, 2048);
      if (isMaskedUrl(rawUrl)) rawUrl = source.url;
      const urlChanged = rawUrl !== source.url;
      const name = s(body.name, 120);
      const tier = s(body.tier, 30) || "free";
      const priority = num(body.priority, 100);
      if (!name) return fail("来源名称不能为空", 400);
      if (!/^[A-Za-z0-9_-]{1,30}$/.test(tier)) return fail("tier 格式不正确", 400);
      if (!Number.isInteger(priority) || priority < 0 || priority > 100000) return fail("priority 必须为 0-100000 的整数", 400);
      try { validateSubscriptionUrl(rawUrl); } catch (e) { return fail(e.message, 400); }
      const stmts = [
        db.prepare(
          urlChanged
            ? "UPDATE subscription_sources SET name=?, url=?, tier=?, priority=?, remark=?, enabled=0, updated_at=CURRENT_TIMESTAMP WHERE id=?"
            : "UPDATE subscription_sources SET name=?, url=?, tier=?, priority=?, remark=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        ).bind(name, rawUrl, tier, priority, s(body.remark, 500), id),
      ];
      if (urlChanged) {
        // 新地址未经审核不得继续同步：重置审批 + 停用，与 URL 更新同批完成
        stmts.push(
          db.prepare(
            `INSERT INTO source_approvals(source_id, status, requested_by, reviewed_by, reviewed_at, reason)
             VALUES(?, 'pending', ?, NULL, NULL, '管理员修改订阅地址，需重新审核')
             ON CONFLICT(source_id) DO UPDATE SET
               status='pending', requested_by=excluded.requested_by, reviewed_by=NULL,
               reviewed_at=NULL, reason=excluded.reason, created_at=CURRENT_TIMESTAMP`,
          ).bind(id, ctx.actorId),
        );
      }
      stmts.push(db.prepare("INSERT INTO admin_audit(action, detail) VALUES('source.update', ?)")
        .bind(JSON.stringify({ id, name, url_changed: urlChanged })));
      stmts.push(auditStmt(db, ctx, {
        action: urlChanged ? "source.update.re_review" : "source.update",
        targetType: "source", targetId: id,
        before: { url: maskSubscriptionUrl(source.url), enabled: source.enabled },
        after: { name, tier, priority, url: maskSubscriptionUrl(rawUrl), enabled: urlChanged ? 0 : source.enabled },
        detail: urlChanged ? "旧后台修改地址：已停用并重新进入待审核" : "未改地址，审批状态不变",
      }));
      await db.batch(stmts);
      return json({ ok: true, data: { id, url_changed: urlChanged, approval_status: urlChanged ? "pending" : undefined, enabled: urlChanged ? 0 : source.enabled } });
    }

    if (!m[2] && method === "DELETE") {
      // 历史保留规则：旧后台同样只停用归档，永不做物理删除。
      const nodes = await db.prepare("SELECT COUNT(*) AS n FROM node_records WHERE source_id = ?").bind(id).first();
      await db.batch([
        db.prepare("UPDATE subscription_sources SET enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(id),
        db.prepare("INSERT INTO admin_audit(action, detail) VALUES('source.archive', ?)")
          .bind(JSON.stringify({ id, reason: "history_preserved", nodes: Number(nodes?.n || 0) })),
        auditStmt(db, ctx, {
          action: "source.archive", targetType: "source", targetId: id,
          reason: "历史保留策略：仅停用归档，永不物理删除",
          detail: `history_nodes=${Number(nodes?.n || 0)}`,
        }),
      ]);
      return json({
        ok: true,
        data: { id, archived: true, node_count: Number(nodes?.n || 0) },
        message: "已停用归档（历史记录与节点保留）",
      });
    }
  }

  if (path === "/api/admin/settings" && method === "GET") {
    const rows = await db.prepare("SELECT key, value, updated_at FROM app_settings ORDER BY key").all();
    return json({ ok: true, data: rows.results || [] });
  }
  if (path === "/api/admin/settings" && method === "PUT") {
    const body = await readJson(req);
    const entries = Object.entries(body).slice(0, 50);
    if (!entries.length) return fail("设置内容无效", 400);
    const stmts = entries.map(([k, v]) =>
      db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP")
        .bind(s(k, 100), typeof v === "string" ? v : JSON.stringify(v)));
    stmts.push(
      db.prepare("INSERT INTO admin_audit(action, detail) VALUES('settings.batch', ?)")
        .bind(JSON.stringify({ keys: entries.map(([k]) => s(k, 100)).slice(0, 50) })),
    );
    stmts.push(auditStmt(db, ctx, {
      action: "settings.batch", targetType: "settings", targetId: "app_settings",
      after: { keys: entries.map(([k]) => s(k, 100)).slice(0, 50), count: entries.length },
      detail: `批量修改 ${entries.length} 项设置`,
    }));
    await db.batch(stmts);
    return json({ ok: true, data: { updated: entries.length } });
  }
  const settingMatch = path.match(/^\/api\/admin\/settings\/([A-Za-z0-9_.-]{1,100})$/);
  if (settingMatch && method === "PUT") {
    const body = await readJson(req);
    const value = typeof body.value === "string" ? body.value : JSON.stringify(body.value ?? "");
    await db.batch([
      db.prepare("INSERT INTO app_settings(key,value,updated_at) VALUES(?,?,CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP")
        .bind(settingMatch[1], value),
      db.prepare("INSERT INTO admin_audit(action, detail) VALUES('setting.update', ?)").bind(JSON.stringify({ key: settingMatch[1] })),
      auditStmt(db, ctx, { action: "settings.update", targetType: "settings", targetId: settingMatch[1], detail: "单键设置修改" }),
    ]);
    return json({ ok: true, data: { key: settingMatch[1] } });
  }

  if (path === "/api/admin/audit" && method === "GET") {
    const limitR = intParam(url.searchParams.get("limit"), { min: 1, max: 200, def: 50, name: "limit" });
    if (limitR.error) return fail(limitR.error, 400);
    const limit = limitR.value;
    const rows = await db.prepare("SELECT id, action, detail, created_at FROM admin_audit ORDER BY id DESC LIMIT ?").bind(limit).all();
    return json({ ok: true, data: rows.results || [] });
  }

  if (path === "/api/admin/nodes" && method === "GET") {
    const p = url.searchParams;
    const limitR = intParam(p.get("limit"), { min: 1, max: 500, def: 100, name: "limit" });
    if (limitR.error) return fail(limitR.error, 400);
    const offsetR = intParam(p.get("offset"), { min: 0, max: 1_000_000, def: 0, name: "offset" });
    if (offsetR.error) return fail(offsetR.error, 400);
    const limit = limitR.value, offset = offsetR.value;
    const where = [], binds = [];
    for (const key of ["source_id", "protocol", "tier"]) {
      const v = s(p.get(key), 100);
      if (v) { where.push(`${key} = ?`); binds.push(v); }
    }
    if (p.has("enabled")) { where.push("enabled = ?"); binds.push(p.get("enabled") === "0" ? 0 : 1); }
    const q = s(p.get("q"), 100);
    if (q) { where.push("(name LIKE ? OR server LIKE ? OR source_name LIKE ?)"); binds.push(`%${q}%`, `%${q}%`, `%${q}%`); }
    const whereSql = where.length ? " WHERE " + where.join(" AND ") : "";
    const total = await db.prepare("SELECT COUNT(*) AS total FROM node_records" + whereSql).bind(...binds).first();
    const rows = await db.prepare(
      `SELECT id, source_id, source_name, name, protocol, server, port, tier, enabled, last_seen, created_at, updated_at
         FROM node_records${whereSql} ORDER BY updated_at DESC LIMIT ? OFFSET ?`,
    ).bind(...binds, limit, offset).all();
    return json({ ok: true, data: rows.results || [], total: Number(total?.total || 0), limit, offset });
  }

  if (path === "/api/admin/sync-logs" && method === "GET") {
    const limitR = intParam(url.searchParams.get("limit"), { min: 1, max: 200, def: 50, name: "limit" });
    if (limitR.error) return fail(limitR.error, 400);
    const limit = limitR.value;
    const sid = s(url.searchParams.get("source_id"), 80);
    const rows = sid
      ? await db.prepare(
        `SELECT id, source_id, source_name, status, total_nodes, added_nodes, updated_nodes,
                trigger_kind, duration_ms, missing_nodes, error_message, created_at
           FROM node_sync_logs WHERE source_id = ? ORDER BY id DESC LIMIT ?`,
      ).bind(sid, limit).all()
      : await db.prepare(
        `SELECT id, source_id, source_name, status, total_nodes, added_nodes, updated_nodes,
                trigger_kind, duration_ms, missing_nodes, error_message, created_at
           FROM node_sync_logs ORDER BY id DESC LIMIT ?`,
      ).bind(limit).all();
    return json({ ok: true, data: rows.results || [] });
  }

  if (path === "/api/admin/sync-tasks" && method === "GET") {
    const limitR = intParam(url.searchParams.get("limit"), { min: 1, max: 100, def: 20, name: "limit" });
    if (limitR.error) return fail(limitR.error, 400);
    const limit = limitR.value;
    const rows = await db.prepare(
      `SELECT id, source_id, generation, trigger_kind, status, node_count, staged_count, missing_count,
              manifest_hash, error_message, created_at, committed_at
         FROM sync_tasks ORDER BY created_at DESC LIMIT ?`,
    ).bind(limit).all();
    return json({ ok: true, data: rows.results || [] });
  }

  if (path === "/api/admin/sync" && method === "POST") {
    const body = await readJson(req, { allowEmpty: true });
    const only = s(body.source_id || body.sourceId, 80);
    // 只同步“已批准”的来源：pending/rejected 一律跳过（既有来源没有审核记录 = 视为已批准）
    // 手动同步同样只处理「已分配归属」的来源：JOIN source_ownership 天然排除未分配
    const approvedOnly = `s.enabled = 1 AND (ap.status IS NULL OR ap.status = 'approved')`;
    const rows = only
      ? await db.prepare(
        `SELECT s.id, s.name, s.url, s.tier FROM subscription_sources s
           JOIN source_ownership so ON so.source_id = s.id
           LEFT JOIN source_approvals ap ON ap.source_id = s.id
          WHERE s.id = ? AND ${approvedOnly}`).bind(only).all()
      : await db.prepare(
        `SELECT s.id, s.name, s.url, s.tier FROM subscription_sources s
           JOIN source_ownership so ON so.source_id = s.id
           LEFT JOIN source_approvals ap ON ap.source_id = s.id
          WHERE ${approvedOnly} ORDER BY s.priority ASC LIMIT ?`)
        .bind(MAX_SYNC_SOURCES).all();
    const sources = rows.results || [];
    if (!sources.length) return json({ ok: true, data: { total_sources: 0, success: 0, failed: 0, results: [] } });

    const run = await runSync(db, sources, { actorUserId: ctx.actorId, triggerKind: "manual", ctx, env });
    let auditStatus = "ok";
    try {
      await db.prepare("INSERT INTO admin_audit(action, detail) VALUES('nodes.sync', ?)")
        .bind(JSON.stringify({ total: run.total, success: run.success, failed: run.failed, busy: run.busy }))
        .run();
    } catch (e) {
      auditStatus = "failed";
      try { console.error(`[audit] nodes.sync summary failed request=${ctx.requestId || "-"} msg=${s(e?.message, 120)}`); } catch {}
    }
    return json({
      ok: run.failed === 0 && auditStatus === "ok",
      data: {
        total_sources: run.total, success: run.success, failed: run.failed, busy: run.busy,
        results: run.results,
        audit_status: auditStatus,
        sync_status: run.failed === 0 ? "ok" : "partial_failure",
      },
      ...(auditStatus === "failed" ? { warning: "同步已执行，但汇总审计写入失败；逐源审计见 admin_audit_events" } : {}),
    });
  }

  return fail("接口不存在", 404);
}

/* ────────────────────────────── 路由入口 ────────────────────────────── */

function isUserApi(path) { return path.startsWith("/api/user/"); }
function isSuperApi(path) { return path.startsWith("/api/super/"); }
function isLegacyApi(path) { return path.startsWith("/api/admin/"); }
function isAuthApi(path) { return path === "/api/auth" || path.startsWith("/api/auth/"); }

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const cors = corsHeaders(req, env);

    if (req.method === "OPTIONS") {
      if (!originAllowed(req, env)) return fail("Origin 不允许", 403, {}, cors);
      return new Response(null, { status: 204, headers: cors });
    }

    const withCors = (res) => {
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    };

    if (url.pathname === "/health" && req.method === "GET") {
      return withCors(json({
        ok: true, service: "starjump-api", version: VERSION,
        build: "2026-11-28-v2.5.0-rc1",
        auth_mode: "multi_user_session",
        legacy_admin_token: "restricted",
        features: ["multi_user", "overrides", "groups", "audit_events", "sync_staging", "password_change"],
      }));
    }

    // 公开的订阅短链（客户端直接拉取），不需要登录
    if (url.pathname.startsWith("/c/") && req.method === "GET") {
      if (!env.DB) return withCors(fail("D1 binding DB 未配置", 500));
      try {
        return withCors(await convertRoute(req, env, url, null));
      } catch (e) {
        return withCors(fail(String(e?.message || "转换链接读取失败").slice(0, 200), 500));
      }
    }

    if (!url.pathname.startsWith("/api/")) return withCors(fail("接口不存在", 404));
    if (!originAllowed(req, env)) return withCors(fail("Origin 不允许", 403));

    if (!env.DB) return withCors(fail("D1 binding DB 未配置", 500));

    let ctx = null;
    try {
      ctx = await resolveSession(req, env);
    } catch (e) {
      if (e?.code === "INVALID_SESSION") return withCors(fail("未登录或会话已失效", 401, { code: "INVALID_SESSION" }));
      if (e?.code === "SECRET_NOT_CONFIGURED") return withCors(fail("认证密钥未配置或长度不足", 503, { code: "SECRET_NOT_CONFIGURED" }));
      return withCors(fail("会话解析失败", 500));
    }
    const ctxWithReq = { ...(ctx || { actorId: null, effectiveId: null, isSuper: false, legacy: false }), requestId: requestId(req) };

    try {
      // 订阅转换：公开接口，不需要登录（限流在 convertRoute 内按 IP 做）
      if (url.pathname === "/api/app/version" || url.pathname === "/api/announcements") {
        if (!env.DB) return withCors(fail("D1 binding DB 未配置", 500));
        return withCors(url.pathname === "/api/app/version"
          ? await appVersionRoute(req, env, url)
          : await announcementsRoute(req, env, url));
      }
      if (url.pathname === "/api/app/download" && req.method === "GET") {
        if (!env.DB) return withCors(fail("D1 binding DB 未配置", 500));
        return withCors(await downloadRoute(req, env, url));
      }
      if (url.pathname === "/api/app/resolve" && req.method === "GET") {
        if (!env.DB) return withCors(fail("D1 binding DB 未配置", 500));
        return withCors(await appResolveRoute(req, env, url));
      }
      if (url.pathname === "/api/app/groups" && req.method === "GET") {
        if (!env.DB) return withCors(fail("D1 binding DB 未配置", 500));
        return withCors(await appGroupsForDevice(req, env, url));
      }
      if (url.pathname === "/api/app/free" && req.method === "GET") {
        if (!env.DB) return withCors(fail("D1 binding DB 未配置", 500));
        return withCors(await appFreeGroupRoute(req, env, url));
      }
      if (url.pathname === "/api/app/links" && req.method === "GET") {
        if (!env.DB) return withCors(fail("D1 binding DB 未配置", 500));
        return withCors(await appLinksForDevice(req, env, url));
      }
      if (url.pathname === "/api/app/redeem" || url.pathname === "/api/app/status" || url.pathname === "/api/app/nodes") {
        if (!env.DB) return withCors(fail("D1 binding DB 未配置", 500));
        return withCors(await appRedeemRoute(req, env, url, null));
      }

      if ((url.pathname === "/api/convert" && req.method === "POST") || url.pathname === "/api/convert/groups" || url.pathname.startsWith("/api/convert/links") || url.pathname === "/api/convert/groups/rename") {
        return withCors(await convertRoute(req, env, url, null));
      }

      // 认证相关（含 bootstrap，需要 legacy/super）
      if (isAuthApi(url.pathname)) {
        if (url.pathname === "/api/auth/bootstrap") {
          if (!ctx || !ctx.isSuper || !ctx.legacy) return withCors(fail("需要 ADMIN_TOKEN", 401));
        } else if (url.pathname !== "/api/auth/login" && url.pathname !== "/api/auth/register") {
          if (!ctx) return withCors(fail("未登录或会话已失效", 401));
        }
        return withCors(await routeAuth(req, env, url, ctx ? ctxWithReq : { ...ctxWithReq, requestId: requestId(req) }));
      }

      if (isUserApi(url.pathname)) {
        if (!ctx) return withCors(fail("未登录或会话已失效", 401));
        if (ctx.legacy) return withCors(fail("该接口需要用户会话，不接受 ADMIN_TOKEN", 403));
        // 协助会话按 scope 收紧：GET=read，DELETE=manage，其余写操作=operate
        const needScope = req.method === "GET" ? "read" : req.method === "DELETE" ? "manage" : "operate";
        const scopeDenied = requireScope(ctxWithReq, needScope);
        if (scopeDenied) {
          await auditDenied(env.DB, ctxWithReq, "scope.denied", `需要 ${needScope}`, "path", url.pathname);
          return withCors(scopeDenied);
        }

        const appAuthorization = await authorizeAppManagementRequest({
          db: env.DB, path: url.pathname, method: req.method, ctx: ctxWithReq,
        });
        if (appAuthorization && !appAuthorization.allowed) {
          return withCors(fail("当前身份或会员状态无权执行此操作", 403, {
            code: appAuthorization.code || "APP_AUTH_DENIED",
            vip_state: appAuthorization.vipState || null,
          }));
        }
        if (appAuthorization) ctxWithReq.appAuthorization = appAuthorization;

        if (url.pathname.startsWith("/api/user/sources")) return withCors(await userSourcesRoute(req, env, url, ctxWithReq));
        if (url.pathname.startsWith("/api/user/nodes")) {
          if (/^\/api\/user\/nodes\/[^/]+\/overrides/.test(url.pathname)) {
            return withCors(await userOverridesRoute(req, env, url, ctxWithReq));
          }
          if (/^\/api\/user\/nodes\/[^/]+\/metadata$/.test(url.pathname)) {
            return withCors(await userMetadataRoute(req, env, url, ctxWithReq));
          }
          return withCors(await userNodesRoute(req, env, url, ctxWithReq));
        }
        if (url.pathname.startsWith("/api/user/node-groups")) return withCors(await userGroupsRoute(req, env, url, ctxWithReq));
        if (url.pathname === "/api/user/vip" || url.pathname === "/api/user/vip/activate") {
          return withCors(await userVipRoute(req, env, url, ctxWithReq));
        }
        if (url.pathname === "/api/user/convert-groups") {
          return withCors(await userConvertGroupsRoute(req, env, url, ctxWithReq));
        }
        if (url.pathname === "/api/user/sync-logs") {
          return withCors(await syncLogsRoute(req, env, url, ctxWithReq));
        }
        if (url.pathname === "/api/user/stale-nodes") {
          return withCors(await staleNodesRoute(req, env, url, ctxWithReq));
        }
        if (url.pathname === "/api/user/stats" || url.pathname === "/api/user/app-cards/export") {
          return withCors(url.pathname.endsWith("/export")
            ? await exportRoute(req, env, url, ctxWithReq)
            : await statsRoute(req, env, url, ctxWithReq));
        }
        if (url.pathname.startsWith("/api/user/downloads")) {
          return withCors(await userDownloadsRoute(req, env, url, ctxWithReq));
        }
        if (url.pathname === "/api/user/share-code") {
          return withCors(await userShareCodeRoute(req, env, url, ctxWithReq));
        }
        if (url.pathname.startsWith("/api/user/app-groups")) {
          return withCors(await userAppGroupsRoute(req, env, url, ctxWithReq));
        }
        if (url.pathname.startsWith("/api/user/app-links")) {
          return withCors(await userAppLinksRoute(req, env, url, ctxWithReq));
        }
        if (url.pathname.startsWith("/api/user/app-cards")) {
          return withCors(await userAppCardsRoute(req, env, url, ctxWithReq));
        }
        return withCors(fail("接口不存在", 404));
      }

      if (url.pathname.startsWith("/api/super/releases") || url.pathname.startsWith("/api/super/announcements")) {
        if (!ctx || !ctx.isSuper || ctx.legacy) return withCors(fail("需要超级管理员会话", 403));
        return withCors(await superReleasesRoute(req, env, url, ctxWithReq));
      }
      if (url.pathname.startsWith("/api/super/admins")) {
        if (!ctx || !ctx.isSuper || ctx.legacy) return withCors(fail("需要超级管理员会话", 403));
        return withCors(await superShareCodeRoute(req, env, url, ctxWithReq));
      }
      if (url.pathname.startsWith("/api/super/downloads")) {
        if (!ctx || !ctx.isSuper || ctx.legacy) return withCors(fail("需要超级管理员会话", 403));
        return withCors(await superDownloadsRoute(req, env, url, ctxWithReq));
      }
      if (url.pathname.startsWith("/api/super/app-groups")) {
        if (!ctx || !ctx.isSuper || ctx.legacy) return withCors(fail("需要超级管理员会话", 403));
        return withCors(await superAppGroupsRoute(req, env, url, ctxWithReq));
      }
      if (url.pathname.startsWith("/api/super/app-links") || url.pathname.startsWith("/api/super/app-perms") || (url.pathname.startsWith("/api/super/app-entitlements") && url.pathname.endsWith("/rebind"))) {
        if (!ctx || !ctx.isSuper || ctx.legacy) return withCors(fail("需要超级管理员会话", 403));
        return withCors(await superAppLinksRoute(req, env, url, ctxWithReq));
      }
      if (url.pathname === "/api/super/stats") {
        if (!ctx || !ctx.isSuper || ctx.legacy) return withCors(fail("需要超级管理员会话", 403));
        return withCors(await statsRoute(req, env, url, ctxWithReq));
      }
      if (url.pathname === "/api/super/alerts") {
        if (!ctx || !ctx.isSuper || ctx.legacy) return withCors(fail("需要超级管理员会话", 403));
        return withCors(await superAlertsRoute(req, env, url, ctxWithReq));
      }
      if (url.pathname === "/api/super/schema-status" || url.pathname === "/api/super/migrate") {
        // 允许 ADMIN_TOKEN（legacy）作为兜底：登录异常时也能把表建好
        if (!ctx || !ctx.isSuper) return withCors(fail("需要超级管理员或 ADMIN_TOKEN", 403));
        return withCors(await migrateRoute(req, env, url, ctxWithReq));
      }

      if (url.pathname.startsWith("/api/super/node-lifecycle")) {
        if (!ctx || !ctx.isSuper || ctx.legacy) return withCors(fail("需要超级管理员会话", 403));
        return withCors(await superNodeLifecycleRoute(req, env, url, ctxWithReq));
      }
      if (url.pathname.startsWith("/api/super/vip-cards")) {
        if (!ctx) return withCors(fail("未登录或会话已失效", 401));
        if (!ctx.isSuper || ctx.legacy || ctx.actorId !== ctx.effectiveId) {
          return withCors(fail("需要超级管理员会话", 403));
        }
        return withCors(await superVipRoute(req, env, url, ctxWithReq));
      }

      if (isSuperApi(url.pathname)) {
        if (!ctx) return withCors(fail("未登录或会话已失效", 401));
        // ADMIN_TOKEN 只用于迁移/紧急恢复与旧后台，不能直接操作多用户管理接口
        if (ctx.legacy) {
          return withCors(fail("该接口需要使用超级管理员账号登录后的会话，不接受 ADMIN_TOKEN", 403));
        }
        // 协助会话（actor ≠ effective）一律不得进入总后台，防止借协助 token 提权；
        // 唯一例外：协助会话可以结束自己（只撤销自身会话，无提权可能）
        const isSelfEnd = url.pathname === "/api/super/impersonation/end" && req.method === "POST";
        if (ctx.actorId !== ctx.effectiveId && !isSelfEnd) {
          await auditDenied(env.DB, ctxWithReq, "super.impersonation.denied", "协助会话尝试访问总后台接口", "path", url.pathname);
          return withCors(fail("协助会话不能访问总管理员接口", 403, { code: "IMPERSONATION_FORBIDDEN" }));
        }
        return withCors(await superRoute(req, env, url, ctxWithReq));
      }

      if (isLegacyApi(url.pathname)) {
        // 旧接口只接受 ADMIN_TOKEN 或超级管理员会话；协助会话不得使用
        if (!ctx || !ctx.isSuper) return withCors(fail("未授权", 401));
        if (ctx.actorId !== ctx.effectiveId) return withCors(fail("协助会话不能使用旧后台接口", 403));
        return withCors(await legacyAdminRoute(req, env, url, ctxWithReq));
      }

      return withCors(fail("接口不存在", 404));
    } catch (e) {
      const message = String(e?.message || "");
      if (e?.code === "GUEST_KEY_REQUIRED") return withCors(fail(message, 400, { code: e.code }));
      if (e?.code === "SECRET_NOT_CONFIGURED") return withCors(fail("Worker 认证密钥未配置或长度不足", 503, { code: e.code }));
      if (/^请求体|^JSON|^请求必须/.test(message)) return withCors(fail(message, 400));
      if (/fence-lost|assert-failed|malformed JSON/i.test(message)) {
        // 断言失败（fence/scope/不变量）都会让整批回滚
        return withCors(fail("操作被安全断言拒绝：任务租约、授权或不变量已变化，本次写入已回滚", 409, { code: "ASSERTION_FAILED" }));
      }
      // 诊断模式（仅在 staging 设置 DIAGNOSTICS=1）下返回错误类型与短消息，便于定位；不含堆栈与凭据
      if (String(env.DIAGNOSTICS || "") === "1") {
        return withCors(json({
          ok: false,
          error: "服务器处理失败（诊断模式）",
          code: String(e?.name || "Error"),
          detail: String(e?.message || "").slice(0, 300),
        }, 500));
      }
      // 不向客户端泄露堆栈
      return withCors(fail("服务器处理失败，请检查 Worker 日志", 500));
    }
  },

  /** Cloudflare Cron Trigger 入口：与手动同步共用同一套 fencing 锁与提交流程。 */
  async scheduled(event, env, ctx) {
    const db = env.DB;
    if (!db) return;
    // 自动同步只处理「已明确分配归属」的来源：
    //   INNER JOIN source_ownership 天然排除未分配来源，且 source_id 是主键不会造成重复。
    // 公平轮转：优先从未成功同步过的，其次按上次成功时间最旧的先跑，
    //   这样来源数超过 MAX_SYNC_SOURCES 时不会永远只跑前 N 个（不新增字段，复用既有 sync_state）。
    const rows = await db.prepare(
      // 公平轮转：用 sync_tasks.created_at 取“最近一次同步尝试”（含失败）。
      // 从未尝试 → 最早；尝试过的按时间升序，失败来源也会被排到队尾，不会永远占住前 N 个。
      `SELECT s.id, s.name, s.url, s.tier,
              (SELECT MAX(t.created_at) FROM sync_tasks t WHERE t.source_id = s.id) AS last_attempt_at
         FROM subscription_sources s
         JOIN source_ownership so ON so.source_id = s.id
         LEFT JOIN source_approvals ap ON ap.source_id = s.id
        WHERE s.enabled = 1 AND (ap.status IS NULL OR ap.status = 'approved')
        ORDER BY COALESCE((SELECT MAX(t.created_at) FROM sync_tasks t WHERE t.source_id = s.id), '1970-01-01 00:00:00') ASC,
                 s.priority ASC
        LIMIT ?`,
    ).bind(MAX_SYNC_SOURCES).all();
    const sources = rows.results || [];
    const cronCtx = {
      actorId: "scheduled", effectiveId: null, isSuper: false, legacy: false,
      requestId: `cron-${event?.cron || "manual"}-${Date.now()}`,
    };
    try {
      // Lifecycle/entitlement maintenance must run even when no sync sources are assigned.
      await runVipCardMaintenance(db, cronCtx).catch(() => {});
      await runNodeLifecycle(db, cronCtx).catch(() => {});
      await runEntitlementMaintenance(db).catch(() => {});
      // Only the source synchronization is conditional on having eligible sources.
      if (sources.length) {
        const run = await runSync(db, sources, { actorUserId: null, triggerKind: "scheduled", ctx: cronCtx, env });
        await db.prepare("INSERT INTO admin_audit(action, detail) VALUES('nodes.sync.scheduled', ?)")
          .bind(JSON.stringify({ total: run.total, success: run.success, failed: run.failed, busy: run.busy }))
          .run().catch(() => {});
      }
    } catch {
      // 定时任务失败不能抛到平台层；失败详情在 sync_tasks 里
    }
  },
};
