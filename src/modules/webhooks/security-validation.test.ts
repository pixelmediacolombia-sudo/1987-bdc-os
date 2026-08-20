import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import type { Request, Response } from "express";
import type { GhlOAuthController } from "@/features/ghl-oauth/presentation/http/ghl-oauth.controller";
import type { ProcessGHLWebhookUseCase } from "@/modules/webhooks/application/process-ghl-webhook.use-case";
import { WebhookController } from "@/modules/webhooks/presentation/http/webhook.controller";
import { createHttpApp } from "@/presentation/http/create-http-app";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const signatureKeys = {
  ed25519PublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
  // The test uses the current header. The production route carries GHL's RSA
  // compatibility key by default for X-WH-Signature.
  legacyRsaPublicKey: "invalid-test-key",
};

function signBody(body: string): string {
  return sign(null, Buffer.from(body, "utf8"), privateKey).toString("base64");
}

function createTestServer(processUseCase: ProcessGHLWebhookUseCase): ReturnType<typeof createHttpApp> {
  const oauthController = {
    initiateHandler: (_req: Request, res: Response) => res.status(404).end(),
    completeHandler: (_req: Request, res: Response) => res.status(404).end(),
  } as unknown as GhlOAuthController;
  return createHttpApp(oauthController, new WebhookController(processUseCase), signatureKeys);
}

async function postWebhook(body: string, headers: Record<string, string> = {}) {
  const processUseCase = {
    execute: async () => undefined,
  } as unknown as ProcessGHLWebhookUseCase;
  const app = createTestServer(processUseCase);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a port");

  try {
    return await fetch(`http://127.0.0.1:${address.port}/webhooks/ghl`, {
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

test("rejects invalid Ed25519 signatures", async () => {
  const body = JSON.stringify({ locationId: "location-1", eventId: "event-1" });
  const response = await postWebhook(body, { "x-ghl-signature": signBody(`${body}-wrong`) });
  assert.equal(response.status, 401);
});

test("rejects a valid signature when the raw body is altered", async () => {
  const original = JSON.stringify({ locationId: "location-1", eventId: "event-2" });
  const response = await postWebhook(
    JSON.stringify({ locationId: "location-1", eventId: "event-3" }),
    { "x-ghl-signature": signBody(original) },
  );
  assert.equal(response.status, 401);
});

test("ACKs a valid webhook and schedules processing outside the request", async () => {
  const body = JSON.stringify({ locationId: "location-1", eventId: "event-4" });
  let calls = 0;
  const processUseCase = {
    execute: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  } as unknown as ProcessGHLWebhookUseCase;
  const app = createTestServer(processUseCase);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a port");

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/webhooks/ghl`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ghl-signature": signBody(body) },
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
  const body = JSON.stringify({ locationId: "location-1", eventId: "event-5" });
  let calls = 0;
  const processUseCase = {
    execute: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  } as unknown as ProcessGHLWebhookUseCase;
  const app = createTestServer(processUseCase);
  const server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind a port");

  try {
    const responses = await Promise.all(Array.from({ length: 5 }, () => fetch(`http://127.0.0.1:${address.port}/webhooks/ghl`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-ghl-signature": signBody(body) },
      body,
    })));
    assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("RLS cross-tenant matrix isolates integrations, audits, raw webhooks, and outbound registry", {
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
    await client.query(
      `INSERT INTO public.tenants (dealer_id, ghl_location_id)
       VALUES ($1, $2), ($3, $4)`,
      [tenantA, `rls-location-a-${Date.now()}`, tenantB, `rls-location-b-${Date.now()}`],
    );
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantA]);

    const integration = await client.query<{ id: string }>(
      `INSERT INTO public.integrations
         (tenant_id, provider, encrypted_access_token, encrypted_refresh_token, scopes)
       VALUES ($1, 'ghl', 'test-access-a', 'test-refresh-a', ARRAY['contacts.readonly'])
       RETURNING id`,
      [tenantA],
    );
    const integrationId = integration.rows[0]?.id;
    assert.ok(integrationId);

    await client.query(
      `INSERT INTO public.integration_token_audits (tenant_id, integration_id, action, metadata)
       VALUES ($1, $2, 'token_refreshed', '{}'::jsonb)`,
      [tenantA, integrationId],
    );
    await client.query(
      `INSERT INTO public.raw_webhooks
         (tenant_id, external_id, event_type, location_id, signature, payload)
       VALUES ($1, 'rls-test-a', 'ContactCreate', 'rls-location-a', 'test-signature', '{}'::jsonb)`,
      [tenantA],
    );
    await client.query(
      `INSERT INTO public.outbound_message_registry
         (tenant_id, contact_id, semantic_hash, provider_message_id, content)
       VALUES ($1, 'rls-contact-a', 'rls-hash-a', 'rls-provider-a', 'tenant A')`,
      [tenantA],
    );

    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantB]);
    for (const table of ["integrations", "integration_token_audits", "raw_webhooks", "outbound_message_registry"]) {
      const visible = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.${table}`);
      assert.equal(visible.rows[0]?.count, "0", `${table} leaked tenant A rows`);
    }

    await client.query("SAVEPOINT cross_tenant_insert");
    try {
      await assert.rejects(
        client.query(
          `INSERT INTO public.integrations
             (tenant_id, provider, encrypted_access_token, scopes)
           VALUES ($1, 'ghl', 'cross-tenant', ARRAY[]::text[])`,
          [tenantA],
        ),
      );
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT cross_tenant_insert");
      await client.query("RELEASE SAVEPOINT cross_tenant_insert");
    }
    assert.equal(
      (await client.query("UPDATE public.integrations SET health_state = 'degraded' WHERE id = $1", [integrationId])).rowCount,
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
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
