import type { SofiaFacts, SofiaTurnResult } from "@/modules/decisions/domain/sofia-conversation";
import {
  CONVERSATIONAL_PROMPT_VERSION,
  type ConversationAiShadowRecord,
  type ConversationAiShadowRepositoryPort,
  type ConversationalModelExtraction,
  type ConversationalModelPort,
} from "@/modules/control/application/conversation-ai-model-contract";

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
  extractionSucceeded: boolean;
  extractionIssues: string[];
  responseSource: "deterministic_rule";
};

/** Uses the model for interpretation only; policy, response and send stay in code. */
export class ConversationAiService {
  constructor(
    private readonly model: ConversationalModelPort,
    private readonly shadowRepository: ConversationAiShadowRepositoryPort,
  ) {}

  async process(input: ConversationAiTurnInput): Promise<ConversationAiTurnResult> {
    let extraction: ConversationalModelExtraction | undefined;
    let modelFacts: Partial<SofiaFacts> = {};
    let extractionUsage = { inputTokens: 0, outputTokens: 0 };
    let extractionSucceeded = false;
    let extractionIssues: string[] = [];
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
      extractionSucceeded = true;
    } catch {
      extractionIssues = ["extraction_call_failed"];
    }

    // Model facts only enrich the input to the deterministic engine. The
    // engine remains the sole authority for policy, lead state and response.
    const ruleResult = input.ruleTurn({ ...input.priorFacts, ...modelFacts });
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
      responseSource: "deterministic_rule",
      ...(ruleResult.response ? { ruleResponse: ruleResult.response } : {}),
      draftAccepted: false,
      safetyIssues: extractionIssues,
      inputTokens: extractionUsage.inputTokens,
      outputTokens: extractionUsage.outputTokens,
    };
    await this.shadowRepository.save(record);
    return { ruleResult, modelFacts, extractionSucceeded, extractionIssues, responseSource: "deterministic_rule" };
  }
}

function sanitizeFacts(value: Partial<SofiaFacts> | undefined): Partial<SofiaFacts> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const output: Partial<SofiaFacts> = {};
  const stringKeys = new Set(["contact_name", "vehicle_category", "vehicle_model_interest", "vehicle_use", "trade_in_description", "trade_in_model", "contact_channel", "contact_value", "purchase_timeline"]);
  const numberKeys = new Set(["vehicle_year", "down_payment_declared", "down_payment_accepted", "down_payment_push_target", "trade_in_year", "employment_months"]);
  const booleanKeys = new Set(["push_accepted", "has_trade_in", "trade_in_financed", "first_time_buyer", "has_income_proof", "has_id_document", "has_income_proof_document", "has_co_signer", "visit_intent"]);
  for (const [key, candidate] of Object.entries(value)) {
    const canonicalKey = canonicalFactKey(key);
    if (stringKeys.has(canonicalKey) && typeof candidate === "string" && candidate.trim().length <= 160) output[canonicalKey as keyof SofiaFacts] = normalizeFactString(canonicalKey, candidate.trim()) as never;
    else if (numberKeys.has(canonicalKey)) {
      const numericValue = typeof candidate === "number" ? candidate : typeof candidate === "string" ? parseExtractionNumber(candidate) : undefined;
      if (numericValue !== undefined && Number.isFinite(numericValue)) {
        const valid = canonicalKey.includes("year") ? numericValue >= 1900 && numericValue <= 2100 : canonicalKey.includes("month") ? numericValue >= 0 && numericValue <= 600 : numericValue >= 0 && numericValue <= 50_000;
        if (valid) output[canonicalKey as keyof SofiaFacts] = numericValue as never;
      }
    } else if (booleanKeys.has(canonicalKey) && typeof candidate === "boolean") output[canonicalKey as keyof SofiaFacts] = candidate as never;
  }
  if (typeof output.contact_value === "string" && !/^\d{7,15}$/.test(output.contact_value)) delete output.contact_value;
  return output;
}

function canonicalFactKey(key: string): string {
  const aliases: Record<string, string> = {
    nombre: "contact_name", name: "contact_name", modelo: "vehicle_model_interest", vehicle_model: "vehicle_model_interest",
    categoria: "vehicle_category", category: "vehicle_category", enganche: "down_payment_declared", down_payment: "down_payment_declared",
    down_payment_amount: "down_payment_declared", trade_in: "has_trade_in", telefono: "contact_value", phone: "contact_value",
    income_proof: "has_income_proof", timeline: "purchase_timeline",
  };
  return aliases[key.trim().toLowerCase()] ?? key;
}

function normalizeFactString(key: string, value: string): string {
  if (key === "vehicle_model_interest") return value.replace(/\bcorrola\b/gi, "Corolla").replace(/\btayota\b/gi, "Toyota").trim();
  if (key === "vehicle_category") return value.replace(/[_-]/g, " ").trim();
  return value;
}

function parseExtractionNumber(value: string): number | undefined {
  const normalized = value.trim().toLowerCase().replace(/[$,]/g, "");
  if (/^\d+(?:\.\d+)?$/.test(normalized)) return Number(normalized);
  const units: Record<string, number> = {
    quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900,
    mil: 1000, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10, quince: 15, veinte: 20,
  };
  const tokens = normalized.normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/);
  let total = 0;
  let current = 0;
  for (const token of tokens) {
    const amount = units[token];
    if (amount === undefined) return undefined;
    if (token === "mil") {
      total += (current || 1) * 1000;
      current = 0;
    } else current += amount;
  }
  const result = total + current;
  return result > 0 ? result : undefined;
}

function usageOrZero(usage: { inputTokens?: number; outputTokens?: number } | undefined): { inputTokens: number; outputTokens: number } {
  return { inputTokens: Number.isFinite(usage?.inputTokens) ? usage?.inputTokens ?? 0 : 0, outputTokens: Number.isFinite(usage?.outputTokens) ? usage?.outputTokens ?? 0 : 0 };
}
