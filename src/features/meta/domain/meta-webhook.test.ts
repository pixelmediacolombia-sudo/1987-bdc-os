import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { parseMetaWebhookPayload } from "@/features/meta/domain/meta-webhook.parser";
import { isValidMetaWebhookSignature } from "@/features/meta/domain/meta-webhook.signature";

test("Meta Messenger events become the existing inbound conversation contract", () => {
  const raw = Buffer.from("messenger-event");
  const payload = { object: "page", entry: [{ id: "page-7", messaging: [{ sender: { id: "psid-9" }, recipient: { id: "page-7" }, message: { mid: "mid.1", text: "Busco una SUV" } }] }] };
  const [event] = parseMetaWebhookPayload(payload, raw, "sha256=test");
  assert.equal(event?.accountId, "page-7");
  assert.equal(event?.inboundMessage?.contactId, "psid-9");
  assert.equal(event?.inboundMessage?.channel, "fb");
  assert.equal(event?.inboundMessage?.content, "Busco una SUV");
  assert.equal(event?.inboundMessage?.providerMessageId, "mid.1");
});

test("Meta Instagram events keep the IG channel identity", () => {
  const [event] = parseMetaWebhookPayload({ object: "instagram", entry: [{ id: "ig-7", messaging: [{ sender: { id: "igsid-9" }, message: { mid: "ig-mid.1", text: "Hola" } }] }] }, Buffer.from("ig"), "sig");
  assert.equal(event?.accountId, "ig-7");
  assert.equal(event?.inboundMessage?.channel, "ig");
});

test("Meta WhatsApp Cloud events retain phone ID, contact, channel and CTWA attribution", () => {
  const payload = { object: "whatsapp_business_account", entry: [{ id: "waba-7", changes: [{ value: {
    metadata: { phone_number_id: "phone-7" },
    messages: [{ id: "wamid.1", from: "15551234567", type: "text", text: { body: "Quiero comprar" }, referral: { ctwa_clid: "ctwa-test", source_id: "ad-test" } }],
  } }] }] };
  const [event] = parseMetaWebhookPayload(payload, Buffer.from("wa"), "sig");
  assert.equal(event?.accountId, "phone-7");
  assert.equal(event?.inboundMessage?.channel, "whatsapp");
  assert.equal(event?.inboundMessage?.contactId, "15551234567");
  assert.equal(event?.inboundMessage?.ctwaClid, "ctwa-test");
  assert.equal(event?.inboundMessage?.ctwaSourceId, "ad-test");
});

test("Meta echoes are treated as human messages to suppress automated replies", () => {
  const [event] = parseMetaWebhookPayload({ object: "page", entry: [{ id: "page-1", messaging: [{ sender: { id: "psid-1" }, message: { mid: "mid.echo", text: "Agente humano", is_echo: true } }] }] }, Buffer.from("echo"), "sig");
  assert.equal(event?.humanInterruption?.trigger, "staff_message");
  assert.equal(event?.inboundMessage, undefined);
});

test("Meta webhook signature is verified against the exact raw body", () => {
  const body = Buffer.from('{"object":"page"}');
  const signature = `sha256=${createHmac("sha256", "test-app-secret").update(body).digest("hex")}`;
  assert.equal(isValidMetaWebhookSignature(body, signature, "test-app-secret"), true);
  assert.equal(isValidMetaWebhookSignature(body, signature, "wrong-secret"), false);
  assert.equal(isValidMetaWebhookSignature(body, "", "test-app-secret"), false);
});
