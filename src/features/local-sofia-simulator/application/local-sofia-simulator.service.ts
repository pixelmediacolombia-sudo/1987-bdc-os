import { createHash, randomUUID } from "node:crypto";
import type { SofiaConversationState, SofiaStateRepositoryPort } from "@/modules/control/application/ports/sofia-state-repository.port";
import { ConversationAiService } from "@/modules/control/application/conversation-ai.service";
import type { ConversationAiShadowRecord } from "@/modules/control/application/conversation-ai-model-contract";
import { createInboundConversationOrchestrator } from "@/modules/control/infrastructure/composition/inbound-conversation-orchestrator.composer";
import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import type { HydrationRepositoryPort, RecentTranscriptMessage } from "@/modules/memory/application/ports/hydration-repository.port";
import { LocalPolicyPackProvider } from "@/modules/memory/infrastructure/policies/local-policy-pack.provider";
import type { ConversationalModelPort } from "@/modules/control/application/conversation-ai-model-contract";

export type LocalSofiaSimulatorMessage = {
  id: string;
  direction: "inbound" | "outbound";
  content: string;
  createdAt: string;
};

export type LocalSofiaSimulatorTurn = {
  conversationId: string;
  contact: { name: string; providerContactId: string };
  messages: LocalSofiaSimulatorMessage[];
  sofia: {
    response: string;
    facts: SofiaConversationState["facts"];
    leadLevel: SofiaConversationState["leadLevel"];
    nextStep: ConversationAiShadowRecord["requiredAction"];
  };
  openai: {
    status: "ok" | "fallback";
    extraction: ConversationAiShadowRecord["extraction"] | null;
    modelFacts: ConversationAiShadowRecord["modelFacts"];
    safetyIssues: string[];
    responseSource: "deterministic_rule";
  };
};

type LocalConversation = {
  conversationId: string;
  tenantId: string;
  contactId: string;
  providerContactId: string;
  transcript: RecentTranscriptMessage[];
  messages: LocalSofiaSimulatorMessage[];
  sofiaState?: SofiaConversationState;
  aiRecord?: ConversationAiShadowRecord;
  updatedAt: number;
};

const DEALER_NAME = "Dealer de prueba local";
const CONTACT_NAME = "Andrea Demo";
const MAX_CONVERSATIONS = 10;
const EXPIRES_AFTER_MS = 60 * 60 * 1000;

export class LocalSofiaSimulatorService {
  private readonly conversations = new Map<string, LocalConversation>();

  constructor(private readonly model: ConversationalModelPort) {}

  async turn(message: string, conversationId?: string): Promise<LocalSofiaSimulatorTurn> {
    const text = message.trim();
    if (!text || text.length > 2000) throw new Error("Escribe un mensaje de hasta 2000 caracteres.");
    const state = conversationId ? this.getConversation(conversationId) : this.createConversation();
    const createdAt = new Date();
    const inbound: LocalSofiaSimulatorMessage = {
      id: randomUUID(),
      direction: "inbound",
      content: text,
      createdAt: createdAt.toISOString(),
    };
    state.messages.push(inbound);
    state.transcript.push({
      direction: "inbound",
      senderType: "client",
      content: text,
      createdAt,
    });

    const hydrationRepository = new LocalHydrationRepository(state);
    const hydrator = new ConversationHydrator(hydrationRepository, new LocalPolicyPackProvider());
    const stateRepository = new LocalSofiaStateRepository(state);
    const aiService = new ConversationAiService(this.model, {
      save: async (record) => { state.aiRecord = record; },
    });
    const orchestrator = createInboundConversationOrchestrator({
      hydrator,
      qualificationFlowEnabled: false,
      qualificationSignalEnabled: false,
      sofiaEnabled: true,
      sofiaRepository: stateRepository,
      sofiaDealerName: DEALER_NAME,
      conversationalAi: aiService,
      conversationalAiSendEnabled: false,
    });

    const externalId = "local-simulation-" + inbound.id;
    await orchestrator.process({
      tenantId: state.tenantId,
      contactId: state.providerContactId,
      consolidatedText: text,
      messages: [{
        externalId,
        contactId: state.providerContactId,
        conversationId: state.conversationId,
        channel: "local_simulator",
        content: text,
        semanticHash: createHash("sha256").update(text, "utf8").digest("hex"),
        receivedAt: createdAt.toISOString(),
      }],
    });

    const sofiaState = state.sofiaState;
    const response = sofiaState?.lastResponse?.trim();
    if (!sofiaState || !response) throw new Error("Sofia no produjo una respuesta para este turno.");
    const outboundAt = new Date();
    state.messages.push({
      id: randomUUID(),
      direction: "outbound",
      content: response,
      createdAt: outboundAt.toISOString(),
    });
    state.transcript.push({
      direction: "outbound",
      senderType: "agent",
      content: response,
      createdAt: outboundAt,
    });
    state.updatedAt = Date.now();
    return {
      conversationId: state.conversationId,
      contact: { name: CONTACT_NAME, providerContactId: state.providerContactId },
      messages: state.messages.map((item) => ({ ...item })),
      sofia: {
        response,
        facts: { ...sofiaState.facts },
        leadLevel: sofiaState.leadLevel,
        nextStep: state.aiRecord?.requiredAction,
      },
      openai: {
        status: state.aiRecord?.safetyIssues.includes("extraction_call_failed") ? "fallback" : "ok",
        extraction: state.aiRecord?.extraction ?? null,
        modelFacts: { ...(state.aiRecord?.modelFacts ?? {}) },
        safetyIssues: [...(state.aiRecord?.safetyIssues ?? [])],
        responseSource: "deterministic_rule",
      },
    };
  }

