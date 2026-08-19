import type { InboundMessage } from "@/modules/webhooks/domain/ghl-webhook-event";

export interface BurstBufferPort {
  add(message: InboundMessage, tenantId: string): Promise<void>;
}
