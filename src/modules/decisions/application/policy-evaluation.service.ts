import type { DecisionLogRepositoryPort } from "@/modules/decisions/application/ports/decision-log-repository.port";
import type { PolicyContextRepositoryPort } from "@/modules/decisions/application/ports/policy-context-repository.port";
import { PolicyEngine, type PolicyDecision, type PolicyEvaluationOverrides } from "@/modules/decisions/application/policy-engine";
import { QuestionLedgerService } from "@/modules/decisions/application/QuestionLedgerService";

export type PolicyEvaluationRequest = PolicyEvaluationOverrides & {
  tenantId: string;
  ghlContactId: string;
  externalId?: string;
  source: "ghl-stop-ai" | "diagnostic" | "qualification-flow";
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
    private readonly questionLedger?: QuestionLedgerService,
  ) {}

  async evaluateForContact(input: PolicyEvaluationRequest): Promise<LoggedPolicyDecision> {
    const context = await this.contextRepository.load(input.tenantId, input.ghlContactId);
    const baseDecision = this.engine.evaluate(context, input);
    const decision = await this.applyObjectiveGuard(baseDecision, input);
    await this.decisionLogRepository.append({
      tenantId: context.tenant.id,
      contactId: context.contact.id,
      externalId: input.externalId,
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

  private async applyObjectiveGuard(
    decision: PolicyDecision,
    input: PolicyEvaluationRequest,
  ): Promise<PolicyDecision> {
    if (!input.requestedAction) return decision;
    if (!input.objectiveType) throw new Error("objectiveType is required when requestedAction is provided");
    if (!this.questionLedger) throw new Error("Question ledger is unavailable for objective validation");
    if (decision.selectedAction === "STOP") return decision;

    const state = await this.questionLedger.checkObjectiveState(
      input.tenantId,
      input.ghlContactId,
      input.objectiveType,
    );
    const fallbackAction = decision.gate === "FINANCIAL" ? "HANDOFF" : "WAIT";
    const guarded = this.questionLedger.guardAction(state, input.requestedAction, fallbackAction);
    const allowedActions = decision.allowedActions.filter((action) => action !== input.requestedAction);
    if (!allowedActions.includes(guarded.action)) allowedActions.push(guarded.action);

    return {
      ...decision,
      allowedActions,
      selectedAction: guarded.action,
      reason: `${decision.reason}; ${guarded.reason}`,
    };
  }
}
