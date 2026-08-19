import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import type { ConsolidatedInboundConversation, InboundConversationOrchestratorPort } from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";

/**
 * Hydrates the current tenant/contact truth without sending messages or
 * invoking external actions. The outbound orchestrator remains disabled.
 */
export class HydratingInboundConversationOrchestrator implements InboundConversationOrchestratorPort {
  constructor(private readonly hydrator: ConversationHydrator) {}

  async process(input: ConsolidatedInboundConversation): Promise<void> {
    const context = await this.hydrator.hydrate(input.tenantId, input.contactId);
    if (context.conversation.state === "paused") return;
  }
}
