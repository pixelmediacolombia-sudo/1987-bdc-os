import type { SofiaFacts } from "@/modules/decisions/domain/sofia-conversation";

export const CONVERSATIONAL_PROMPT_VERSION = "conversation-ai-shadow-v3-extraction-only";

export type ConversationalModelTranscriptMessage = {
  direction: "inbound" | "outbound";
  content: string;
};

export type ConversationalModelExtractionInput = {
  latestMessage: string;
  transcript: ConversationalModelTranscriptMessage[];
  knownFacts: SofiaFacts;
  missingObjectives: string[];
  language: string;
  dealerName: string;
  channel: string;
};

export type ConversationalModelExtraction = {
  facts: Partial<SofiaFacts>;
  intent: string;
  missingFields: string[];
};

export type ConversationalModelUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type ConversationalModelPort = {
  readonly extractionModel: string;
  /** Kept as historical database metadata; v3 never calls a drafting model. */
  readonly draftingModel: string;
  extract(input: ConversationalModelExtractionInput): Promise<{
    value: ConversationalModelExtraction;
    usage?: ConversationalModelUsage;
  }>;
};

export type ConversationAiShadowRecord = {
  tenantId: string;
  contactId: string;
  inboundExternalId?: string;
  extractionModel: string;
  draftingModel: string;
  promptVersion: string;
  extraction?: ConversationalModelExtraction;
  modelFacts: Partial<SofiaFacts>;
  ruleFacts: SofiaFacts;
  requiredAction?: "ask" | "handoff" | "follow_up" | "none";
  requiredQuestion?: string;
  responseSource: "deterministic_rule";
  ruleResponse?: string;
  modelResponse?: string;
  draftAccepted: boolean;
  safetyIssues: string[];
  inputTokens?: number;
  outputTokens?: number;
};

export interface ConversationAiShadowRepositoryPort {
  save(record: ConversationAiShadowRecord): Promise<void>;
}
