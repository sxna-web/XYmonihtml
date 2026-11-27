/**
 * Tiny deterministic D1-like fixture for isolated tests only.
 * Supports exact entitlement lookup and records all SQL/bind calls.
 */
export function createMockD1({ entitlements = [], fail = false } = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      return {
        bind(...bindings) {
          return {
            async first() {
              calls.push({ sql, bindings });
              if (fail) throw new Error("mock D1 unavailable");
              if (!/WHERE id = \? AND device_id = \? LIMIT 1/.test(sql)) {
                throw new Error("unexpected query shape");
              }
              return entitlements.find(row => row.id === bindings[0] && row.device_id === bindings[1]) || null;
            },
          };
        },
      };
    },
  };
}
