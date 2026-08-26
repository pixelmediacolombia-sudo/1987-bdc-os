import type {
  LoggedPolicyDecision,
  PolicyEvaluatorPort,
} from "@/modules/decisions/application/policy-evaluation.service";
import type { NextBestAction } from "@/modules/decisions/domain/next-best-action";
import { RegisteredOutboundMessageSender } from "@/modules/control/application/registered-outbound-message-sender";
import type {
  OutboundMessageRequest,
  ProviderOutboundMessage,
} from "@/modules/control/application/ports/outbound-message-sender.port";

export type ObjectiveQualificationInput = {
  tenantId: string;
  contactId: string;
  objectiveType: string;
  requestedAction: NextBestAction;
  externalId?: string;
};

/** Application boundary for objective validation followed by outbound delivery. */
export class QualificationFlowService {
  constructor(
    private readonly policyEvaluator: PolicyEvaluatorPort,
    private readonly outboundSender: RegisteredOutboundMessageSender,
  ) {}

  evaluateObjective(input: ObjectiveQualificationInput): Promise<LoggedPolicyDecision> {
    return this.policyEvaluator.evaluateForContact({
      tenantId: input.tenantId,
      ghlContactId: input.contactId,
      objectiveType: input.objectiveType,
      requestedAction: input.requestedAction,
      ...(input.externalId ? { externalId: input.externalId } : {}),
      source: "qualification-flow",
    });
  }

  sendCandidate(input: OutboundMessageRequest): Promise<ProviderOutboundMessage> {
    return this.outboundSender.send(input);
  }

  sendSofiaResponse(input: OutboundMessageRequest): Promise<ProviderOutboundMessage> {
    return this.outboundSender.send(input);
  }
}
