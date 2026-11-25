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
  const directoryCalls: string[] = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      directoryCalls.push(sql);
      if (sql.includes("set_config('app.is_platform_admin'")) return { rows: [] };
      if (sql.includes("COUNT(*)::text AS total")) { countSql = sql; return { rows: [{ total: "2" }] }; }
      if (sql.includes("FROM directory")) {
        listSql = sql;
        listValues = values;
        return { rows: [
          { record_type: "user", id: "user-1", display_name: "Alex Rivera", email: "alex@example.com", account_type: "user", status: "active", created_at: "2026-11-20T10:00:00.000Z", expires_at: null, dealers: [{ id: dealerId, name: "Dealer Norte" }] },
          { record_type: "invitation", id: "invite-1", display_name: "Alex Rivera", email: "alex@example.com", account_type: "user", status: "pending", created_at: "2026-11-21T10:00:00.000Z", expires_at: "2026-11-24T10:00:00.000Z", dealers: [{ id: dealerId, name: "Dealer Norte" }] },
        ] };
      }
      if (sql.includes("set_config('app.tenant_id'")) { assert.deepEqual(values, [dealerId]); return { rows: [] }; }
      if (sql.includes("FROM public.tenants")) return { rows: [{ id: dealerId, name: "Dealer Norte", status: "active", user_count: 1, pending_invitation_count: 1 }] };
      return { rows: [] };
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM public.app_sessions")) {
        if (values[0] === adminTokenHash) return { rows: [{ id: "admin-id", email: "admin@example.com", display_name: "Admin", account_type: "admin" }] };
        if (values[0] === dealerTokenHash) return { rows: [{ id: "dealer-user-id", email: "dealer@example.com", display_name: "Dealer", account_type: "user" }] };
        return { rows: [] };
      }
      if (sql.includes("list_tenant_route_ids")) return { rows: [{ dealer_id: dealerId }] };
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
    connect: async () => client,
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
  assert.ok(directoryCalls.some((sql) => sql.includes("set_config('app.tenant_id'")));
  assert.doesNotMatch(listSql, /JOIN public\.tenants/i);

  const denied = await fetch(base);
  assert.equal(denied.status, 401);
  const forbidden = await fetch(base, { headers: { cookie: `bdc_os_session=${dealerToken}` } });
  assert.equal(forbidden.status, 403);
  const invalid = await fetch(`${base}?status=superadmin`, { headers: { cookie: `bdc_os_session=${adminToken}` } });
  assert.equal(invalid.status, 400);
});

test("admin dealer directory reads each tenant only after setting its transaction context", async (context) => {
  const token = "dealer-directory-admin-session";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const dealers = [
    { id: "11111111-1111-4111-8111-111111111111", name: "North Dealer", status: "active", user_count: 2, pending_invitation_count: 1 },
    { id: "22222222-2222-4222-8222-222222222222", name: "South Dealer", status: "active", user_count: 1, pending_invitation_count: 0 },
  ];
  const clientCalls: Array<{ sql: string; values: unknown[] }> = [];
  let currentTenant = "";
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      clientCalls.push({ sql, values });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.includes("set_config('app.tenant_id'")) { currentTenant = String(values[0]); return { rows: [] }; }
      if (sql.includes("FROM public.tenants")) {
        assert.equal(values[0], currentTenant, "tenant query must match transaction-local RLS context");
        return { rows: dealers.filter((dealer) => dealer.id === currentTenant) };
      }
      throw new Error(`Unexpected directory SQL: ${sql.slice(0, 100)}`);
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM public.app_sessions")) return { rows: values[0] === tokenHash ? [{ id: "admin-id", email: "admin@example.com", display_name: "Admin", account_type: "admin" }] : [] };
      if (sql.includes("list_tenant_route_ids")) return { rows: dealers.map(({ id }) => ({ dealer_id: id })) };
      throw new Error(`Unexpected directory pool SQL: ${sql.slice(0, 100)}`);
    },
    connect: async () => client,
  } as unknown as Pool;
  const app = express();
  app.use("/auth", createIdentityRouter(pool, { production: false }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/auth/admin/dealers`, { headers: { cookie: `bdc_os_session=${token}` } });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json() as { dealers: unknown[] }).dealers, dealers);
  assert.deepEqual(clientCalls.filter(({ sql }) => sql.includes("set_config('app.tenant_id'")).map(({ values }) => values[0]), dealers.map(({ id }) => id));
  for (const tenantQuery of clientCalls.filter(({ sql }) => sql.includes("FROM public.tenants"))) {
    const queryIndex = clientCalls.indexOf(tenantQuery);
    const settingIndex = clientCalls.findIndex(({ sql, values }, index) => index < queryIndex && sql.includes("set_config('app.tenant_id'") && values[0] === tenantQuery.values[0]);
    const beginIndex = clientCalls.findIndex(({ sql }, index) => index < settingIndex && sql === "BEGIN");
    assert.ok(beginIndex >= 0 && beginIndex < settingIndex && settingIndex < queryIndex);
  }
});
