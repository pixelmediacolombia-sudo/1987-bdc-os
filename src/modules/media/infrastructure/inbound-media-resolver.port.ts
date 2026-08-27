import type { GhlWebhookEvent } from "@/modules/webhooks/domain/ghl-webhook-event";

export interface InboundMediaResolverPort {
  resolve(event: GhlWebhookEvent): Promise<GhlWebhookEvent>;
}
