import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import express from "express";
import test from "node:test";
import { createMetaWebhookRouter } from "@/features/meta/presentation/http/meta-webhook.routes";
import { MetaWebhookController } from "@/features/meta/presentation/http/meta-webhook.controller";
import type { WebhookQueuePort } from "@/modules/webhooks/application/ports/webhook-queue.port";

test("Meta webhook HTTP handshake and signature checks work with a local server", async (context) => {
  let processed = 0;
  const queue: WebhookQueuePort = {
    enqueue: async (_raw, _signature, task) => { await task(); return true; },
    start: async () => undefined,
    stop: async () => undefined,
  };
  const controller = new MetaWebhookController({ execute: async () => { processed += 1; } } as never, queue, "local-verify-token");
  const app = express();
  app.use("/webhooks/meta", createMetaWebhookRouter(controller, "local-app-secret"));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const baseUrl = `http://127.0.0.1:${address.port}/webhooks/meta`;

  const handshake = await fetch(`${baseUrl}?hub.mode=subscribe&hub.verify_token=local-verify-token&hub.challenge=challenge-test`);
  assert.equal(handshake.status, 200);
  const rawBody = Buffer.from('{"object":"page","entry":[{"id":"page-test","messaging":[{"sender":{"id":"psid-test"},"message":{"mid":"mid-test","text":"Hola"}}]}]}');
  const signature = `sha256=${createHmac("sha256", "local-app-secret").update(rawBody).digest("hex")}`;
  const accepted = await fetch(baseUrl, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": signature }, body: rawBody });
  assert.equal(accepted.status, 200);
  assert.equal(processed, 1);
  const denied = await fetch(baseUrl, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=bad" }, body: rawBody });
  assert.equal(denied.status, 401);
});
