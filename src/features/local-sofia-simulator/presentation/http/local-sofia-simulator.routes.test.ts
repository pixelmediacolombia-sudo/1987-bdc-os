import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Pool } from "pg";
import { createLocalSofiaSimulatorRouter } from "@/features/local-sofia-simulator/presentation/http/local-sofia-simulator.routes";

function fakePool(accountType?: "admin" | "user") {
  return {
    query: async (sql: string) => sql.includes("FROM public.app_sessions AS s") && accountType
      ? { rows: [{ id: "user-1", email: "admin@example.test", display_name: "Local", account_type: accountType }], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  } as unknown as Pool;
}

async function send(path: string, method = "GET", body?: unknown, accountType?: "admin" | "user") {
  const app = express();
  app.use(express.json());
  const simulator = { turn: async (message: string) => ({ message }), reset: () => undefined };
  app.use(createLocalSofiaSimulatorRouter(fakePool(accountType), simulator as never, "https://api.openai.com/v1"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try {
    const response = await fetch("http://127.0.0.1:" + address.port + path, {
      method,
      headers: { cookie: "bdc_os_session=local-session", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { response, payload: await response.json() as Record<string, unknown> };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("local simulator requires an authenticated admin", async () => {
  assert.equal((await send("/local/sofia-simulator/status")).response.status, 401);
  assert.equal((await send("/local/sofia-simulator/status", "GET", undefined, "user")).response.status, 403);
  const allowed = await send("/local/sofia-simulator/status", "GET", undefined, "admin");
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.payload.modelHost, "api.openai.com");
  assert.equal(allowed.payload.sendsMessages, false);
});

test("local simulator validates turns and exposes only development turn calls", async () => {
  const denied = await send("/local/sofia-simulator/turn", "POST", { message: "hola" }, "admin");
  assert.equal(denied.response.status, 200);
  assert.deepEqual(denied.payload, { message: "hola" });
  const invalid = await send("/local/sofia-simulator/turn", "POST", { message: "" }, "admin");
  assert.equal(invalid.response.status, 400);
});
