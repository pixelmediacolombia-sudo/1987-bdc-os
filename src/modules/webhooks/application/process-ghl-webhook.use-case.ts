import type { WebhookRepository } from "@/modules/webhooks/application/ports/webhook-repository.port";
import type { BurstBufferPort } from "@/modules/control/application/ports/burst-buffer.port";
import type { HumanSuppressionPort } from "@/modules/control/application/ports/human-suppression.port";
import { parseGhlWebhookPayload } from "@/modules/webhooks/domain/ghl-webhook.parser";

export class ProcessGHLWebhookUseCase {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly burstBuffer?: BurstBufferPort,
    private readonly humanSuppression?: HumanSuppressionPort,
  ) {}

  async execute(input: {
    payload: unknown;
    rawBody: Buffer;
    signature: string;
  }): Promise<{ duplicate: boolean; tenantId: string; externalId: string }> {
    const event = parseGhlWebhookPayload(input.payload, input.rawBody, input.signature);
    const result = await this.repository.process(event);
    if (!result.duplicate && result.suppressAi !== false && event.humanInterruption && this.humanSuppression) {
      await this.humanSuppression.suppress({
        tenantId: result.tenantId,
        contactId: event.humanInterruption.contactId,
        trigger: event.humanInterruption.trigger,
      });
    }
    if (!result.duplicate && !event.humanInterruption && event.inboundMessage && this.burstBuffer) {
      await this.burstBuffer.add(event.inboundMessage, result.tenantId);
    }
    return {
      duplicate: result.duplicate,
      tenantId: result.tenantId,
      externalId: event.externalId,
    };
  }
}
