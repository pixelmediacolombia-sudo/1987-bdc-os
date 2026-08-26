import { createHash } from "node:crypto";
import type {
  GhlWebhookEvent,
  HumanInterruption,
  InboundMessage,
  JsonObject,
} from "@/modules/webhooks/domain/ghl-webhook-event";
import { InvalidGhlWebhookError } from "@/modules/webhooks/domain/ghl-webhook-event";
import { extractCtwaAttribution } from "@/modules/webhooks/domain/ctwa-clid";

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

function valueAt(payload: JsonObject, path: string): unknown {
  let value: unknown = payload;
  for (const part of path.split(".")) value = asObject(value)?.[part];
  return value;
}

function stringsAt(payload: JsonObject, paths: string[]): string[] {
  for (const path of paths) {
    const value = valueAt(payload, path);
    if (!Array.isArray(value)) continue;
    const values = value.map((item) => typeof item === "string" ? item : stringAt(asObject(item) ?? {}, ["name", "tag"]))
      .filter((item): item is string => Boolean(item))
      .map((item) => item.trim())
      .filter(Boolean);
    if (values.length > 0) return values;
  }
  return [];
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

const CHANNEL_ALIASES: Record<string, string> = {
  whatsapp: "whatsapp",
  whatsapp_business: "whatsapp",
  fb: "fb",
  facebook: "fb",
  messenger: "fb",
  facebook_messenger: "fb",
  fb_messenger: "fb",
  meta_messenger: "fb",
  ig: "ig",
  instagram: "ig",
  instagram_dm: "ig",
  instagram_direct: "ig",
};

function normalizeChannel(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return CHANNEL_ALIASES[normalized];
}

function extractChannel(payload: JsonObject): string | undefined {
  const candidates = [
    "channel",
    "message.channel",
    "conversation.channel",
    "messageType",
    "message.messageType",
    "conversation.messageType",
    "data.messageType",
    "data.message.messageType",
    "data.channel",
    "data.message.channel",
    "data.message.channelType",
    "data.conversation.channel",
    "data.conversation.channelType",
    "data.conversation.type",
    "data.conversation.provider",
    "conversationProvider",
    "conversation.provider",
    "conversation.providerType",
    "conversation.integrationType",
    "message.channelType",
    "message.type",
    "message.provider",
    "message.source",
    "source",
    "platform",
    "provider",
    "conversation.source",
  ];
  for (const path of candidates) {
    const rawValue = stringAt(payload, [path]);
    if (!rawValue) continue;
    const canonical = normalizeChannel(rawValue);
    if (canonical) return canonical;
  }
  const ctwa = extractCtwaAttribution(payload);
  if (ctwa.ctwaClid || ctwa.sourceId) return "whatsapp";
  return undefined;
}

function isInbound(payload: JsonObject, eventType: string): boolean {
  const direction = stringAt(payload, ["direction", "message.direction"])?.toLowerCase();
  if (direction) return direction === "inbound" || direction === "incoming" || direction === "received";
  return /inbound|incoming|received|message\.created|message_created/.test(eventType.toLowerCase());
}

function extractContactId(payload: JsonObject, message: JsonObject): string | undefined {
  return stringAt(payload, ["contactId", "contact_id", "contact.id", "data.contactId", "data.contact_id"])
    ?? stringAt(message, ["contactId", "contact_id", "contact.id"]);
}

function extractConversationId(payload: JsonObject, message: JsonObject): string | undefined {
  return stringAt(payload, [
    "conversationId",
    "conversation_id",
    "conversation.id",
    "data.conversationId",
    "data.conversation_id",
  ]) ?? stringAt(message, ["conversationId", "conversation_id", "conversation.id"]);
}

function extractProviderMessageId(payload: JsonObject, message: JsonObject): string | undefined {
  return stringAt(payload, [
    "messageId",
    "message_id",
    "data.messageId",
    "data.message_id",
    "message.id",
    "data.message.id",
  ]) ?? stringAt(message, ["messageId", "message_id"]);
}

function extractEventContactId(payload: JsonObject, message: JsonObject, eventType: string): string | undefined {
  return extractContactId(payload, message)
    ?? (isContactUpdate(eventType) ? stringAt(payload, ["id", "data.id"]) : undefined);
}

function buildMessage(
  payload: JsonObject,
  externalId: string,
  direction: "inbound" | "outbound",
): InboundMessage | undefined {
  const message = objectAt(payload, ["message", "data.message"]) ?? payload;
  const contact = objectAt(payload, ["contact", "data.contact"]);
  const contactId = extractContactId(payload, message);
  const content = stringAt(message, ["content", "body", "text", "message"]) ?? stringAt(payload, ["content", "body", "text"]);

  if (!contactId || !content) return undefined;

  const conversationId = extractConversationId(payload, message);
  const normalizedContent = content.replace(/\s+/g, " ").trim().toLowerCase();
  const semanticHash = createHash("sha256")
    .update([direction, contactId, conversationId ?? "", normalizedContent].join("|"), "utf8")
    .digest("hex");

  const phone = stringAt(contact ?? {}, ["phone"]);
  const email = stringAt(contact ?? {}, ["email"]);
  const ctwa = extractCtwaAttribution(payload);
  const channel = extractChannel(payload) ?? (direction === "outbound" ? "other" : undefined);
  if (!channel) return undefined;
  const providerMessageId = direction === "outbound"
    ? extractProviderMessageId(payload, message)
    : undefined;

  return {
    externalId,
    ...(providerMessageId ? { providerMessageId } : {}),
    contactId,
    ...(conversationId ? { conversationId } : {}),
    ...(phone ? { phone } : {}),
    ...(email ? { email } : {}),
    ...(ctwa.ctwaClid ? { ctwaClid: ctwa.ctwaClid } : {}),
    ...(ctwa.sourceId ? { ctwaSourceId: ctwa.sourceId } : {}),
    ...((ctwa.ctwaClid || ctwa.sourceId) ? { ctwaCapturedAt: new Date().toISOString() } : {}),
    // GHL InternalComment payloads do not include a transport channel. Keep
    // the persisted value inside the database contract instead of inventing
    // an unsupported channel such as `unknown`.
    channel,
    content,
    semanticHash,
  };
}

function isOutbound(payload: JsonObject, eventType: string): boolean {
  const direction = stringAt(payload, ["direction", "message.direction", "data.message.direction"])?.toLowerCase();
  if (direction) return ["outbound", "outgoing", "sent"].includes(direction);
  return /outbound|outgoing|message[._-]?sent/i.test(eventType);
}

function isContactUpdate(eventType: string): boolean {
  return /contact(?:[._-]?tag)?[._-]?(update|updated)|contacttagupdate/i.test(eventType);
}

const CONTROL_TAGS = new Set(["human_takeover", "desactivar ia", "stop bot", "stop_ai", "veto"]);

function findControlTag(payload: JsonObject): string | undefined {
  const tags = [
    ...stringsAt(payload, ["tags", "contact.tags", "data.tags", "data.contact.tags"]),
    stringAt(payload, ["tag", "tag.name", "data.tag", "data.tag.name"]),
  ].filter((tag): tag is string => Boolean(tag));
  const normalizedTags = tags.map((tag) => tag.toLowerCase());
  // A contact can retain a legacy human_takeover tag while stop_ai is added.
  // Compliance STOP must take precedence over the broader human-control tag.
  const stopAiIndex = normalizedTags.indexOf("stop_ai");
  if (stopAiIndex >= 0) return tags[stopAiIndex];
  return tags.find((tag) => CONTROL_TAGS.has(tag.toLowerCase()));
}

function buildHumanInterruption(payload: JsonObject, eventType: string, externalId: string): HumanInterruption | undefined {
  const message = objectAt(payload, ["message", "data.message"]) ?? payload;
  const contactId = extractEventContactId(payload, message, eventType);
  if (!contactId) return undefined;
  const conversationId = extractConversationId(payload, message);

  if (isOutbound(payload, eventType)) {
    const staffMessage = buildMessage(payload, externalId, "outbound");
    return {
      trigger: "staff_message",
      contactId,
      ...(conversationId ? { conversationId } : {}),
      ...(stringAt(payload, ["sender.id", "senderId", "message.sender.id", "data.sender.id"]) ? {
        ownerId: stringAt(payload, ["sender.id", "senderId", "message.sender.id", "data.sender.id"]),
      } : {}),
      ...(staffMessage ? { staffMessage } : {}),
    };
  }

  if (isContactUpdate(eventType)) {
    const controlTag = findControlTag(payload);
    if (controlTag) {
      return {
        trigger: "control_tag",
        contactId,
        ...(conversationId ? { conversationId } : {}),
        controlTag,
      };
    }
  }

  return undefined;
}

export function parseGhlWebhookPayload(
  payload: unknown,
  rawBody: Buffer,
  signature: string,
): GhlWebhookEvent {
  const object = asObject(payload);
  if (!object) throw new InvalidGhlWebhookError("Webhook payload must be a JSON object");

  const locationId = stringAt(object, ["locationId", "location_id", "location.id", "data.locationId", "data.location_id"]);
  const eventType = stringAt(object, ["eventType", "event_type", "type", "event", "data.eventType"]) ?? "unknown";
  const message = objectAt(object, ["message", "data.message"]) ?? object;
  const contactId = extractEventContactId(object, message, eventType);
  const deliveryId = stringAt(object, [
    "eventId",
    "event_id",
    "webhookId",
    "webhook_id",
    "deliveryId",
    "delivery_id",
    "requestId",
    "request_id",
    "messageId",
    "message_id",
    "message.id",
    "data.eventId",
    "data.event_id",
  ]);

  if (!locationId) throw new InvalidGhlWebhookError("Webhook payload is missing locationId");
  const externalId = deliveryId
    ?? (isContactUpdate(eventType) && contactId
      ? `contact-tag:${contactId}:${createHash("sha256").update(rawBody).digest("hex")}`
      : stringAt(object, ["id"]));
  if (!externalId) throw new InvalidGhlWebhookError("Webhook payload is missing an event or message identifier");
  const conversationId = extractConversationId(object, message);
  const humanInterruption = buildHumanInterruption(object, eventType, externalId);

  return {
    locationId,
    externalId,
    eventType,
    signature,
    rawBody,
    payload: object,
    ...(contactId ? { contactId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...(humanInterruption ? { humanInterruption } : {}),
    inboundMessage: isInbound(object, eventType) ? buildMessage(object, externalId, "inbound") : undefined,
  };
}
