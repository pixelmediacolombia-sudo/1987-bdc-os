import type { GhlWebhookEvent } from "@/modules/webhooks/domain/ghl-webhook-event";

export type WebhookProcessResult = {
  duplicate: boolean;
  tenantId: string;
};

export interface WebhookRepository {
  process(event: GhlWebhookEvent): Promise<WebhookProcessResult>;
}
