import type { SofiaFacts, SofiaTurnResult } from "@/modules/decisions/domain/sofia-conversation";
import {
  CONVERSATIONAL_PROMPT_VERSION,
  type ConversationAiShadowRecord,
  type ConversationAiShadowRepositoryPort,
  type ConversationalModelExtraction,
  type ConversationalModelPort,
} from "@/modules/control/application/conversation-ai-model-contract";
import { validateDraftSafety } from "@/modules/control/application/conversation-ai-model-safety";

export type ConversationAiTurnInput = {
  tenantId: string;
  contactId: string;
  inboundExternalId?: string;
  latestMessage: string;
  transcript: Array<{ direction: "inbound" | "outbound"; content: string }>;
  channel: string;
  language: string;
  dealerName: string;
  priorFacts: SofiaFacts;
  missingObjectives: string[];
  ruleTurn: (priorFacts: SofiaFacts) => SofiaTurnResult;
};

export type ConversationAiTurnResult = {
  ruleResult: SofiaTurnResult;
  modelFacts: Partial<SofiaFacts>;
  modelResponse?: string;
  draftAccepted: boolean;
  safetyIssues: string[];
};

/** Runs extraction and drafting while leaving policy, qualification and send to code. */
export class ConversationAiService {
  constructor(
    private readonly model: ConversationalModelPort,
    private readonly shadowRepository: ConversationAiShadowRepositoryPort,
  ) {}

  async process(input: ConversationAiTurnInput): Promise<ConversationAiTurnResult> {
    let extraction: ConversationalModelExtraction | undefined;
    let modelFacts: Partial<SofiaFacts> = {};
    let extractionUsage = { inputTokens: 0, outputTokens: 0 };
    try {
      const result = await this.model.extract({
        latestMessage: input.latestMessage,
        transcript: input.transcript,
        knownFacts: input.priorFacts,
        missingObjectives: input.missingObjectives,
        language: input.language,
        dealerName: input.dealerName,
        channel: input.channel,
      });
      extraction = result.value;
      modelFacts = sanitizeFacts(result.value.facts);
      extractionUsage = usageOrZero(result.usage);
    } catch {
      // The deterministic flow remains the user-visible fallback.
    }

    const ruleResult = input.ruleTurn({ ...input.priorFacts, ...modelFacts });
    const requiredQuestion = extractRequiredQuestion(ruleResult.response);
    const recentOutboundResponses = input.transcript
      .filter((message) => message.direction === "outbound")
      .map((message) => message.content)
      .slice(-5);
    let modelResponse: string | undefined;
    let draftAccepted = false;
    let safetyIssues: string[] = [];
    let draftingUsage = { inputTokens: 0, outputTokens: 0 };
    try {
      const result = await this.model.draft({
        latestMessage: input.latestMessage,
        transcript: input.transcript,
        knownFacts: ruleResult.facts,
        resolvedFacts: ruleResult.facts,
        pendingObjectives: input.missingObjectives,
        requiredAction: ruleResult.nextStep,
        ...(requiredQuestion ? { requiredQuestion } : {}),
        recentOutboundResponses,
        nextQuestion: requiredQuestion ?? input.missingObjectives[0],
        ruleResponse: ruleResult.response,
        language: input.language,
        dealerName: input.dealerName,
        channel: input.channel,
      });
      modelResponse = result.value.trim();
      draftingUsage = usageOrZero(result.usage);
      const safety = validateDraftSafety(modelResponse, {
        knownFacts: ruleResult.facts,
        ruleResponse: ruleResult.response,
        requiredAction: ruleResult.nextStep,
        ...(requiredQuestion ? { requiredQuestion } : {}),
        previousResponses: recentOutboundResponses,
        clientWordCount: input.latestMessage.trim().split(/\s+/).filter(Boolean).length,
      });
      draftAccepted = safety.accepted;
      safetyIssues = safety.issues;
    } catch {
      safetyIssues = ["draft_call_failed"];
    }

    const record: ConversationAiShadowRecord = {
      tenantId: input.tenantId,
      contactId: input.contactId,
      ...(input.inboundExternalId ? { inboundExternalId: input.inboundExternalId } : {}),
      extractionModel: this.model.extractionModel,
      draftingModel: this.model.draftingModel,
      promptVersion: CONVERSATIONAL_PROMPT_VERSION,
      ...(extraction ? { extraction } : {}),
      modelFacts,
      ruleFacts: ruleResult.facts,
      requiredAction: ruleResult.nextStep,
      ...(requiredQuestion ? { requiredQuestion } : {}),
      ...(ruleResult.response ? { ruleResponse: ruleResult.response } : {}),
      ...(modelResponse ? { modelResponse } : {}),
      draftAccepted,
      safetyIssues,
      inputTokens: extractionUsage.inputTokens + draftingUsage.inputTokens,
      outputTokens: extractionUsage.outputTokens + draftingUsage.outputTokens,
    };
    await this.shadowRepository.save(record);
    return { ruleResult, modelFacts, ...(modelResponse ? { modelResponse } : {}), draftAccepted, safetyIssues };
  }
}

function extractRequiredQuestion(response: string | undefined): string | undefined {
  const matches = response?.match(/[^.!?\n]*\?/g) ?? [];
  return matches.at(-1)?.trim() || undefined;
}

function sanitizeFacts(value: Partial<SofiaFacts> | undefined): Partial<SofiaFacts> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Partial<SofiaFacts> = {};
  const stringKeys = new Set(["contact_name", "vehicle_category", "vehicle_model_interest", "vehicle_use", "trade_in_description", "trade_in_model", "contact_channel", "contact_value", "purchase_timeline"]);
  const numberKeys = new Set(["vehicle_year", "down_payment_declared", "down_payment_accepted", "down_payment_push_target", "trade_in_year", "employment_months"]);
  const booleanKeys = new Set(["push_accepted", "has_trade_in", "trade_in_financed", "first_time_buyer", "has_income_proof", "has_id_document", "has_income_proof_document", "has_co_signer", "visit_intent"]);
  for (const [key, candidate] of Object.entries(value)) {
    if (stringKeys.has(key) && typeof candidate === "string" && candidate.trim().length <= 160) output[key as keyof SofiaFacts] = candidate.trim() as never;
    else if (numberKeys.has(key) && typeof candidate === "number" && Number.isFinite(candidate)) {
      const valid = key.includes("year") ? candidate >= 1900 && candidate <= 2100 : key.includes("month") ? candidate >= 0 && candidate <= 600 : candidate >= 0 && candidate <= 50_000;
      if (valid) output[key as keyof SofiaFacts] = candidate as never;
    } else if (booleanKeys.has(key) && typeof candidate === "boolean") output[key as keyof SofiaFacts] = candidate as never;
  }
  if (typeof output.contact_value === "string" && !/^\d{7,15}$/.test(output.contact_value)) delete output.contact_value;
  return output;
}

function usageOrZero(usage: { inputTokens?: number; outputTokens?: number } | undefined): { inputTokens: number; outputTokens: number } {
  return { inputTokens: Number.isFinite(usage?.inputTokens) ? usage?.inputTokens ?? 0 : 0, outputTokens: Number.isFinite(usage?.outputTokens) ? usage?.outputTokens ?? 0 : 0 };
}
