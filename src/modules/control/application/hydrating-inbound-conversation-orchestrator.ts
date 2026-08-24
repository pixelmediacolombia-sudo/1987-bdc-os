import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import type { ConsolidatedInboundConversation, InboundConversationOrchestratorPort } from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";
import { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import type { SofiaStateRepositoryPort } from "@/modules/control/application/ports/sofia-state-repository.port";
import { SofiaConversationEngine, type SofiaFacts } from "@/modules/decisions/domain/sofia-conversation";

/**
 * Hydrates the current tenant/contact truth without sending messages or
 * invoking external actions. The outbound orchestrator remains disabled.
 */
export class HydratingInboundConversationOrchestrator implements InboundConversationOrchestratorPort {
  constructor(
    private readonly hydrator: ConversationHydrator,
    private readonly qualificationFlow?: QualificationFlowService,
    private readonly sofia?: { engine: SofiaConversationEngine; repository: SofiaStateRepositoryPort; dealerName: string },
  ) {}

  async process(input: ConsolidatedInboundConversation): Promise<void> {
    const context = await this.hydrator.hydrate(input.tenantId, input.contactId);
    if (context.conversation.state === "paused") return;

    if (this.sofia) {
      const previous = await this.sofia.repository.load(input.tenantId, input.contactId);
      const result = this.sofia.engine.processTurn({
        dealerName: this.sofia.dealerName,
        latestMessage: input.consolidatedText,
        priorFacts: {
          ...factsFromContext(context.activeFacts),
          ...(previous?.facts ?? {}),
        },
        turnCount: (previous?.turnCount ?? 0) + 1,
      });
      await this.sofia.repository.save(input.tenantId, input.contactId, {
        turnCount: (previous?.turnCount ?? 0) + 1,
        facts: result.facts,
        leadLevel: result.leadLevel,
        ...(result.facts.push_accepted === undefined ? {} : { pushAccepted: result.facts.push_accepted }),
        ...(result.facts.has_trade_in === undefined ? {} : { hasTradeIn: result.facts.has_trade_in }),
        hardRuleFailure: result.hardRuleFailure,
        ...(result.response ? { lastResponse: result.response } : {}),
      });
      // Sofia is deliberately persistence-only in this phase. A response is
      // planned by the domain engine, but no provider is called from here.
    }

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

function factsFromContext(activeFacts: Record<string, string>): SofiaFacts {
  const facts: SofiaFacts = {};
  for (const [key, value] of Object.entries(activeFacts)) {
    if (key === "down_payment_declared" || key === "down_payment_accepted" || key === "employment_months") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) facts[key] = parsed;
    } else if (key === "push_accepted" || key === "has_trade_in" || key === "first_time_buyer" || key === "has_income_proof" || key === "trade_in_financed") {
      if (value === "true" || value === "false") facts[key] = value === "true";
    } else if (key in factsFromContextKeys()) {
      facts[key as keyof SofiaFacts] = value as never;
    }
  }
  return facts;
}

function factsFromContextKeys(): Record<string, true> {
  return {
    vehicle_category: true,
    vehicle_model_interest: true,
    trade_in_description: true,
    contact_channel: true,
    contact_value: true,
    trade_in_financed: true,
  };
}
