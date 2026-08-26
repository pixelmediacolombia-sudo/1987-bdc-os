import type { MediaUnderstandingPort } from "@/modules/media/application/media-understanding.port";
import type { GhlWebhookEvent, InboundMessage } from "@/modules/webhooks/domain/ghl-webhook-event";

export type MediaEnrichmentLogger = {
  info(message: string): void;
  error(message: string): void;
};

const defaultLogger: MediaEnrichmentLogger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

export async function enrichInboundMedia(
  event: GhlWebhookEvent,
  understanding: MediaUnderstandingPort | undefined,
  logger: MediaEnrichmentLogger = defaultLogger,
): Promise<GhlWebhookEvent> {
  const inbound = event.inboundMessage;
  if (!inbound?.attachments?.length || !understanding) return event;

  const understood: string[] = [];
  for (const attachment of inbound.attachments) {
    try {
      const result = await understanding.understand(attachment);
      const text = result.text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      understood.push(`${attachment.kind === "audio" ? "Transcripción de audio" : "Lectura de imagen"}: ${text}`);
      logger.info(`GHL media understood external=${event.externalId} contact=${inbound.contactId} kind=${attachment.kind} source=${result.source}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      logger.error(`GHL media understanding failed external=${event.externalId} contact=${inbound.contactId} kind=${attachment.kind}: ${detail}`);
    }
  }

  if (understood.length === 0) return event;
  const content = [inbound.content.trim(), ...understood].filter(Boolean).join("\n");
  const enrichedMessage: InboundMessage = { ...inbound, content };
  return { ...event, inboundMessage: enrichedMessage };
}
