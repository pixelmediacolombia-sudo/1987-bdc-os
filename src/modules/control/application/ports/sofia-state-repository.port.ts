import type { SofiaFacts, SofiaLeadLevel } from "@/modules/decisions/domain/sofia-conversation";

export type SofiaConversationState = {
  turnCount: number;
  facts: SofiaFacts;
  leadLevel: SofiaLeadLevel;
  pushAccepted?: boolean;
  hasTradeIn?: boolean;
  hardRuleFailure: boolean;
};

export interface SofiaStateRepositoryPort {
  load(tenantId: string, contactId: string): Promise<SofiaConversationState | undefined>;
  save(tenantId: string, contactId: string, state: SofiaConversationState): Promise<void>;
}
