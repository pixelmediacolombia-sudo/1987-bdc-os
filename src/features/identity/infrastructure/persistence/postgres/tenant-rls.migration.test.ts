import assert from "node:assert/strict";
import test from "node:test";
import { TENANT_RLS_SQL, ensureTenantRowLevelSecurity } from "./tenant-rls.migration";
import type { Pool } from "pg";

test("tenant row security is forced and bound to the transaction-local tenant context", () => {
  assert.match(TENANT_RLS_SQL, /ENABLE ROW LEVEL SECURITY/);
  assert.match(TENANT_RLS_SQL, /FORCE ROW LEVEL SECURITY/);
  assert.match(TENANT_RLS_SQL, /current_setting\('app\.tenant_id', true\)/);
  assert.match(TENANT_RLS_SQL, /WITH CHECK/);
  assert.doesNotMatch(TENANT_RLS_SQL, /BYPASSRLS|rolbypassrls|SET row_security\s*=\s*off/i);
});

test("tenant row security migration executes its policy as one idempotent migration", async () => {
  let executed = "";
  await ensureTenantRowLevelSecurity({ query: async (sql: string) => { executed = sql; return { rows: [] }; } } as unknown as Pool);
  assert.equal(executed, TENANT_RLS_SQL);
});
