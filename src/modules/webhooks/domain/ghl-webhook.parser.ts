import { createHash } from "node:crypto";
import type { GhlWebhookEvent, InboundMessage, JsonObject } from "@/modules/webhooks/domain/ghl-webhook-event";
import { InvalidGhlWebhookError } from "@/modules/webhooks/domain/ghl-webhook-event";

function asObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringAt(payload: JsonObject, paths: string[]): string | undefined {
  for (const path of paths) {
    const parts = path.split(".");
    let value: unknown = payload;
    for (const part of parts) value = asObject(value)?.[part];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function objectAt(payload: JsonObject, paths: string[]): JsonObject | undefined {
  for (const path of paths) {
    const parts = path.split(".");
    let value: unknown = payload;
    for (const part of parts) value = asObject(value)?.[part];
    const object = asObject(value);
    if (object) return object;
  }
  return undefined;
}

function isInbound(payload: JsonObject, eventType: string): boolean {
  const direction = stringAt(payload, ["direction", "message.direction"])?.toLowerCase();
  if (direction) return direction === "inbound" || direction === "incoming" || direction === "received";
  return /inbound|incoming|received|message\.created|message_created/.test(eventType.toLowerCase());
}

function buildInboundMessage(payload: JsonObject, eventType: string, externalId: string): InboundMessage | undefined {
  if (!isInbound(payload, eventType)) return undefined;

  const message = objectAt(payload, ["message", "data.message"]) ?? payload;
  const contact = objectAt(payload, ["contact", "data.contact"]);
  const contactId = stringAt(payload, ["contactId", "contact_id", "contact.id", "data.contactId", "data.contact_id"])
    ?? stringAt(message, ["contactId", "contact_id", "contact.id"]);
  const content = stringAt(message, ["content", "body", "text", "message"]) ?? stringAt(payload, ["content", "body", "text"]);

  if (!contactId || !content) return undefined;

  const conversationId = stringAt(payload, [
    "conversationId",
    "conversation_id",
    "conversation.id",
    "data.conversationId",
    "data.conversation_id",
  ]) ?? stringAt(message, ["conversationId", "conversation_id", "conversation.id"]);
  const normalizedContent = content.replace(/\s+/g, " ").trim().toLowerCase();
  const semanticHash = createHash("sha256")
    .update([contactId, conversationId ?? "", normalizedContent].join("|"), "utf8")
    .digest("hex");

  const phone = stringAt(contact ?? {}, ["phone"]);
  const email = stringAt(contact ?? {}, ["email"]);

  return {
    externalId,
    contactId,
    ...(conversationId ? { conversationId } : {}),
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    channel: stringAt(payload, ["channel", "message.channel", "conversation.channel"]) ?? "unknown",
    content,
    semanticHash,
  };
}

export function parseGhlWebhookPayload(
  payload: unknown,
  rawBody: Buffer,
  signature: string,
): GhlWebhookEvent {
  const object = asObject(payload);
  if (!object) throw new InvalidGhlWebhookError("Webhook payload must be a JSON object");

  const locationId = stringAt(object, ["locationId", "location_id", "location.id", "data.locationId", "data.location_id"]);
  const externalId = stringAt(object, [
    "eventId",
    "event_id",
    "messageId",
    "message_id",
    "message.id",
    "data.eventId",
    "data.event_id",
    "id",
  ]);
  const eventType = stringAt(object, ["eventType", "event_type", "type", "event", "data.eventType"]) ?? "unknown";

  if (!locationId) throw new InvalidGhlWebhookError("Webhook payload is missing locationId");
  if (!externalId) throw new InvalidGhlWebhookError("Webhook payload is missing an event or message identifier");

  return {
    locationId,
    externalId,
    eventType,
    signature,
    rawBody,
    payload: object,
    inboundMessage: buildInboundMessage(object, eventType, externalId),
  };
}
