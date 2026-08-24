export type SofiaLeadLevel = "A" | "B" | "C";

export type SofiaFacts = {
  vehicle_category?: string;
  vehicle_model_interest?: string;
  down_payment_declared?: number;
  down_payment_accepted?: number;
  push_accepted?: boolean;
  has_trade_in?: boolean;
  trade_in_description?: string;
  trade_in_financed?: boolean;
  contact_channel?: string;
  contact_value?: string;
  first_time_buyer?: boolean;
  employment_months?: number;
  has_income_proof?: boolean;
};

export type SofiaDownPaymentRange = { min: number; max?: number };

export type SofiaPolicy = {
  downPaymentRanges: Record<string, SofiaDownPaymentRange>;
};

export type SofiaTurnInput = {
  dealerName: string;
  latestMessage: string;
  priorFacts: SofiaFacts;
  turnCount: number;
};

export type SofiaTurnResult = {
  facts: SofiaFacts;
  leadLevel: SofiaLeadLevel;
  response?: string;
  nextStep: "ask" | "handoff" | "follow_up" | "none";
  contactCaptured: boolean;
  hardRuleFailure: boolean;
};

export const DEFAULT_SOFIA_POLICY: SofiaPolicy = {
  downPaymentRanges: {
    sedan: { min: 1_500, max: 2_000 },
    suv: { min: 2_000, max: 3_000 },
    "work truck": { min: 3_500 },
    van: { min: 3_500 },
    sport: { min: 3_500 },
    luxury: { min: 3_500 },
    default: { min: 1_500 },
  },
};

export class SofiaConversationEngine {
  constructor(private readonly policy: SofiaPolicy = DEFAULT_SOFIA_POLICY) {}

  processTurn(input: SofiaTurnInput): SofiaTurnResult {
    const facts = mergeFacts(input.priorFacts, extractFacts(input.latestMessage));
    const contactCaptured = Boolean(facts.contact_value?.trim());
    const hardRuleFailure =
      (facts.employment_months !== undefined && facts.employment_months < 6) ||
      facts.has_income_proof === false;
    const leadLevel = classifyLead(facts, this.policy);

    if (hardRuleFailure) return { facts, leadLevel: "C", nextStep: "follow_up", contactCaptured, hardRuleFailure: true };
    if (leadLevel === "A" && contactCaptured) {
      return {
        facts,
        leadLevel,
        nextStep: "handoff",
        response: "Perfecto. Ya le paso tu información al gerente para que te ayude con los números exactos.",
        contactCaptured,
        hardRuleFailure: false,
      };
    }
    if (input.turnCount >= 3 && !contactCaptured) {
      return {
        facts,
        leadLevel,
        nextStep: "ask",
        response: "Para que el gerente pueda ayudarte, ¿me compartes tu número de teléfono?",
        contactCaptured,
        hardRuleFailure: false,
      };
    }
    return {
      facts,
      leadLevel,
      nextStep: "ask",
      response: nextQuestion(input.dealerName, facts),
      contactCaptured,
      hardRuleFailure: false,
    };
  }
}

export function classifyLead(facts: SofiaFacts, policy: SofiaPolicy = DEFAULT_SOFIA_POLICY): SofiaLeadLevel {
  if (!facts.contact_value?.trim()) return "C";
  if ((facts.employment_months !== undefined && facts.employment_months < 6) || facts.has_income_proof === false) return "C";
  const range = rangeFor(facts.vehicle_category, policy);
  const acceptedDown = facts.down_payment_accepted ?? facts.down_payment_declared;
  const declaredDown = facts.down_payment_declared;
  const inRange = acceptedDown !== undefined && acceptedDown >= range.min;
  const acceptedPush = facts.push_accepted === true && acceptedDown !== undefined && acceptedDown >= range.min;
  if (inRange || facts.has_trade_in === true || acceptedPush) return "A";
  if (declaredDown !== undefined) return "B";
  return "C";
}

export function mergeFacts(...sources: SofiaFacts[]): SofiaFacts {
  return Object.assign({}, ...sources);
}

function rangeFor(category: string | undefined, policy: SofiaPolicy): SofiaDownPaymentRange {
  const normalized = category?.trim().toLowerCase() ?? "";
  return policy.downPaymentRanges[normalized] ?? policy.downPaymentRanges.default ?? { min: 1_500 };
}

function nextQuestion(dealerName: string, facts: SofiaFacts): string {
  if (!facts.vehicle_category && !facts.vehicle_model_interest) return `¿Qué carro estás buscando financiar en ${dealerName}?`;
  if (facts.down_payment_declared === undefined) return "¿Con cuánto cuentas para el enganche?";
  if (facts.has_trade_in === undefined) return "¿Tienes algún carro para darlo como parte de pago?";
  if (!facts.contact_value) return "¿Me compartes tu número para que el gerente pueda ayudarte?";
  if (facts.first_time_buyer === undefined) return "¿Ya has financiado un carro antes en Estados Unidos?";
  if (facts.employment_months === undefined) return "¿Cuánto tiempo llevas trabajando en tu empleo actual?";
  if (facts.has_income_proof === undefined) return "¿Cuentas con estados de cuenta o comprobantes de pago?";
  return "Déjame confirmar los detalles y te aviso hoy mismo.";
}

function extractFacts(message: string): SofiaFacts {
  const normalized = message.trim().toLowerCase();
  const facts: SofiaFacts = {};
  const amount = normalized.match(/(?:\$|usd\s*)?(\d{1,3}(?:[,.]\d{3})*|\d{3,5})(?:\s*(?:d[oó]lares|usd))?/i);
  if (amount) {
    const value = Number(amount[1].replace(/[,.]/g, ""));
    if (Number.isFinite(value)) facts.down_payment_declared = value;
  }
  if (/\b(suv|camioneta)\b/.test(normalized)) facts.vehicle_category = "suv";
  else if (/\b(sedan|carro|auto)\b/.test(normalized)) facts.vehicle_category = "sedan";
  else if (/\b(camion|truck|pickup|trabajo)\b/.test(normalized)) facts.vehicle_category = "work truck";
  else if (/\b(van|minivan)\b/.test(normalized)) facts.vehicle_category = "van";
  if (/\b(no|ninguno|no tengo)\b.*\b(trade|carro|veh[ií]culo)\b|\bno trade\b/.test(normalized)) facts.has_trade_in = false;
  else if (/\b(trade|parte de pago|dar mi carro|tengo un carro)\b/.test(normalized)) facts.has_trade_in = true;
  if (/\b(primera vez|nunca|first time)\b/.test(normalized)) facts.first_time_buyer = true;
  else if (/\b(ya he financiado|he comprado a cr[eé]dito|financi[eé])\b/.test(normalized)) facts.first_time_buyer = false;
  const months = normalized.match(/(\d+)\s*(?:meses?|months?)/);
  if (months) facts.employment_months = Number(months[1]);
  if (/\b(no tengo|sin)\b.*\b(comprobantes?|estados de cuenta|talones?)\b/.test(normalized)) facts.has_income_proof = false;
  else if (/\b(comprobantes?|estados de cuenta|talones?|pay ?stubs?|bank statements?)\b/.test(normalized)) facts.has_income_proof = true;
  const phone = message.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  if (phone) {
    facts.contact_channel = "phone";
    facts.contact_value = phone[0].replace(/\D/g, "");
  }
  return facts;
}
