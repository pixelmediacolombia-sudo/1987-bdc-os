import { createHash } from "node:crypto";
import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import type { ConsolidatedInboundConversation, InboundConversationOrchestratorPort } from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";
import { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import type { SofiaStateRepositoryPort } from "@/modules/control/application/ports/sofia-state-repository.port";
import type { OutboundMessageChannel } from "@/modules/control/application/ports/outbound-message-sender.port";
import { SofiaConversationEngine, sofiaPolicyFromPolicyPack, type SofiaFacts } from "@/modules/decisions/domain/sofia-conversation";
import { resolveDealerDisplayName } from "@/modules/decisions/domain/dealer-identity";
import type { QuestionLedgerService } from "@/modules/decisions/application/QuestionLedgerService";
import { OutboundMessageRejectedError } from "@/modules/control/application/registered-outbound-message-sender";
import type { QualificationHandoffPort } from "@/modules/control/application/ports/qualification-handoff.port";

export type SofiaConversationLogger = {
  info(message: string): void;
  error(message: string): void;
};

const defaultLogger: SofiaConversationLogger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

/**
 * Hydrates the current tenant/contact truth and optionally sends the guarded
 * Sofia response when the qualification flow is explicitly enabled.
 */
export class HydratingInboundConversationOrchestrator implements InboundConversationOrchestratorPort {
  constructor(
    private readonly hydrator: ConversationHydrator,
    private readonly qualificationFlow?: QualificationFlowService,
    private readonly sofia?: { engine: SofiaConversationEngine; repository: SofiaStateRepositoryPort; dealerName?: string },
    private readonly qualificationLedger?: QuestionLedgerService,
    private readonly qualificationSignalEnabled = false,
    private readonly logger: SofiaConversationLogger = defaultLogger,
    private readonly qualificationHandoff?: QualificationHandoffPort,
  ) {}

  async process(input: ConsolidatedInboundConversation): Promise<void> {
    const context = await this.hydrator.hydrate(input.tenantId, input.contactId);
    if (context.conversation.state === "paused") {
      this.logger.info(`Sofia inbound skipped tenant=${input.tenantId} contact=${input.contactId} reason=conversation_paused`);
      return;
    }

    // Missing flags fail closed for older test doubles or partially migrated
    // records; the production hydrator always returns all three columns.
    const tenantFlags = context.tenant?.flags ?? {
      sofiaEnabled: false,
      qualificationFlowEnabled: false,
      qualificationSignalEnabled: false,
    };
    const sofiaEnabledForTenant = Boolean(this.sofia && tenantFlags.sofiaEnabled);
    const qualificationFlowEnabledForTenant = Boolean(
      this.qualificationFlow && tenantFlags.qualificationFlowEnabled,
    );
    const qualificationSignalEnabledForTenant =
      this.qualificationSignalEnabled && tenantFlags.qualificationSignalEnabled;

    if (sofiaEnabledForTenant && this.sofia) {
      const dealerName = resolveDealerDisplayName({
        dealerId: context.tenant.id,
        ghlLocationId: context.tenant.ghlLocationId,
      }) ?? this.sofia.dealerName;
      if (!dealerName) {
        this.logger.info(`Sofia inbound skipped dealer=${context.tenant.id} contact=${input.contactId} reason=dealer_not_identified`);
        return;
      }
      const previous = await this.sofia.repository.load(input.tenantId, input.contactId);
      const engine = this.sofia.engine.withPolicy(sofiaPolicyFromPolicyPack(context.tenant.policies));
      const result = engine.processTurn({
        dealerName,
        latestMessage: input.consolidatedText,
        contactChannel: input.messages.at(-1)?.channel,
        language: context.contact.preferredLanguage,
        priorFacts: {
          ...factsFromContext(context.activeFacts),
          ...(previous?.facts ?? {}),
        },
        mediaContext: input.mediaContext,
        turnCount: (previous?.turnCount ?? 0) + 1,
        isFirstTurn: !previous,
        lastResponse: previous?.lastResponse,
      });
      const inboundChannel = input.messages.at(-1)?.channel ?? "missing";
      const handoffEligible =
        this.qualificationHandoff &&
        result.leadLevel === "A" &&
        !result.hardRuleFailure &&
        result.contactCaptured &&
        !previous?.facts.handoff_completed;
      const response = result.response?.trim();
      this.logger.info(
        `Sofia decision tenant=${input.tenantId} contact=${input.contactId} channel=${inboundChannel} turn=${(previous?.turnCount ?? 0) + 1} lead=${result.leadLevel} next=${result.nextStep} response=${response ? "yes" : "no"} flags=sofia:${sofiaEnabledForTenant ? "on" : "off"},qualification:${qualificationFlowEnabledForTenant ? "on" : "off"}`,
      );
      await this.sofia.repository.save(input.tenantId, input.contactId, {
        turnCount: (previous?.turnCount ?? 0) + 1,
        facts: result.facts,
        leadLevel: result.leadLevel,
        ...(result.facts.push_accepted === undefined ? {} : { pushAccepted: result.facts.push_accepted }),
        ...(result.facts.has_trade_in === undefined ? {} : { hasTradeIn: result.facts.has_trade_in }),
        hardRuleFailure: result.hardRuleFailure,
        ...(result.response ? { lastResponse: result.response } : {}),
      });
      if (this.qualificationLedger && result.leadLevel === "A" && !result.hardRuleFailure && result.contactCaptured) {
        await this.qualificationLedger.updateObjectiveState(
          input.tenantId,
          input.contactId,
          "qualification_completed",
          {
            asked: true,
            answered: true,
            qualificationCompleted: true,
            emitQualificationSignal: qualificationSignalEnabledForTenant,
          },
        );
      }
      const outboundChannel = toOutboundChannel(input.messages.at(-1)?.channel);
      if (response && outboundChannel && qualificationFlowEnabledForTenant && this.qualificationFlow) {
        try {
          await this.qualificationFlow.sendSofiaResponse({
            tenantId: input.tenantId,
            contactId: input.contactId,
            content: response,
            semanticHash: createHash("sha256").update(response, "utf8").digest("hex"),
            externalId: input.messages.at(-1)?.externalId,
            channel: outboundChannel,
          });
          this.logger.info(`Sofia outbound sent tenant=${input.tenantId} contact=${input.contactId} channel=${outboundChannel}`);
          if (handoffEligible && this.qualificationHandoff) {
            await this.qualificationHandoff.markQualified({
              tenantId: input.tenantId,
              contactId: input.contactId,
              leadLevel: result.leadLevel === "A" ? "A" : "B",
              stage: "Calificado",
              customerMessage: response,
            });
            await this.sofia.repository.save(input.tenantId, input.contactId, {
              turnCount: (previous?.turnCount ?? 0) + 1,
              facts: { ...result.facts, handoff_completed: true },
              leadLevel: result.leadLevel,
              ...(result.facts.push_accepted === undefined ? {} : { pushAccepted: result.facts.push_accepted }),
              ...(result.facts.has_trade_in === undefined ? {} : { hasTradeIn: result.facts.has_trade_in }),
              hardRuleFailure: result.hardRuleFailure,
              ...(result.response ? { lastResponse: result.response } : {}),
            });
            this.logger.info(`Sofia qualification handoff recorded tenant=${input.tenantId} contact=${input.contactId} stage=Calificado`);
          }
        } catch (error) {
          if (error instanceof OutboundMessageRejectedError) {
            this.logger.info(
              `Sofia outbound suppressed tenant=${input.tenantId} contact=${input.contactId} channel=${outboundChannel} action=${error.action}`,
            );
            return;
          }
          const detail = error instanceof Error ? error.message : "unknown error";
          this.logger.error(`Sofia outbound failed tenant=${input.tenantId} contact=${input.contactId} channel=${outboundChannel}: ${detail}`);
          throw error;
        }
      } else if (response && qualificationFlowEnabledForTenant && this.qualificationFlow && !outboundChannel) {
        this.logger.error(`Sofia outbound skipped unsupported channel tenant=${input.tenantId} contact=${input.contactId} channel=${input.messages.at(-1)?.channel ?? "missing"}`);
      } else if (response && !qualificationFlowEnabledForTenant) {
        this.logger.error(`Sofia outbound blocked tenant=${input.tenantId} contact=${input.contactId} channel=${inboundChannel} reason=qualification_flow_disabled`);
      }
    }

    // The webhook/buffer path can provide a selected action and candidate once
    // the qualification layer has produced them. Both safeguards remain in
    // this application boundary before any provider call is possible.
    if (qualificationFlowEnabledForTenant && this.qualificationFlow && input.objectiveType && input.requestedAction) {
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

function toOutboundChannel(channel: string | undefined): OutboundMessageChannel | undefined {
  const normalized = channel?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const channels: Record<string, OutboundMessageChannel> = {
    whatsapp: "WhatsApp",
    whatsapp_business: "WhatsApp",
    ig: "IG",
    instagram: "IG",
    instagram_dm: "IG",
    instagram_direct: "IG",
    fb: "FB",
    facebook: "FB",
    messenger: "FB",
    facebook_messenger: "FB",
    fb_messenger: "FB",
    meta_messenger: "FB",
  };
  return normalized ? channels[normalized] : undefined;
}

function factsFromContext(activeFacts: Record<string, string>): SofiaFacts {
  const facts: SofiaFacts = {};
  for (const [key, value] of Object.entries(activeFacts)) {
    if (key === "down_payment_declared" || key === "down_payment_accepted" || key === "down_payment_push_target" || key === "employment_months" || key === "vehicle_year" || key === "trade_in_year") {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) facts[key] = parsed;
    } else if (key === "push_accepted" || key === "has_trade_in" || key === "first_time_buyer" || key === "has_income_proof" || key === "has_id_document" || key === "has_income_proof_document" || key === "trade_in_financed" || key === "has_co_signer" || key === "visit_intent" || key === "handoff_completed") {
      if (value === "true" || value === "false") facts[key] = value === "true";
    } else if (key in factsFromContextKeys()) {
      facts[key as keyof SofiaFacts] = value as never;
    }
  }
  return facts;
}

function factsFromContextKeys(): Record<string, true> {
  return {
    contact_name: true,
    vehicle_category: true,
    vehicle_model_interest: true,
    trade_in_model: true,
    vehicle_use: true,
    trade_in_description: true,
    contact_channel: true,
    contact_value: true,
    purchase_timeline: true,
    has_co_signer: true,
    handoff_completed: true,
    trade_in_financed: true,
  };
}
