import type { OutboundMessageRegistryPort } from "@/modules/control/application/ports/outbound-message-registry.port";
import type {
  OutboundMessageProviderPort,
  OutboundMessageRequest,
  ProviderOutboundMessage,
} from "@/modules/control/application/ports/outbound-message-sender.port";

export class RegisteredOutboundMessageSender {
  constructor(
    private readonly registry: OutboundMessageRegistryPort,
    private readonly provider: OutboundMessageProviderPort,
  ) {}

  async send(input: OutboundMessageRequest): Promise<ProviderOutboundMessage> {
    // Reserve the semantic message before the provider call. This is the
    // correlation boundary used to distinguish our outbound event from staff.
    await this.registry.register(input);
    const result = await this.provider.send(input);
    if (!result.providerMessageId.trim()) throw new Error("Outbound provider returned an empty message id");
    await this.registry.attachProviderMessageId({
      tenantId: input.tenantId,
      contactId: input.contactId,
      semanticHash: input.semanticHash,
      providerMessageId: result.providerMessageId,
    });
    return result;
  }
}
