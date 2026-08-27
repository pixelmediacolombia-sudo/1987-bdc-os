import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import axios from "axios";
import type { GhlApiClient } from "@/features/ghl-oauth/infrastructure/ghl/ghl-api.client";
import type { TenantLocationRouteRepository } from "@/features/ghl-oauth/application/ports/tenant-location-route.port";
import type { GhlWebhookEvent } from "@/modules/webhooks/domain/ghl-webhook-event";
import type { InboundMediaResolverPort } from "@/modules/media/infrastructure/inbound-media-resolver.port";

type ResolverLogger = {
  info(message: string): void;
  error(message: string): void;
};

const defaultLogger: ResolverLogger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

/** Resolves GHL audio webhooks whose recording is exposed by message id. */
export class GhlInboundMediaResolver implements InboundMediaResolverPort {
  constructor(
    private readonly apiClient: GhlApiClient,
    private readonly routeRepository: TenantLocationRouteRepository,
    private readonly logger: ResolverLogger = defaultLogger,
  ) {}

  async resolve(event: GhlWebhookEvent): Promise<GhlWebhookEvent> {
    const inbound = event.inboundMessage;
    if (!inbound || inbound.content.trim() || inbound.attachments?.length || !inbound.providerMessageId) return event;

    const tenantId = await this.routeRepository.resolveTenantId(event.locationId);
    if (!tenantId) return { ...event, inboundMessage: undefined };

    try {
      const response = await this.apiClient.request<ArrayBuffer>(tenantId, {
        method: "GET",
        url: `https://services.leadconnectorhq.com/conversations/messages/${encodeURIComponent(inbound.providerMessageId)}/locations/${encodeURIComponent(event.locationId)}/recording`,
        headers: { Accept: "audio/*, application/octet-stream" },
        responseType: "arraybuffer",
      });
      const contentType = typeof response.headers["content-type"] === "string"
        ? response.headers["content-type"].split(";", 1)[0]?.trim()
        : undefined;
      const extension = extensionForContentType(contentType) ?? ".audio";
      const directory = await mkdtemp(join(tmpdir(), "bdc-ghl-media-"));
      const filename = `${createHash("sha256").update(inbound.providerMessageId).digest("hex")}${extension}`;
      const localPath = join(directory, filename);
      await writeFile(localPath, Buffer.from(response.data));
      this.logger.info(`GHL recording resolved external=${event.externalId} contact=${inbound.contactId} kind=audio`);
      return {
        ...event,
        inboundMessage: {
          ...inbound,
          content: "Adjunto de audio",
          attachments: [{ kind: "audio", ...(contentType ? { mimeType: contentType } : {}), localPath }],
        },
      };
    } catch (error) {
      const detail = axios.isAxiosError(error) ? `status_${error.response?.status ?? "unknown"}` : "recording_unavailable";
      this.logger.info(`GHL recording unavailable external=${event.externalId} contact=${inbound.contactId} reason=${detail}`);
      return { ...event, inboundMessage: undefined };
    }
  }
}

function extensionForContentType(contentType: string | undefined): string | undefined {
  if (!contentType) return undefined;
  if (contentType.includes("ogg")) return ".ogg";
  if (contentType.includes("mpeg") || contentType.includes("mp3")) return ".mp3";
  if (contentType.includes("wav")) return ".wav";
  if (contentType.includes("webm")) return ".webm";
  if (contentType.includes("mp4") || contentType.includes("m4a")) return ".m4a";
  return undefined;
}
