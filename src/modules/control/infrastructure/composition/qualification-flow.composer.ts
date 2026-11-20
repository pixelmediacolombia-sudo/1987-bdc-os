import type { Pool } from "pg";
import { SemanticRepetitionValidator } from "@/modules/control/application/SemanticRepetitionValidator";
import { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import { RegisteredOutboundMessageSender } from "@/modules/control/application/registered-outbound-message-sender";
import type { OutboundMessageRegistryPort } from "@/modules/control/application/ports/outbound-message-registry.port";
import type { PolicyEvaluatorPort } from "@/modules/decisions/application/policy-evaluation.service";
import type { OutboundMessageProviderPort } from "@/modules/control/application/ports/outbound-message-sender.port";

export type QualificationFlowCompositionDependencies = {
  pool: Pool;
  outboundProvider: OutboundMessageProviderPort;
  outboundRegistry: OutboundMessageRegistryPort;
  policyEvaluator: PolicyEvaluatorPort;
};

/** Builds the protected Ticket 8 flow without enabling it by itself. */
export function createQualificationFlow(
  dependencies: QualificationFlowCompositionDependencies,
): QualificationFlowService {
  const sender = new RegisteredOutboundMessageSender(
    dependencies.outboundRegistry,
    dependencies.outboundProvider,
    new SemanticRepetitionValidator(dependencies.pool),
  );
  return new QualificationFlowService(dependencies.policyEvaluator, sender);
}
