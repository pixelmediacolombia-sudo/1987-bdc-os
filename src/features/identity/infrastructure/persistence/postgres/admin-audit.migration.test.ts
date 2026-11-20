import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { CREATE_ADMIN_AUDIT_SQL, ensureAdminAuditTable } from "@/features/identity/infrastructure/persistence/postgres/admin-audit.migration";

test("admin audit schema is append-only and indexed for supported filters", async () => {
  assert.match(CREATE_ADMIN_AUDIT_SQL, /actor_user_id UUID/);
  assert.match(CREATE_ADMIN_AUDIT_SQL, /target_tenant_id UUID/);
  assert.match(CREATE_ADMIN_AUDIT_SQL, /reference_id TEXT NOT NULL/);
  assert.match(CREATE_ADMIN_AUDIT_SQL, /BEFORE UPDATE OR DELETE/);
  assert.match(CREATE_ADMIN_AUDIT_SQL, /category, created_at DESC/);
  let executed = "";
  await ensureAdminAuditTable({ query: async (sql: string) => { executed = sql; return { rows: [] }; } } as unknown as Pool);
  assert.equal(executed, CREATE_ADMIN_AUDIT_SQL);
});
