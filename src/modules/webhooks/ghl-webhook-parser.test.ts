import assert from "node:assert/strict";
import { test } from "node:test";
import { parseGhlWebhookPayload } from "@/modules/webhooks/domain/ghl-webhook.parser";

test("reconoce ContactTagUpdate oficial sin usar el id del contacto como entrega", () => {
  const payload = {
    type: "ContactTagUpdate",
    locationId: "location-sandbox",
    id: "contact-42",
    tag: { name: "human_takeover" },
    timestamp: "2026-08-19T22:00:00.000Z",
  };
  const raw = Buffer.from(JSON.stringify(payload));
  const first = parseGhlWebhookPayload(payload, raw, "signature");
  const second = parseGhlWebhookPayload(payload, raw, "signature");
  assert.equal(first.eventType, "ContactTagUpdate");
  assert.equal(first.humanInterruption?.trigger, "control_tag");
  assert.equal(first.externalId, second.externalId);
  assert.notEqual(first.externalId, "contact-42");
});

test("reconoce OutboundMessage oficial sin sender_type y lo trata como outbound desconocido", () => {
  const payload = {
    type: "OutboundMessage",
    locationId: "location-sandbox",
    id: "provider-message-42",
    contactId: "contact-42",
    conversationId: "conversation-42",
    message: { body: "Te atiendo personalmente." },
  };
  const event = parseGhlWebhookPayload(payload, Buffer.from(JSON.stringify(payload)), "signature");
  assert.equal(event.humanInterruption?.trigger, "staff_message");
  assert.equal(event.humanInterruption?.staffMessage?.content, "Te atiendo personalmente.");
  assert.equal(event.humanInterruption?.staffMessage?.channel, "other");
});
