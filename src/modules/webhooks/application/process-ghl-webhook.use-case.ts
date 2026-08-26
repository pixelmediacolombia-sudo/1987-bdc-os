import type {
  WebhookRepository,
  WebhookStage,
} from "@/modules/webhooks/application/ports/webhook-repository.port";
import type { BurstBufferPort } from "@/modules/control/application/ports/burst-buffer.port";
import type { HumanSuppressionPort } from "@/modules/control/application/ports/human-suppression.port";
import type { PolicyEvaluatorPort } from "@/modules/decisions/application/policy-evaluation.service";
import { parseGhlWebhookPayload } from "@/modules/webhooks/domain/ghl-webhook.parser";
import { enrichInboundMedia } from "@/modules/media/application/enrich-inbound-media";
import type { MediaUnderstandingPort } from "@/modules/media/application/media-understanding.port";

export type WebhookProcessLogger = {
  info(message: string): void;
  error(message: string): void;
};

const defaultLogger: WebhookProcessLogger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

export class ProcessGHLWebhookUseCase {
  constructor(
    private readonly repository: WebhookRepository,
    private readonly burstBuffer?: BurstBufferPort,
    private readonly humanSuppression?: HumanSuppressionPort,
    private readonly policyEvaluator?: PolicyEvaluatorPort,
    private readonly logger: WebhookProcessLogger = defaultLogger,
    private readonly mediaUnderstanding?: MediaUnderstandingPort,
  ) {}

  async execute(input: {
    payload: unknown;
    rawBody: Buffer;
    signature: string;
  }): Promise<{ duplicate: boolean; tenantId: string; externalId: string }> {
    const parsedEvent = parseGhlWebhookPayload(input.payload, input.rawBody, input.signature);
    const event = await enrichInboundMedia(parsedEvent, this.mediaUnderstanding, this.logger);
    if (!event.inboundMessage && isInboundEventType(event.eventType)) {
      this.logger.info(`GHL inbound ignored unsupported or incomplete channel external=${event.externalId} event=${event.eventType}`);
    }
    const result = await this.repository.process(event);
    const controlTag = event.humanInterruption?.controlTag?.trim().toLowerCase();

    if (
      result.stage &&
      this.repository.claimStage &&
      this.repository.completeStage &&
      this.repository.releaseStage
    ) {
      await this.processRecoverableStages(event, result.tenantId, result.stage, result.suppressAi, controlTag);
      return {
        duplicate: result.duplicate,
        tenantId: result.tenantId,
        externalId: event.externalId,
      };
    }

    if (!result.duplicate && controlTag === "stop_ai" && event.contactId && this.policyEvaluator) {
      await this.policyEvaluator.evaluateForContact({
        tenantId: result.tenantId,
        ghlContactId: event.contactId,
        externalId: event.externalId,
        controlTag,
        source: "ghl-stop-ai",
      });
    }
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

  private async processRecoverableStages(
    event: ReturnType<typeof parseGhlWebhookPayload>,
    tenantId: string,
    initialStage: WebhookStage,
    suppressAi: boolean | undefined,
    controlTag: string | undefined,
  ): Promise<void> {
    let stage = initialStage;
    const requiresPolicy = controlTag === "stop_ai" && Boolean(event.contactId);

    if (stage === "received") {
      const claim = await this.repository.claimStage!({
        tenantId,
        externalId: event.externalId,
        stage,
      });
      if (!claim) {
        this.logger.info(`GHL webhook buffer stage already claimed tenant=${tenantId} external=${event.externalId}`);
        return;
      }

      try {
        if (!event.inboundMessage) {
          this.logger.info(`GHL webhook received stage completed without inbound message tenant=${tenantId} external=${event.externalId}`);
        } else {
          if (!this.burstBuffer) throw new Error("Burst buffer is unavailable");
          await this.burstBuffer.add(event.inboundMessage, tenantId);
          this.logger.info(`GHL webhook handed to burst buffer tenant=${tenantId} contact=${event.inboundMessage.contactId} external=${event.externalId}`);
        }
        await this.repository.completeStage!(claim, "processed");
      } catch (error) {
        await this.repository.releaseStage!(claim).catch(() => undefined);
        const detail = error instanceof Error ? error.message : "unknown error";
        this.logger.error(`GHL webhook buffer handoff failed tenant=${tenantId} external=${event.externalId}: ${detail}`);
        throw error;
      }
      return;
    }

    if (requiresPolicy && stage === "policy_pending") {
      const claim = await this.repository.claimStage!({
        tenantId,
        externalId: event.externalId,
        stage,
      });
      if (!claim) return;

      try {
        if (!this.policyEvaluator) throw new Error("STOP policy evaluator is unavailable");
        await this.policyEvaluator.evaluateForContact({
          tenantId,
          ghlContactId: event.contactId!,
          externalId: event.externalId,
          controlTag,
          source: "ghl-stop-ai",
        });
        await this.repository.completeStage!(claim, "policy_applied");
        stage = "policy_applied";
      } catch (error) {
        await this.repository.releaseStage!(claim).catch(() => undefined);
        throw error;
      }
    }

    if (stage === "policy_pending") return;

    if (suppressAi && event.humanInterruption && stage === "policy_applied") {
      const claim = await this.repository.claimStage!({
        tenantId,
        externalId: event.externalId,
        stage,
      });
      if (!claim) return;

      try {
        if (!this.humanSuppression) throw new Error("Human suppression service is unavailable");
        await this.humanSuppression.suppress({
          tenantId,
          contactId: event.humanInterruption.contactId,
          trigger: event.humanInterruption.trigger,
        });
        await this.repository.completeStage!(claim, "suppression_applied");
        stage = "suppression_applied";
      } catch (error) {
        await this.repository.releaseStage!(claim).catch(() => undefined);
        throw error;
      }
    }

    if (stage === "policy_applied" || stage === "suppression_applied") {
      const claim = await this.repository.claimStage!({
        tenantId,
        externalId: event.externalId,
        stage,
      });
      if (!claim) return;
      await this.repository.completeStage!(claim, "processed");
    }
  }
}

function isInboundEventType(eventType: string): boolean {
  return /inbound|incoming|received|message[._-]?(created|received)/i.test(eventType);
}
