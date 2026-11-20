import type { InboundWebhookEvent, InboundMessage, HumanInterruption } from "@/modules/webhooks/domain/inbound-webhook-event";

export function testMetaEvent(input: {
  externalId: string;
  contactId?: string;
  conversationId?: string;
  eventType?: string;
  inboundMessage?: Partial<InboundMessage>;
  humanInterruption?: HumanInterruption;
}): InboundWebhookEvent {
  const contactId = input.contactId ?? input.inboundMessage?.contactId ?? input.humanInterruption?.contactId ?? "test-contact";
  const inboundMessage = input.inboundMessage
    ? {
        externalId: input.inboundMessage.externalId ?? input.externalId,
        contactId,
        channel: input.inboundMessage.channel ?? "whatsapp",
        content: input.inboundMessage.content ?? "",
        semanticHash: input.inboundMessage.semanticHash ?? `hash:${input.externalId}`,
        ...input.inboundMessage,
      }
    : undefined;
  return {
    provider: "meta",
    externalId: input.externalId,
    eventType: input.eventType ?? "meta.message.received",
    accountId: "test-meta-account",
    signature: "test-signature",
    rawBody: Buffer.from(input.externalId),
    payload: { object: "page" },
    contactId,
    ...(input.conversationId ? { conversationId: input.conversationId } : {}),
    ...(input.humanInterruption ? { humanInterruption: input.humanInterruption } : {}),
    ...(inboundMessage ? { inboundMessage } : {}),
  };
}
