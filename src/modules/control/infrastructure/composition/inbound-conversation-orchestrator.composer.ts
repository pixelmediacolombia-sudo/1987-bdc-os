import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import type { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import type { SofiaStateRepositoryPort } from "@/modules/control/application/ports/sofia-state-repository.port";
import { SofiaConversationEngine } from "@/modules/decisions/domain/sofia-conversation";
import type { QuestionLedgerService } from "@/modules/decisions/application/QuestionLedgerService";

export type InboundConversationOrchestratorComposition = {
  hydrator: ConversationHydrator;
  qualificationFlowEnabled: boolean;
  qualificationFlow?: QualificationFlowService;
  sofiaEnabled?: boolean;
  sofiaRepository?: SofiaStateRepositoryPort;
  sofiaDealerName?: string;
  qualificationLedger?: QuestionLedgerService;
};

/** Keeps the outbound qualification path fail-closed behind its feature flag. */
export function createInboundConversationOrchestrator(
  input: InboundConversationOrchestratorComposition,
): HydratingInboundConversationOrchestrator {
  if (input.qualificationFlowEnabled && !input.qualificationFlow) {
    throw new Error("QUALIFICATION_FLOW_ENABLED requires QualificationFlowService composition");
  }
  if (input.sofiaEnabled && !input.sofiaRepository) throw new Error("SOFIA_ENABLED requires Sofia state repository composition");

  return new HydratingInboundConversationOrchestrator(
    input.hydrator,
    input.qualificationFlowEnabled ? input.qualificationFlow : undefined,
    input.sofiaEnabled && input.sofiaRepository
      ? { engine: new SofiaConversationEngine(), repository: input.sofiaRepository, dealerName: input.sofiaDealerName ?? "el dealer" }
      : undefined,
    input.qualificationLedger,
  );
}
