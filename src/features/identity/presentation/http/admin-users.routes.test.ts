import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import type { Pool } from "pg";
import { createIdentityRouter } from "@/features/identity/presentation/http/identity.routes";

test("admin user directory lists safe user and invitation entries with filters", async (context) => {
  const adminToken = "users-admin-session";
  const adminTokenHash = createHash("sha256").update(adminToken).digest("hex");
  const dealerToken = "users-dealer-session";
  const dealerTokenHash = createHash("sha256").update(dealerToken).digest("hex");
  const dealerId = "11111111-1111-4111-8111-111111111111";
  let countSql = "";
  let listSql = "";
  let listValues: unknown[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM public.app_sessions")) {
        if (values[0] === adminTokenHash) return { rows: [{ id: "admin-id", email: "admin@example.com", display_name: "Admin", account_type: "admin" }] };
        if (values[0] === dealerTokenHash) return { rows: [{ id: "dealer-user-id", email: "dealer@example.com", display_name: "Dealer", account_type: "user" }] };
        return { rows: [] };
      }
      if (sql.includes("COUNT(*)::text AS total")) {
        countSql = sql;
        return { rows: [{ total: "2" }] };
      }
      if (sql.includes("FROM directory")) {
        listSql = sql;
        listValues = values;
        return { rows: [
          { record_type: "user", id: "user-1", display_name: "Alex Rivera", email: "alex@example.com", account_type: "user", status: "active", created_at: "2026-11-20T10:00:00.000Z", expires_at: null, dealers: [{ id: dealerId, name: "Dealer Norte" }] },
          { record_type: "invitation", id: "invite-1", display_name: "Alex Rivera", email: "alex@example.com", account_type: "user", status: "pending", created_at: "2026-11-21T10:00:00.000Z", expires_at: "2026-11-24T10:00:00.000Z", dealers: [{ id: dealerId, name: "Dealer Norte" }] },
        ] };
      }
      throw new Error(`Unexpected user directory SQL: ${sql.slice(0, 100)}`);
    },
  } as unknown as Pool;
  const app = express();
  app.use("/auth", createIdentityRouter(pool, { production: false }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/auth/admin/users`;
  const params = new URLSearchParams({ search: "alex", dealerId, accountType: "user", limit: "10", offset: "0" });
  const response = await fetch(`${base}?${params}`, { headers: { cookie: `bdc_os_session=${adminToken}` } });
  assert.equal(response.status, 200);
  const body = await response.json() as { total: number; limit: number; offset: number; entries: Array<{ record_type: string; status: string; dealers: Array<{ id: string; name: string }> }> };
  assert.equal(body.total, 2);
  assert.equal(body.limit, 10);
  assert.equal(body.offset, 0);
  assert.deepEqual(body.entries.map((entry) => [entry.record_type, entry.status]), [["user", "active"], ["invitation", "pending"]]);
  assert.deepEqual(body.entries[0]?.dealers, [{ id: dealerId, name: "Dealer Norte" }]);
  assert.match(countSql, /dealer_entry\.value->>'id' = \$2/);
  assert.match(listSql, /ORDER BY created_at DESC, record_type ASC, id ASC/);
  assert.deepEqual(listValues, ["%alex%", dealerId, "user", 10, 0]);
  assert.doesNotMatch(listSql, /password_hash|token_hash|encrypted_meta_access_token/i);

  const denied = await fetch(base);
  assert.equal(denied.status, 401);
  const forbidden = await fetch(base, { headers: { cookie: `bdc_os_session=${dealerToken}` } });
  assert.equal(forbidden.status, 403);
  const invalid = await fetch(`${base}?status=superadmin`, { headers: { cookie: `bdc_os_session=${adminToken}` } });
  assert.equal(invalid.status, 400);
});