  reset(conversationId?: string): void {
    if (conversationId) this.conversations.delete(conversationId);
    else this.conversations.clear();
  }

  private createConversation(): LocalConversation {
    this.removeExpired();
    while (this.conversations.size >= MAX_CONVERSATIONS) {
      const oldest = this.conversations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.conversations.delete(oldest);
    }
    const state: LocalConversation = {
      conversationId: randomUUID(),
      tenantId: randomUUID(),
      contactId: randomUUID(),
      providerContactId: "local-contact-" + randomUUID(),
      transcript: [],
      messages: [],
      updatedAt: Date.now(),
    };
    this.conversations.set(state.conversationId, state);
    return state;
  }

  private getConversation(conversationId: string): LocalConversation {
    this.removeExpired();
    const state = this.conversations.get(conversationId);
    if (!state) throw new Error("La simulación expiró o no existe. Inicia una conversación nueva.");
    state.updatedAt = Date.now();
    return state;
  }

  private removeExpired(): void {
    const cutoff = Date.now() - EXPIRES_AFTER_MS;
    for (const [id, state] of this.conversations) {
      if (state.updatedAt < cutoff) this.conversations.delete(id);
    }
  }
}

class LocalHydrationRepository implements HydrationRepositoryPort {
  constructor(private readonly state: LocalConversation) {}

  async loadTenant() {
    return {
      id: this.state.tenantId,
      dealerName: DEALER_NAME,
      timezone: "America/Bogota",
      policyVersion: "local-sofia-simulator",
      status: "active",
      flags: {
        sofiaEnabled: true,
        qualificationFlowEnabled: false,
        qualificationSignalEnabled: false,
        conversationalAiShadowEnabled: true,
        conversationalAiSendEnabled: false,
      },
    };
  }

  async loadContactConversation() {
    return {
      contact: {
        id: this.state.contactId,
        providerContactId: this.state.providerContactId,
        preferredLanguage: "es",
        consentState: "unknown",
      },
      conversation: {
        id: this.state.conversationId,
        channel: "local_simulator",
        state: "open",
      },
    };
  }

  async loadRecentTranscript(_tenantId: string, _conversationId: string, limit: number) {
    return this.state.transcript.slice(-limit);
  }

  async loadActiveFacts() {
    return [];
  }

  async loadObjectives() {
    return [];
  }
}

class LocalSofiaStateRepository implements SofiaStateRepositoryPort {
  constructor(private readonly state: LocalConversation) {}

  async load(): Promise<SofiaConversationState | undefined> {
    return this.state.sofiaState ? structuredClone(this.state.sofiaState) : undefined;
  }

  async save(_tenantId: string, _contactId: string, value: SofiaConversationState): Promise<void> {
    this.state.sofiaState = structuredClone(value);
  }
}
