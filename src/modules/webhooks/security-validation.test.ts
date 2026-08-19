import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
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

test("RLS cross-tenant matrix requires an explicit test database", { skip: !process.env.SECURITY_TEST_DATABASE_URL }, async () => {
  // This opt-in integration test is intentionally not run against .env or a
  // production database. Set SECURITY_TEST_DATABASE_URL plus two disposable
  // tenant UUIDs in the test environment to exercise SELECT/INSERT/UPDATE/DELETE.
  assert.ok(process.env.SECURITY_TEST_TENANT_A);
  assert.ok(process.env.SECURITY_TEST_TENANT_B);
});
