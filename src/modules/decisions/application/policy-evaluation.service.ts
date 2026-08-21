import type { DecisionLogRepositoryPort } from "@/modules/decisions/application/ports/decision-log-repository.port";
import type { PolicyContextRepositoryPort } from "@/modules/decisions/application/ports/policy-context-repository.port";
import { PolicyEngine, type PolicyDecision, type PolicyEvaluationOverrides } from "@/modules/decisions/application/policy-engine";

export type PolicyEvaluationRequest = PolicyEvaluationOverrides & {
  tenantId: string;
  ghlContactId: string;
  source: "ghl-stop-ai" | "diagnostic";
};

export type LoggedPolicyDecision = PolicyDecision & {
  decisionLoggedSuccessfully: true;
  rlsEnforced: true;
};

export interface PolicyEvaluatorPort {
  evaluateForContact(input: PolicyEvaluationRequest): Promise<LoggedPolicyDecision>;
}

export class PolicyEvaluationService implements PolicyEvaluatorPort {
  constructor(
    private readonly contextRepository: PolicyContextRepositoryPort,
    private readonly engine: PolicyEngine,
    private readonly decisionLogRepository: DecisionLogRepositoryPort,
  ) {}

  async evaluateForContact(input: PolicyEvaluationRequest): Promise<LoggedPolicyDecision> {
    const context = await this.contextRepository.load(input.tenantId, input.ghlContactId);
    const decision = this.engine.evaluate(context, input);
    await this.decisionLogRepository.append({
      tenantId: context.tenant.id,
      contactId: context.contact.id,
      inputVersion: context.tenant.policies.version,
      decision,
      modelTrace: {
        engine: "deterministic-policy-v1",
        source: input.source,
        llmInvoked: false,
      },
    });
    return { ...decision, decisionLoggedSuccessfully: true, rlsEnforced: true };
  }
}
