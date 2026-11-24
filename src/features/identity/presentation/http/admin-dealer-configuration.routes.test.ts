import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import express from "express";
import type { Pool, PoolClient } from "pg";
import { createIdentityRouter } from "@/features/identity/presentation/http/identity.routes";

test("admin dealer configuration exposes safe state and never returns stored credentials", async (context) => {
  const token = "configuration-admin-session";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const dealerId = "11111111-1111-4111-8111-111111111111";
  const calls: string[] = [];
  const client = {
    query: async (sql: string, values: unknown[] = []) => {
      calls.push(sql);
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("set_config")) { assert.deepEqual(values, [dealerId]); return { rows: [] }; }
      if (sql.includes("FROM public.capi_events")) return { rows: [{ status: "sent", created_at: "2026-11-20T12:30:00.000Z" }] };
      if (sql.includes("FROM public.tenants")) return { rows: [{ id: dealerId, name: "Demo Dealer", status: "active", timezone: "America/Bogota", policy_version: "policy-v1", financial_policy: { downPaymentMinimum: 1000 }, sofia_enabled: true, qualification_flow_enabled: true, qualification_signal_enabled: false, meta_dataset_id: "dataset-1", has_meta_access_token: true, meta_event_name: "LeadSubmitted", meta_capi_enabled: true, has_meta_test_event_code: true, facebook_page_id: "page-1", conversational_ai_shadow_enabled: true, conversational_ai_send_enabled: false }] };
      return { rows: [] };
    }, release: () => undefined,
  } as unknown as PoolClient;
  const pool = {
    query: async (sql: string, values: unknown[] = []) => {
      if (sql.includes("FROM public.app_sessions")) return { rows: values[0] === tokenHash ? [{ id: "admin-id", email: "admin@example.com", display_name: "Admin", account_type: "admin" }] : [] };
      throw new Error(`Unexpected configuration SQL: ${sql.slice(0, 100)}`);
    }, connect: async () => client,
  } as unknown as Pool;
  const app = express();
  app.use("/auth", createIdentityRouter(pool, { production: false }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/auth/admin/dealers/${dealerId}/configuration`;
  const response = await fetch(base, { headers: { cookie: `bdc_os_session=${token}` } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.doesNotMatch(body, /ENCRYPTED_META_SECRET|TEST_SECRET/);
  assert.match(body, /"hasCredential":true/);
  assert.match(body, /"lastEventStatus":"sent"/);
  assert.ok(calls.some((sql) => sql.includes("set_config('app.tenant_id'")));
  assert.equal(calls.some((sql) => sql.includes("FROM public.integrations")), false);
});

test("dealer configuration rejects invalid and unauthenticated requests", async (context) => {
  const dealerToken = "configuration-dealer-session";
  const dealerTokenHash = createHash("sha256").update(dealerToken).digest("hex");
  const pool = { query: async (sql: string, values: unknown[] = []) => sql.includes("FROM public.app_sessions")
    ? { rows: values[0] === dealerTokenHash ? [{ id: "dealer-user", email: "dealer@example.com", display_name: "Dealer", account_type: "user" }] : [] }
    : { rows: [] } } as unknown as Pool;
  const app = express();
  app.use("/auth", createIdentityRouter(pool, { production: false }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/auth/admin/dealers`;
  const invalid = await fetch(`${base}/bad/configuration`);
  assert.equal(invalid.status, 400);
  const unauthorized = await fetch(`${base}/11111111-1111-4111-8111-111111111111/configuration`);
  assert.equal(unauthorized.status, 401);
  const forbidden = await fetch(`${base}/11111111-1111-4111-8111-111111111111/configuration`, { headers: { cookie: `bdc_os_session=${dealerToken}` } });
  assert.equal(forbidden.status, 403);
});

test("dealer configuration returns not found for a dealer that does not exist", async (context) => {
  const token = "configuration-missing-dealer-admin";
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const client = { query: async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
    if (sql.includes("FROM public.tenants")) return { rows: [] };
    return { rows: [] };
  }, release: () => undefined };
  const pool = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes("FROM public.app_sessions")) return { rows: values[0] === tokenHash ? [{ id: "admin-id", email: "admin@example.com", display_name: "Admin", account_type: "admin" }] : [] };
    throw new Error(`Unexpected dealer configuration SQL: ${sql.slice(0, 100)}`);
  }, connect: async () => client } as unknown as Pool;
  const app = express();
  app.use("/auth", createIdentityRouter(pool, { production: false }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/auth/admin/dealers/11111111-1111-4111-8111-111111111111/configuration`, { headers: { cookie: `bdc_os_session=${token}` } });
  assert.equal(response.status, 404);
});
