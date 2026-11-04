import type {
  LoggedPolicyDecision,
  PolicyEvaluatorPort,
} from "@/modules/decisions/application/policy-evaluation.service";
import type { NextBestAction } from "@/modules/decisions/domain/next-best-action";
import {
  OutboundMessageRejectedError,
  RegisteredOutboundMessageSender,
} from "@/modules/control/application/registered-outbound-message-sender";
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

  /** Internal CRM assignment is authorized independently from customer messaging. */
  authorizeHandoff(input: {
    tenantId: string;
    contactId: string;
    externalId?: string;
  }): Promise<LoggedPolicyDecision> {
    return this.policyEvaluator.evaluateForContact({
      tenantId: input.tenantId,
      ghlContactId: input.contactId,
      ...(input.externalId ? { externalId: input.externalId } : {}),
      source: "qualification-flow",
    });
  }

  async sendCandidate(input: OutboundMessageRequest): Promise<ProviderOutboundMessage> {
    return this.sendAuthorizedReply(input);
  }

  async sendSofiaResponse(input: OutboundMessageRequest): Promise<ProviderOutboundMessage> {
    return this.sendAuthorizedReply(input);
  }

  private async sendAuthorizedReply(input: OutboundMessageRequest): Promise<ProviderOutboundMessage> {
    const decision = await this.policyEvaluator.evaluateForContact({
      tenantId: input.tenantId,
      ghlContactId: input.contactId,
      requestedAction: "REPLY",
      ...(input.externalId ? { externalId: input.externalId } : {}),
      source: "qualification-flow",
    });
    if (decision.replyBlocked || !decision.allowedActions?.includes("REPLY")) {
      const action = decision.selectedAction === "HANDOFF" ? "HANDOFF" : "WAIT";
      throw new OutboundMessageRejectedError(action, `Final outbound policy blocked Sofia response: ${decision.reason}`);
    }
    return this.outboundSender.send(input);
  }
}
