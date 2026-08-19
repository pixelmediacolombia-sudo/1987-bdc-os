import type {
  ConsolidatedInboundConversation,
  InboundConversationOrchestratorPort,
} from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";

/**
 * Ticket 4 only prepares a consolidated inbound turn. Real messaging and
 * downstream actions remain disabled until the controlled pilot authorizes them.
 */
export class DisabledInboundConversationOrchestrator implements InboundConversationOrchestratorPort {
  async process(_input: ConsolidatedInboundConversation): Promise<void> {
    return Promise.resolve();
  }
}
