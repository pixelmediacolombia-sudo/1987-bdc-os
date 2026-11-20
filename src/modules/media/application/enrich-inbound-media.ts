import type { MediaUnderstandingPort } from "@/modules/media/application/media-understanding.port";
import type { InboundWebhookEvent, InboundMessage } from "@/modules/webhooks/domain/inbound-webhook-event";
import type { MediaClassification } from "@/modules/media/media";
import type { InboundMediaResolverPort } from "@/modules/media/infrastructure/inbound-media-resolver.port";

export type MediaEnrichmentLogger = {
  info(message: string): void;
  error(message: string): void;
};

const defaultLogger: MediaEnrichmentLogger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

export async function enrichInboundMedia(
  event: InboundWebhookEvent,
  understanding: MediaUnderstandingPort | undefined,
  logger: MediaEnrichmentLogger = defaultLogger,
  resolver?: InboundMediaResolverPort,
): Promise<InboundWebhookEvent> {
  const resolvedEvent = resolver ? await resolver.resolve(event) : event;
  const inbound = resolvedEvent.inboundMessage;
  if (!inbound?.attachments?.length) return resolvedEvent;
  if (!understanding) {
    if (!inbound.attachments.some((attachment) => attachment.kind === "audio")) return resolvedEvent;
    return {
      ...resolvedEvent,
      inboundMessage: {
        ...inbound,
        content: inbound.content.trim() || "Adjunto de audio",
        mediaSignals: { ...inbound.mediaSignals, audioTranscriptionFailed: true },
      },
    };
  }

  const understood: string[] = [];
  let audioTranscriptionFailed = false;
  const imageClassifications: MediaClassification[] = [];
  const imageVehicleCategories: string[] = [];
  for (const attachment of inbound.attachments) {
    try {
      const result = await understanding.understand(attachment);
      if (attachment.kind === "audio") {
        const text = result.text?.replace(/\s+/g, " ").trim();
        if (!text) {
          audioTranscriptionFailed = true;
          continue;
        }
        understood.push(text);
        logger.info(`Meta media understood external=${event.externalId} contact=${inbound.contactId} kind=audio source=${result.source}`);
      } else {
        imageClassifications.push(result.classification ?? "unknown");
        if (result.vehicleCategory?.trim()) imageVehicleCategories.push(result.vehicleCategory.trim().toLowerCase());
        logger.info(`Meta media classified external=${event.externalId} contact=${inbound.contactId} kind=image classification=${result.classification ?? "unknown"} source=${result.source}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : "unknown error";
      logger.error(`Meta media understanding failed external=${event.externalId} contact=${inbound.contactId} kind=${attachment.kind}: ${detail}`);
      if (attachment.kind === "audio") audioTranscriptionFailed = true;
      else imageClassifications.push("unknown");
    }
  }

  const originalContent = inbound.content.trim();
  const content = [
    originalContent && !(understood.length > 0 && /^adjunto de audio$/i.test(originalContent)) ? originalContent : "",
    ...understood,
  ].filter(Boolean).join("\n") || (audioTranscriptionFailed ? "Adjunto de audio" : "");
  const enrichedMessage: InboundMessage = {
    ...inbound,
    content,
    mediaSignals: {
      ...(audioTranscriptionFailed ? { audioTranscriptionFailed: true } : {}),
      ...(imageClassifications.length > 0 ? { imageClassifications } : {}),
      ...(imageVehicleCategories.length > 0 ? { imageVehicleCategories } : {}),
    },
  };
  return { ...resolvedEvent, inboundMessage: enrichedMessage };
}
