import type { InboundWebhookEvent } from "@/modules/webhooks/domain/inbound-webhook-event";

export interface InboundMediaResolverPort {
  resolve(event: InboundWebhookEvent): Promise<InboundWebhookEvent>;
}
