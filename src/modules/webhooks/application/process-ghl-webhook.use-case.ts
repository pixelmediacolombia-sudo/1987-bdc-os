import type { WebhookRepository } from "@/modules/webhooks/application/ports/webhook-repository.port";
import type { BurstBufferPort } from "@/modules/control/application/ports/burst-buffer.port";
import { parseGhlWebhookPayload } from "@/modules/webhooks/domain/ghl-webhook.parser";

export class ProcessGHLWebhookUseCase {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly burstBuffer?: BurstBufferPort,
  ) {}

  async execute(input: {
    payload: unknown;
    rawBody: Buffer;
    signature: string;
  }): Promise<{ duplicate: boolean; tenantId: string; externalId: string }> {
    const event = parseGhlWebhookPayload(input.payload, input.rawBody, input.signature);
    const result = await this.repository.process(event);
    if (!result.duplicate && event.inboundMessage && this.burstBuffer) {
      await this.burstBuffer.add(event.inboundMessage, result.tenantId);
    }
    return {
      duplicate: result.duplicate,
      tenantId: result.tenantId,
      externalId: event.externalId,
    };
  }
}
