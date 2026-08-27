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

test("prioriza stop_ai cuando convive con human_takeover", () => {
  const event = parseGhlWebhookPayload({
    eventId: "stop-priority-1",
    eventType: "ContactTagUpdate",
    locationId: "location-1",
    contactId: "contact-1",
    tags: ["follow-up", "human_takeover", "stop_ai"],
  }, Buffer.from("stop-priority-1"), "test-signature");

  assert.equal(event.humanInterruption?.controlTag, "stop_ai");
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

test("extrae el id del mensaje del proveedor para no confundir la salida de Sofia con un humano", () => {
  const payload = {
    eventId: "delivery-42",
    type: "OutboundMessage",
    locationId: "location-sandbox",
    messageId: "provider-message-42",
    contactId: "contact-42",
    conversationId: "conversation-42",
    message: { body: "Respuesta automatizada." },
  };
  const event = parseGhlWebhookPayload(payload, Buffer.from(JSON.stringify(payload)), "signature");
  assert.equal(event.externalId, "delivery-42");
  assert.equal(event.humanInterruption?.staffMessage?.providerMessageId, "provider-message-42");
});

test("reconoce WhatsApp cuando GHL lo entrega como messageType plano", () => {
  const payload = {
    type: "OutboundMessage",
    locationId: "location-sandbox",
    id: "provider-message-whatsapp-42",
    contactId: "contact-42",
    conversationId: "conversation-42",
    messageType: "WhatsApp",
    message: { body: "Te atiendo por WhatsApp." },
  };
  const event = parseGhlWebhookPayload(payload, Buffer.from(JSON.stringify(payload)), "signature");
  assert.equal(event.humanInterruption?.staffMessage?.channel, "whatsapp");
});

test("reconoce adjuntos multimedia de GHL cuando attachments contiene una URL", () => {
  const payload = {
    type: "InboundMessage",
    locationId: "location-sandbox",
    id: "inbound-whatsapp-audio-42",
    contactId: "contact-42",
    conversationId: "conversation-42",
    messageType: "WhatsApp",
    contentType: "text/plain",
    body: "",
    attachments: ["https://media.example.test/voice.ogg?signature=redacted"],
  };
  const event = parseGhlWebhookPayload(payload, Buffer.from(JSON.stringify(payload)), "signature");
  assert.equal(event.inboundMessage?.channel, "whatsapp");
  assert.equal(event.inboundMessage?.content, "Adjunto de audio");
  assert.deepEqual(event.inboundMessage?.attachments?.[0], {
    kind: "audio",
    url: "https://media.example.test/voice.ogg?signature=redacted",
  });
});

test("normaliza los canales de mensajería compatibles con GHL", () => {
  const cases = [
    ["Messenger", "fb"],
    ["Facebook Messenger", "fb"],
    ["Facebook", "fb"],
    ["Instagram DM", "ig"],
    ["Instagram", "ig"],
    ["WhatsApp", "whatsapp"],
  ] as const;

  for (const [messageType, expectedChannel] of cases) {
    const payload = {
      type: "InboundMessage",
      locationId: "location-sandbox",
      id: `inbound-${messageType}`,
      contactId: "contact-42",
      messageType,
      body: "Mensaje de prueba",
    };
    const event = parseGhlWebhookPayload(payload, Buffer.from(JSON.stringify(payload)), "signature");
    assert.equal(event.inboundMessage?.channel, expectedChannel, messageType);
  }
});

test("deja fuera de soporte los canales que la app no utiliza", () => {
  const payload = {
    type: "InboundMessage",
    locationId: "location-sandbox",
    id: "inbound-sms-42",
    contactId: "contact-42",
    messageType: "SMS",
    body: "Mensaje de prueba",
  };
  const event = parseGhlWebhookPayload(payload, Buffer.from(JSON.stringify(payload)), "signature");
  assert.equal(event.inboundMessage, undefined);
});

test("reconoce WhatsApp cuando GHL lo entrega como proveedor de la conversación", () => {
  const payload = {
    type: "InboundMessage",
    locationId: "location-sandbox",
    id: "inbound-whatsapp-provider-42",
    contactId: "contact-42",
    conversation: { provider: "WhatsApp" },
    message: { body: "Mensaje de prueba" },
  };
  const event = parseGhlWebhookPayload(payload, Buffer.from(JSON.stringify(payload)), "signature");
  assert.equal(event.inboundMessage?.channel, "whatsapp");
});
