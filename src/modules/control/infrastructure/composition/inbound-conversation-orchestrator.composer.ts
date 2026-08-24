import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import type { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";

export type InboundConversationOrchestratorComposition = {
  hydrator: ConversationHydrator;
  qualificationFlowEnabled: boolean;
  qualificationFlow?: QualificationFlowService;
};

/** Keeps the outbound qualification path fail-closed behind its feature flag. */
export function createInboundConversationOrchestrator(
  input: InboundConversationOrchestratorComposition,
): HydratingInboundConversationOrchestrator {
  if (input.qualificationFlowEnabled && !input.qualificationFlow) {
    throw new Error("QUALIFICATION_FLOW_ENABLED requires QualificationFlowService composition");
  }

  return new HydratingInboundConversationOrchestrator(
    input.hydrator,
    input.qualificationFlowEnabled ? input.qualificationFlow : undefined,
  );
}
