import { createHash } from "node:crypto";
import type { InboundWebhookEvent, InboundMessage, JsonObject } from "@/modules/webhooks/domain/inbound-webhook-event";
import { extractCtwaAttribution } from "@/modules/webhooks/domain/ctwa-clid";

type MetaObject = Record<string, unknown>;

function object(value: unknown): MetaObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as MetaObject : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function buildMessage(input: {
  accountId: string;
  channel: "fb" | "ig" | "whatsapp";
  senderId: string;
  recipientId: string;
  message: MetaObject;
  rawBody: Buffer;
  signature: string;
  payload: JsonObject;
  timestamp?: number;
}): InboundWebhookEvent {
  const providerMessageId = text(input.message.mid) ?? text(input.message.id);
  const content = text(input.message.text)
    ?? text(object(input.message.image)?.caption)
    ?? text(object(input.message.document)?.caption)
    ?? (Array.isArray(input.message.attachments) ? "Mensaje con adjunto" : "");
  const externalId = providerMessageId
    ?? createHash("sha256").update(input.rawBody).digest("hex");
  const semanticHash = createHash("sha256")
    .update([input.senderId, input.recipientId, content.toLowerCase().replace(/\s+/g, " ")].join("|"))
    .digest("hex");
  const attachments = Array.isArray(input.message.attachments)
    ? input.message.attachments.flatMap((raw): NonNullable<InboundMessage["attachments"]> => {
        const attachment = object(raw);
        const payload = object(attachment?.payload);
        const kind = attachment?.type === "image" ? "image" : attachment?.type === "audio" ? "audio" : undefined;
        const url = text(payload?.url);
        return kind && url ? [{ kind, url, ...(text(payload?.caption) ? { caption: text(payload?.caption) } : {}) }] : [];
      })
    : [];
  const ctwa = extractCtwaAttribution(input.payload);
  const inboundMessage: InboundMessage = {
    externalId,
    ...(providerMessageId ? { providerMessageId } : {}),
    contactId: input.senderId,
    conversationId: `${input.channel}:${input.accountId}:${input.senderId}`,
    channel: input.channel,
    content: content || (attachments.length ? "Mensaje con adjunto" : "").trim(),
    semanticHash,
    ...(attachments.length ? { attachments } : {}),
    ...(ctwa.ctwaClid ? { ctwaClid: ctwa.ctwaClid } : {}),
    ...(ctwa.sourceId ? { ctwaSourceId: ctwa.sourceId } : {}),
    ...((ctwa.ctwaClid || ctwa.sourceId) ? { ctwaCapturedAt: new Date().toISOString() } : {}),
  };
  const isEcho = input.message.is_echo === true;
  const humanInterruption = isEcho ? {
    trigger: "staff_message" as const,
    contactId: input.senderId,
    conversationId: inboundMessage.conversationId,
    staffMessage: { ...inboundMessage, channel: input.channel, content: content || "" },
  } : undefined;

  return {
    provider: "meta",
    accountId: input.accountId,
    externalId,
    eventType: isEcho ? "meta.message.echo" : "meta.message.received",
    signature: input.signature,
    rawBody: input.rawBody,
    payload: input.payload,
    contactId: input.senderId,
    conversationId: inboundMessage.conversationId,
    ...(humanInterruption ? { humanInterruption } : {}),
    ...(!isEcho ? { inboundMessage } : {}),
  };
}

export function parseMetaWebhookPayload(
  payload: unknown,
  rawBody: Buffer,
  signature: string,
): InboundWebhookEvent[] {
  const root = object(payload);
  if (!root || !Array.isArray(root.entry)) throw new Error("Meta webhook payload is missing entries");
  const parsed: InboundWebhookEvent[] = [];
  const objectType = text(root.object);

  for (const rawEntry of root.entry) {
    const entry = object(rawEntry);
    if (!entry) continue;
    const entryId = text(entry.id);
    if (!entryId) continue;
    if (objectType === "page" || objectType === "instagram") {
      const channel = objectType === "instagram" ? "ig" : "fb";
      const messaging = Array.isArray(entry.messaging) ? entry.messaging : [];
      for (const rawEvent of messaging) {
        const event = object(rawEvent);
        const message = object(event?.message);
        const senderId = text(object(event?.sender)?.id);
        const recipientId = text(object(event?.recipient)?.id) ?? entryId;
        if (!event || !message || !senderId) continue;
        parsed.push(buildMessage({ accountId: entryId, channel, senderId, recipientId, message, rawBody, signature, payload: root as JsonObject }));
      }
    } else if (objectType === "whatsapp_business_account") {
      for (const rawChange of Array.isArray(entry.changes) ? entry.changes : []) {
        const value = object(object(rawChange)?.value);
        const accountId = text(object(value?.metadata)?.phone_number_id);
        if (!value || !accountId) continue;
        for (const rawMessage of Array.isArray(value.messages) ? value.messages : []) {
          const message = object(rawMessage);
          const senderId = text(message?.from);
          if (!message || !senderId) continue;
          const normalized: MetaObject = {
            ...message,
            ...(text(object(message.text)?.body) ? { text: text(object(message.text)?.body) } : {}),
            ...(object(message.image) ? { attachments: [{ type: "image", payload: { url: text(object(message.image)?.url), caption: text(object(message.image)?.caption) } }] } : {}),
            ...(object(message.audio) ? { attachments: [{ type: "audio", payload: { url: text(object(message.audio)?.url) } }] } : {}),
          };
          const channelContext = object(value.context);
          const recipientId = text(channelContext?.phone_number_id) ?? accountId;
          const combinedPayload = { ...root, referral: object(message.referral) } as JsonObject;
          parsed.push(buildMessage({ accountId, channel: "whatsapp", senderId, recipientId, message: normalized, rawBody, signature, payload: combinedPayload }));
        }
      }
    }
  }

  return parsed;
}
