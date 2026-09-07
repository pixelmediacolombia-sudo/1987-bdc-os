import type { SofiaFacts } from "@/modules/decisions/domain/sofia-conversation";
import { normalizedTokenDice } from "@/modules/control/application/SemanticRepetitionValidator";

export type DraftSafetyContext = {
  knownFacts: SofiaFacts;
  ruleResponse?: string;
  requiredAction?: "ask" | "handoff" | "follow_up" | "none";
  requiredQuestion?: string;
  previousResponses?: string[];
  clientWordCount?: number;
};

export type DraftSafetyResult = { accepted: boolean; issues: string[] };

/** Model output is advisory and cannot add unsupported commercial terms. */
export function validateDraftSafety(candidate: string, context: DraftSafetyContext): DraftSafetyResult {
  const issues: string[] = [];
  const text = candidate.trim();
  if (!text) issues.push("empty_draft");
  if (text.length > 900) issues.push("draft_too_long");
  if (/https?:\/\/|www\./i.test(text)) issues.push("invented_url");
  if (/\b(?:te aprobamos|aprobaci[oó]n garantizada|ya est[aá]s aprobado|you're approved|you are approved|guaranteed approval)\b/i.test(text)) issues.push("approval_promise");
  if (/\b(?:claro que la tenemos|we have it|we do have it)\b/i.test(text)) issues.push("unsupported_inventory_claim");
  if ((text.match(/\?/g) ?? []).length > 1) issues.push("more_than_one_question");
  if (/^\s*(?:i am still here to help with the next detail|let me get the next detail|sigo aqu[ií] para ayudarle con el siguiente dato)\s*[.!]*\s*$/i.test(text)) issues.push("generic_filler");

  const requiredAction = context.requiredAction;
  const questionCount = (text.match(/\?/g) ?? []).length;
  if (requiredAction === "handoff" && !/\b(?:advisor|advisors|asesor|asesores|gerente|reach out|paso su informaci[oó]n|pasar su informaci[oó]n)\b/i.test(text)) issues.push("required_handoff_missing");
  if (requiredAction === "handoff" && questionCount > 0) issues.push("handoff_contains_question");
  if (requiredAction === "follow_up" && questionCount > 0) issues.push("follow_up_contains_question");
  if (requiredAction === "ask" && context.requiredQuestion && !questionMatches(text, context.requiredQuestion)) issues.push("required_question_mismatch");
  if (requiredAction === "ask" && !context.requiredQuestion) issues.push("missing_required_question");

  const allowedNumbers = new Set([...numbersFromFacts(context.knownFacts), ...numbersFromText(context.ruleResponse ?? "")]);
  for (const number of numbersFromText(text)) {
    if (!allowedNumbers.has(number)) {
      issues.push("unsupported_numeric_value");
      break;
    }
  }
  for (const previous of context.previousResponses ?? []) {
    if (normalizedTokenDice(text, previous) >= 0.8) {
      issues.push("semantic_repetition");
      break;
    }
  }
  if ((context.clientWordCount ?? 0) <= 3 && text.split(/\s+/).filter(Boolean).length > 60) issues.push("length_mismatch");
  return { accepted: issues.length === 0, issues };
}

function questionMatches(candidate: string, required: string): boolean {
  if (!(candidate.match(/\?/g) ?? []).length) return false;
  const requiredTopic = questionTopic(required);
  if (requiredTopic && questionTopic(candidate) === requiredTopic) return true;
  const requiredTokens = significantTokens(required);
  const candidateTokens = new Set(significantTokens(candidate));
  if (requiredTokens.length === 0) return true;
  const overlap = requiredTokens.filter((token) => candidateTokens.has(token)).length / requiredTokens.length;
  return overlap >= 0.35;
}

function questionTopic(value: string): string | undefined {
  const normalized = value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\b(?:name|nombre|gusto)\b/.test(normalized)) return "name";
  if (/\b(?:phone|numero|number|telefono)\b/.test(normalized)) return "phone";
  if (/\b(?:down|down payment|enganche|monto|cuanto|contaria)\b/.test(normalized)) return "down_payment";
  if (/\b(?:trade|carro|vehiculo|veh[ií]culo|parte de pago)\b/.test(normalized)) return "trade_in";
  if (/\b(?:financ|primera vez|first time)\b/.test(normalized)) return "financing_history";
  if (/\b(?:when|soon|how soon|tiempo|semana|mes)\b/.test(normalized)) return "timeline";
  if (/\b(?:pay stubs|talones|comprobantes|bank statements|estados de cuenta|employer letter|carta)\b/.test(normalized)) return "income_proof";
  if (/\b(?:sedan|suv|troca|truck|tipo de vehiculo|tipo de vehículo)\b/.test(normalized)) return "vehicle_category";
  if (/\b(?:vehicle|vehiculo|vehículo|carro|modelo|auto)\b/.test(normalized)) return "vehicle";
  return undefined;
}

function significantTokens(value: string): string[] {
  return value.toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 3 && !new Set(["the", "and", "are", "you", "for", "with", "what", "how", "que", "con", "una", "los", "las", "del", "para", "por"]).has(token));
}

function numbersFromFacts(facts: SofiaFacts): string[] {
  return Object.values(facts)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .flatMap((value) => numbersFromText(String(value)));
}

function numbersFromText(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => match[0].replace(",", "."));
}
