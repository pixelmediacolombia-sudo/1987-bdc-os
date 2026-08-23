import type { OutboundMessageRegistryPort } from "@/modules/control/application/ports/outbound-message-registry.port";
import type {
  SemanticRepetitionGuard,
  SemanticRepetitionValidationInput,
} from "@/modules/control/application/SemanticRepetitionValidator";
import type {
  OutboundMessageProviderPort,
  OutboundMessageRequest,
  ProviderOutboundMessage,
} from "@/modules/control/application/ports/outbound-message-sender.port";

export class RegisteredOutboundMessageSender {
  constructor(
    private readonly registry: OutboundMessageRegistryPort,
    private readonly provider: OutboundMessageProviderPort,
    private readonly repetitionGuard?: SemanticRepetitionGuard,
  ) {}

  async send(input: OutboundMessageRequest): Promise<ProviderOutboundMessage> {
    if (this.repetitionGuard) {
      const validationInput: SemanticRepetitionValidationInput = {
        tenantId: input.tenantId,
        contactId: input.contactId,
        content: input.content,
      };
      const validation = await this.repetitionGuard.validate(validationInput);
      if (!validation.accepted) {
        const action = validation.action === "HANDOFF" ? "HANDOFF" : "WAIT";
        throw new OutboundMessageRejectedError(action, validation.reason);
      }
    }
    // Reserve this attempt before the provider call. semanticHash is only
    // correlation metadata; repeated text must create independent attempts.
    const reservation = await this.registry.register(input);
    let result: ProviderOutboundMessage;
    try {
      result = await this.provider.send(input);
      if (!result.providerMessageId.trim()) {
        throw new Error("Outbound provider returned an empty message id");
      }
    } catch (error) {
      await this.registry.markFailed({
        tenantId: input.tenantId,
        attemptId: reservation.attemptId,
      }).catch(() => undefined);
      throw error;
    }

    await this.registry.attachProviderMessageId({
      tenantId: input.tenantId,
      attemptId: reservation.attemptId,
      providerMessageId: result.providerMessageId,
    });
    return result;
  }
}

export class OutboundMessageRejectedError extends Error {
  constructor(
    public readonly action: "WAIT" | "HANDOFF",
    reason: string,
  ) {
    super(`Outbound message rejected; action=${action}: ${reason}`);
    this.name = "OutboundMessageRejectedError";
  }
}
