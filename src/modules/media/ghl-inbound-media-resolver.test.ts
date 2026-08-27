import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { GhlInboundMediaResolver } from "@/modules/media/infrastructure/ghl-inbound-media-resolver";
import type { GhlWebhookEvent } from "@/modules/webhooks/domain/ghl-webhook-event";

test("resuelve la grabacion de GHL por messageId sin exponer el token", async () => {
  let requestedUrl = "";
  let requestedVersion = "";
  const resolver = new GhlInboundMediaResolver(
    { request: async (_tenantId: string, config: { url?: string; headers?: Record<string, unknown> }) => {
      requestedUrl = String(config.url);
      requestedVersion = String(config.headers && (config.headers as Record<string, unknown>).Version);
      return { headers: { "content-type": "audio/ogg; codecs=opus" }, data: Buffer.from("audio-bytes") };
    } } as never,
    { resolveTenantId: async (locationId) => locationId === "location-1" ? "tenant-1" : undefined },
    { info: () => undefined, error: () => undefined },
  );
  const event: GhlWebhookEvent = {
    externalId: "external-1",
    eventType: "InboundMessage",
    locationId: "location-1",
    signature: "redacted",
    rawBody: Buffer.from("{}"),
    payload: {},
    inboundMessage: {
      externalId: "external-1",
      providerMessageId: "message-1",
      contactId: "contact-1",
      channel: "whatsapp",
      content: "",
      semanticHash: "hash-1",
    },
  };

  const resolved = await resolver.resolve(event);
  const attachment = resolved.inboundMessage?.attachments?.[0];
  assert.match(requestedUrl, /conversations\/messages\/message-1\/locations\/location-1\/recording$/);
  assert.equal(requestedVersion, "v3");
  assert.equal(resolved.inboundMessage?.content, "Adjunto de audio");
  assert.equal(attachment?.kind, "audio");
  assert.equal(attachment?.mimeType, "audio/ogg");
  assert.ok(attachment?.localPath);
  assert.deepEqual(await readFile(attachment.localPath), Buffer.from("audio-bytes"));
});
