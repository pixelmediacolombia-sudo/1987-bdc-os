import assert from "node:assert/strict";
import { once } from "node:events";
import express from "express";
import test from "node:test";
import type { Pool } from "pg";
import { createIdentityRouter } from "@/features/identity/presentation/http/identity.routes";

type AccountType = "admin" | "user";
const sessionCookie = "bdc_os_session=health-test-session";

function createApp(accountType: AccountType | undefined, redisPing: () => Promise<string>, failHealthQuery = false) {
  let redisCalls = 0;
  const user = accountType ? {
    id: "health-user",
    email: "health@example.test",
    display_name: "Health Test",
    account_type: accountType,
  } : undefined;
  const pool = {
    query: async (sql: string) => {
      if (sql.includes("FROM public.app_sessions")) return { rows: user ? [user] : [] };
      if (sql.trim() === "SELECT 1") {
        if (failHealthQuery) throw new Error("database connection details must not escape");
        return { rows: [{ "?column?": 1 }] };
      }
      throw new Error("Unexpected SQL in system health test: " + sql.substring(0, 40));
    },
  } as unknown as Pool;
  const app = express();
  app.use("/auth", createIdentityRouter(pool, {
    production: false,
    redisPing: async () => {
      redisCalls += 1;
      return redisPing();
    },
  }));
  return { app, redisCalls: () => redisCalls };
}

async function openServer(app: express.Express, context: { after(callback: () => void | Promise<void>): void }) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port + "/auth/admin/system/health";
}

test("global system health requires an authenticated admin before probing services", async (context) => {
  const { app, redisCalls } = createApp(undefined, async () => "PONG");
  const url = await openServer(app, context);
  const response = await fetch(url, { headers: { cookie: sessionCookie } });
  assert.equal(response.status, 401);
  assert.equal(redisCalls(), 0);
});

test("dealer accounts cannot read global system health", async (context) => {
  const { app, redisCalls } = createApp("user", async () => "PONG");
  const url = await openServer(app, context);
  const response = await fetch(url, { headers: { cookie: sessionCookie } });
  assert.equal(response.status, 403);
  assert.equal(redisCalls(), 0);
});

test("admin receives healthy API, PostgreSQL and Redis status", async (context) => {
  const { app } = createApp("admin", async () => "PONG");
  const url = await openServer(app, context);
  const response = await fetch(url, { headers: { cookie: sessionCookie } });
  assert.equal(response.status, 200);
  const payload = await response.json() as { overall: string; checked_at: string; services: { api: string; postgresql: string; redis: string } };
  assert.equal(payload.overall, "healthy");
  assert.equal(typeof payload.checked_at, "string");
  assert.ok(!Number.isNaN(Date.parse(payload.checked_at)));
  assert.deepEqual(payload.services, { api: "healthy", postgresql: "healthy", redis: "healthy" });
});

test("Redis failure is reported as degraded without leaking connection errors", async (context) => {
  const { app } = createApp("admin", async () => { throw new Error("redis://private-host:6379/password"); });
  const url = await openServer(app, context);
  const response = await fetch(url, { headers: { cookie: sessionCookie } });
  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /"overall":"degraded"/);
  assert.match(body, /"redis":"unavailable"/);
  assert.doesNotMatch(body, /private-host|password|6379/);
});

test("database health failures return a generic service error", async (context) => {
  const { app, redisCalls } = createApp("admin", async () => "PONG", true);
  const url = await openServer(app, context);
  const response = await fetch(url, { headers: { cookie: sessionCookie } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "No pudimos consultar el estado global del sistema." });
  assert.equal(redisCalls(), 0);
});