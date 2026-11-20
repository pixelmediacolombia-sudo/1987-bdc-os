import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { MetaWebhookController } from "@/features/meta/presentation/http/meta-webhook.controller";
import { InMemoryWebhookQueue } from "@/modules/webhooks/application/in-memory-webhook.queue";
import { createHttpApp } from "@/presentation/http/create-http-app";

const APP_SECRET = "local-meta-app-secret";

function signBody(body: string): string {
  return `sha256=${createHmac("sha256", APP_SECRET).update(body).digest("hex")}`;
}

function payload(id = "message-1") {
  return { object: "page", entry: [{ id: "page-1", messaging: [{ sender: { id: "person-1" }, recipient: { id: "page-1" }, message: { mid: id, text: "Hola" } }] }] };
}

function createTestServer(process: (event: unknown) => Promise<void> = async () => undefined): ReturnType<typeof createHttpApp> {
  const controller = new MetaWebhookController({ execute: process } as never, new InMemoryWebhookQueue(), "verify-token");
  return createHttpApp({ metaWebhook: { controller, appSecret: APP_SECRET } });
}

async function postWebhook(body: string, headers: Record<string, string> = {}) {
  const app = createTestServer();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a port");

  try {
    return await fetch(`http://127.0.0.1:${address.port}/webhooks/meta`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("rejects an unsigned webhook before JSON parsing", async () => {
  const response = await postWebhook("not-json");
  assert.equal(response.status, 401);
});

test("rejects invalid Meta signatures", async () => {
  const body = JSON.stringify(payload());
  const response = await postWebhook(body, { "x-hub-signature-256": signBody(`${body}-wrong`) });
  assert.equal(response.status, 401);
});

test("rejects a valid signature when the raw body is altered", async () => {
  const original = JSON.stringify(payload("event-2"));
  const response = await postWebhook(
    JSON.stringify(payload("event-3")),
    { "x-hub-signature-256": signBody(original) },
  );
  assert.equal(response.status, 401);
});

test("ACKs a valid webhook and schedules processing outside the request", async () => {
  const body = JSON.stringify(payload("event-4"));
  let calls = 0;
  const app = createTestServer(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a port");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/meta`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signBody(body) },
      body,
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, queued: true, duplicate_in_flight: false });
    for (let attempt = 0; attempt < 20 && calls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("collapses five identical concurrent deliveries to one background task", async () => {
  const body = JSON.stringify(payload("event-5"));
  let calls = 0;
  const app = createTestServer(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    });
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a port");

  try {
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`http://127.0.0.1:${address.port}/webhooks/meta`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": signBody(body) },
      body,
    })));
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("legacy /tests diagnostics and disabled internal diagnostics are not public routes", async () => {
  const app = createTestServer();
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a port");
  try {
    const legacy = await fetch(`http://127.0.0.1:${address.port}/tests/policy-evaluation?contact_id=fixture`);
    const internal = await fetch(`http://127.0.0.1:${address.port}/internal/admin/diagnostics/policy-evaluation?tenant_id=00000000-0000-0000-0000-000000000901`);
    assert.equal(legacy.status, 404);
    assert.equal(internal.status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("RLS cross-tenant matrix isolates Meta credentials, webhooks, and outbound registry", {
  skip: !process.env.SECURITY_TEST_DATABASE_URL,
}, async () => {
  const tenantA = process.env.SECURITY_TEST_TENANT_A;
  const tenantB = process.env.SECURITY_TEST_TENANT_B;
  assert.match(tenantA ?? "", /^[0-9a-f-]{36}$/i);
  assert.match(tenantB ?? "", /^[0-9a-f-]{36}$/i);

  const pool = new Pool({
    connectionString: process.env.SECURITY_TEST_DATABASE_URL,
    ssl: ["1", "true", "yes"].includes((process.env.SECURITY_TEST_DATABASE_SSL ?? "").toLowerCase())
      ? { rejectUnauthorized: false }
      : undefined,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '10s'");
    if (process.env.SECURITY_TEST_ROLE) {
      assert.match(process.env.SECURITY_TEST_ROLE, /^[a-z_][a-z0-9_]{0,62}$/i, "SECURITY_TEST_ROLE must be a simple PostgreSQL role name");
      await client.query(`SET LOCAL ROLE "${process.env.SECURITY_TEST_ROLE}"`);
    }
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);

    await client.query(
      `INSERT INTO public.meta_messaging_connections
         (tenant_id, facebook_page_id, encrypted_page_access_token, granted_scopes)
       VALUES ($1, $2, 'encrypted-test-token', ARRAY['pages_messaging']::text[])`,
      [tenantA, `security-page-${tenantA}`],
    );
    await client.query(
      `INSERT INTO public.raw_webhooks
         (tenant_id, external_id, event_type, account_id, signature, payload)
       VALUES ($1, 'rls-test-a', 'MetaMessage', $2, 'test-signature', '{}'::jsonb)`,
      [tenantA, `security-page-${tenantA}`],
    );
    await client.query(
      `INSERT INTO public.outbound_message_registry
         (tenant_id, contact_id, semantic_hash, provider_message_id, content)
       VALUES ($1, 'rls-contact-a', 'rls-hash-a', 'rls-provider-a', 'tenant A')`,
      [tenantA],
    );
    await client.query(
      `INSERT INTO public.internal_diagnostic_access_audit
         (tenant_id, actor, request_id, method, route, remote_address)
       VALUES ($1, 'rls-evidence', $2, 'GET', '/internal/admin/diagnostics/redis-health', '127.0.0.1')`,
      [tenantA, randomUUID()],
    );

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
    for (const table of ["meta_messaging_connections", "raw_webhooks", "outbound_message_registry", "internal_diagnostic_access_audit"]) {
      const visible = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.${table}`);
      assert.equal(visible.rows[0]?.count, "0", `${table} leaked tenant A rows`);
    }

    await client.query("SAVEPOINT cross_tenant_insert");
    try {
      await assert.rejects(
        client.query(
          `INSERT INTO public.meta_messaging_connections
             (tenant_id, facebook_page_id, encrypted_page_access_token, granted_scopes)
           VALUES ($1, $2, 'cross-tenant', ARRAY[]::text[])`,
          [tenantA, `cross-tenant-page-${tenantB}`],
        ),
      );
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT cross_tenant_insert");
      await client.query("RELEASE SAVEPOINT cross_tenant_insert");
    }
    assert.equal(
      (await client.query("UPDATE public.meta_messaging_connections SET health_state = 'degraded' WHERE tenant_id = $1", [tenantA])).rowCount,
      0,
    );
    assert.equal(
      (await client.query("DELETE FROM public.raw_webhooks WHERE tenant_id = $1", [tenantA])).rowCount,
      0,
    );
    assert.equal(
      (await client.query("UPDATE public.outbound_message_registry SET content = 'cross-tenant' WHERE tenant_id = $1", [tenantA])).rowCount,
      0,
    );
    assert.equal(
      (await client.query("DELETE FROM public.outbound_message_registry WHERE tenant_id = $1", [tenantA])).rowCount,
      0,
    );
    assert.equal(
      (await client.query("UPDATE public.internal_diagnostic_access_audit SET actor = 'cross-tenant' WHERE tenant_id = $1", [tenantA])).rowCount,
      0,
    );
    assert.equal(
      (await client.query("DELETE FROM public.internal_diagnostic_access_audit WHERE tenant_id = $1", [tenantA])).rowCount,
      0,
    );
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
