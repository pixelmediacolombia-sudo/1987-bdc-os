import type { SofiaFacts } from "@/modules/decisions/domain/sofia-conversation";
import { normalizedTokenDice } from "@/modules/control/application/SemanticRepetitionValidator";

export type DraftSafetyContext = {
  knownFacts: SofiaFacts;
  ruleResponse?: string;
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
  if ((context.clientWordCount ?? 0) <= 3 && text.split(/\s+/).filter(Boolean).length > 30) issues.push("length_mismatch");
  return { accepted: issues.length === 0, issues };
}

function numbersFromFacts(facts: SofiaFacts): string[] {
  return Object.values(facts)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .flatMap((value) => numbersFromText(String(value)));
}

function numbersFromText(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((match) => match[0].replace(",", "."));
}
