import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import type { ConsolidatedInboundConversation, InboundConversationOrchestratorPort } from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";
import { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";

/**
 * Hydrates the current tenant/contact truth without sending messages or
 * invoking external actions. The outbound orchestrator remains disabled.
 */
export class HydratingInboundConversationOrchestrator implements InboundConversationOrchestratorPort {
  constructor(
    private readonly hydrator: ConversationHydrator,
    private readonly qualificationFlow?: QualificationFlowService,
  ) {}

  async process(input: ConsolidatedInboundConversation): Promise<void> {
    const context = await this.hydrator.hydrate(input.tenantId, input.contactId);
    if (context.conversation.state === "paused") return;

    // The webhook/buffer path can provide a selected action and candidate once
    // the qualification layer has produced them. Both safeguards remain in
    // this application boundary before any provider call is possible.
    if (this.qualificationFlow && input.objectiveType && input.requestedAction) {
      const decision = await this.qualificationFlow.evaluateObjective({
        tenantId: input.tenantId,
        contactId: input.contactId,
        objectiveType: input.objectiveType,
        requestedAction: input.requestedAction,
        externalId: input.messages.at(-1)?.externalId,
      });
      if (input.outboundCandidate && decision.selectedAction === input.requestedAction) {
        await this.qualificationFlow.sendCandidate({
          tenantId: input.tenantId,
          contactId: input.contactId,
          content: input.outboundCandidate.content,
          semanticHash: input.outboundCandidate.semanticHash,
          channel: input.outboundCandidate.channel,
          externalId: input.messages.at(-1)?.externalId,
        });
      }
    }
  }
}
