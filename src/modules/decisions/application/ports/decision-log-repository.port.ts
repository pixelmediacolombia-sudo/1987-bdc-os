import type { PolicyDecision } from "@/modules/decisions/application/policy-engine";

export type DecisionLogInput = {
  tenantId: string;
  contactId: string;
  inputVersion: string;
  decision: PolicyDecision;
  modelTrace: Record<string, unknown>;
};

export interface DecisionLogRepositoryPort {
  append(input: DecisionLogInput): Promise<{ rlsEnforced: true }>;
}
