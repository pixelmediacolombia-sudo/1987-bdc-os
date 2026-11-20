import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import type { Pool } from "pg";
import { createIdentityRouter } from "@/features/identity/presentation/http/identity.routes";

test("admin audit is role protected, filtered, paginated, and returns snapshots", async (context) => {
  const token = "audit-admin-session";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const dealerToken = "audit-dealer-session";
  const dealerTokenHash = createHash("sha256").update(dealerToken).digest("hex");
  const dealerUser = { id: "dealer-id", email: "dealer@example.com", display_name: "Dealer User", account_type: "user" as const };
  const admin = { id: "admin-id", email: "admin@example.com", display_name: "Platform Admin", account_type: "admin" as const };
  const dealerId = "11111111-1111-4111-8111-111111111111";
  let countSql = "";
  let listSql = "";
  let queryValues: unknown[] = [];
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM public.app_sessions")) return { rows: values[0] === tokenHash ? [admin] : values[0] === dealerTokenHash ? [dealerUser] : [] };
      if (sql.includes("COUNT(*)::text AS total")) { countSql = sql; queryValues = values; return { rows: [{ total: "63" }] }; }
      if (sql.includes("FROM public.admin_audit_events")) {
        listSql = sql;
        return { rows: [{ id: "event-1", actor_email: "admin@example.com", actor_name: "Platform Admin", dealer_id: dealerId,
          dealer_name: "North Dealer", category: "dealers", action: "dealer.created", outcome: "success",
          summary: "Dealer creado y se registró la invitación.", reference_id: "corr-42", created_at: "2026-11-20T15:00:00.000Z" }] };
      }
      throw new Error(`Unexpected audit SQL: ${sql.slice(0, 100)}`);
    },
  } as unknown as Pool;
  const app = express();
  app.use(express.json());
  app.use("/auth", createIdentityRouter(pool, { production: false }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/auth/admin/audit`;
  const params = new URLSearchParams({ dealerId, actor: "admin@example.com", category: "dealers", from: "2026-11-01", to: "2026-11-20", search: "corr-42", limit: "10", offset: "20" });
  const response = await fetch(`${base}?${params}`, { headers: { cookie: `bdc_os_session=${token}` } });
  assert.equal(response.status, 200);
  const body = await response.json() as { total: number; limit: number; offset: number; events: Array<{ actor_email: string; dealer_name: string; reference_id: string }> };
  assert.equal(body.total, 63);
  assert.equal(body.limit, 10);
  assert.equal(body.offset, 20);
  assert.equal(body.events[0]?.actor_email, "admin@example.com");
  assert.equal(body.events[0]?.dealer_name, "North Dealer");
  assert.equal(body.events[0]?.reference_id, "corr-42");
  assert.match(countSql, /lower\(actor_email\) LIKE lower\(\$2\) OR lower\(actor_name\) LIKE lower\(\$2\)/);
  assert.match(listSql, /ORDER BY created_at DESC, id DESC/);
  assert.deepEqual(queryValues, [dealerId, "%admin@example.com%", "dealers", "2026-11-01", "2026-11-20", "%corr-42%"]);

  const denied = await fetch(base);
  assert.equal(denied.status, 401);
  const forbidden = await fetch(base, { headers: { cookie: `bdc_os_session=${dealerToken}` } });
  assert.equal(forbidden.status, 403);
  const invalid = await fetch(`${base}?limit=1000`, { headers: { cookie: `bdc_os_session=${token}` } });
  assert.equal(invalid.status, 400);
});
