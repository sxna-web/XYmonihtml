/**
 * Isolated contract for the future Worker dispatcher integration.
 * This module is deliberately NOT imported by Worker.js until staging schema and
 * the complete route integration are approved.
 */
export async function dispatchCardGroupAdminContract({
  request,
  ctxWithReq,
  appAuthorization,
  handler,
  withCors,
  fail,
}) {
  if (typeof handler !== "function" || typeof withCors !== "function" ||
      typeof fail !== "function") {
    throw new TypeError("CARD_GROUP_DISPATCH_CONTRACT_DEPENDENCIES_REQUIRED");
  }
  if (!ctxWithReq) return withCors(fail("未登录或会话已失效", 401, { code: "INVALID_SESSION" }));
  if (appAuthorization && !appAuthorization.allowed) {
    return withCors(fail("当前身份或会员状态无权执行此操作", 403, {
      code: appAuthorization.code || "APP_AUTH_DENIED",
      vip_state: appAuthorization.vipState || null,
    }));
  }
  const resolveSession = async receivedRequest => {
    if (receivedRequest !== request) throw new Error("REQUEST_CONTEXT_MISMATCH");
    return ctxWithReq;
  };
  const response = await handler(request, resolveSession);
  return withCors(response);
}
