export type SofiaLeadLevel = "A" | "B" | "C";

export type SofiaFacts = {
  vehicle_category?: string;
  vehicle_model_interest?: string;
  vehicle_use?: "solo" | "familia" | string;
  down_payment_declared?: number;
  down_payment_accepted?: number;
  down_payment_push_target?: number;
  push_accepted?: boolean;
  has_trade_in?: boolean;
  trade_in_description?: string;
  trade_in_financed?: boolean;
  contact_channel?: string;
  contact_value?: string;
  first_time_buyer?: boolean;
  employment_months?: number;
  has_income_proof?: boolean;
  visit_intent?: boolean;
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
  isFirstTurn?: boolean;
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
    applyPushDecision(facts, input.latestMessage);
    const contactCaptured = Boolean(facts.contact_value?.trim());
    const hardRuleFailure = hasHardRuleFailure(facts);
    const hardRulesVerified = hasVerifiedHardRules(facts);
    const leadLevel = classifyLead(facts, this.policy);

    if (input.isFirstTurn || (input.turnCount === 1 && Object.keys(input.priorFacts).length === 0)) {
      const greeting = `Hola! Te saluda Sofía de ${input.dealerName}`;
      const reaction = facts.vehicle_category || facts.vehicle_model_interest
        ? "Con gusto te ayudo. ¿Es para ti o para la familia?"
        : "Con gusto te ayudo. ¿Qué carro estás buscando financiar?";
      return makeResult(facts, leadLevel, [greeting, reaction], "ask", contactCaptured, hardRuleFailure);
    }

    if (hardRuleFailure) return makeResult(facts, "C", ["Gracias por compartirlo. Con eso el gerente puede revisar contigo la mejor opción de seguimiento."], "follow_up", contactCaptured, true);
    if (isStrongPurchaseSignal(facts)) return makeResult(facts, leadLevel, ["Perfecto. Ya le paso tu información al gerente para que te ayude con los números exactos."], "handoff", contactCaptured, false);
    const pushTarget = nextPushTarget(facts.down_payment_declared);
    if (pushTarget !== undefined && facts.push_accepted === undefined) {
      facts.down_payment_push_target = pushTarget;
      return makeResult(facts, "B", [`Para una ${facts.vehicle_category ?? "opción como esa"}, los bancos suelen ver mejor un enganche de $${pushTarget.toLocaleString("en-US")}. ¿Te sería posible llegar a ese monto?`], "ask", contactCaptured, false);
    }

    if (input.turnCount >= 3 && !contactCaptured) {
      return makeResult(facts, leadLevel, ["Para que el gerente pueda ayudarte, ¿me compartes tu número de teléfono?"], "ask", false, false);
    }

    const question = nextQuestion(input.dealerName, facts);
    if (question) return makeResult(facts, leadLevel, [question], "ask", contactCaptured, false);
    if (leadLevel === "A" && hardRulesVerified && contactCaptured) return makeResult(facts, "A", ["Perfecto. Ya le paso tu información al gerente para que te ayude con los números exactos."], "handoff", true, false);
    return makeResult(facts, leadLevel, ["Gracias. El gerente puede revisar contigo el siguiente paso y los números exactos."], "follow_up", contactCaptured, false);
  }
}

function makeResult(
  facts: SofiaFacts,
  leadLevel: SofiaLeadLevel,
  messages: string[],
  nextStep: SofiaTurnResult["nextStep"],
  contactCaptured: boolean,
  hardRuleFailure: boolean,
): SofiaTurnResult {
  return { facts, leadLevel, response: messages.join("\n"), nextStep, contactCaptured, hardRuleFailure };
}

function hasHardRuleFailure(facts: SofiaFacts): boolean {
  return (facts.employment_months !== undefined && facts.employment_months < 6) || facts.has_income_proof === false;
}

function hasVerifiedHardRules(facts: SofiaFacts): boolean {
  return facts.employment_months !== undefined && facts.employment_months >= 6 && facts.has_income_proof === true;
}

export function classifyLead(facts: SofiaFacts, policy: SofiaPolicy = DEFAULT_SOFIA_POLICY): SofiaLeadLevel {
  if (!facts.contact_value?.trim()) return "C";
  if (hasHardRuleFailure(facts)) return "C";
  const range = rangeFor(facts.vehicle_category, policy);
  const acceptedDown = facts.down_payment_accepted ?? facts.down_payment_declared;
  const declaredDown = facts.down_payment_declared;
  const inRange = acceptedDown !== undefined && acceptedDown >= range.min;
  const pushRequired = nextPushTarget(declaredDown) !== undefined;
  const pushSatisfied = !pushRequired || facts.push_accepted === true;
  if (hasVerifiedHardRules(facts) && (inRange || facts.has_trade_in === true) && pushSatisfied) return "A";
  if (declaredDown !== undefined || facts.has_trade_in === true) return "B";
  return "C";
}

export function mergeFacts(...sources: SofiaFacts[]): SofiaFacts {
  return Object.assign({}, ...sources);
}

function rangeFor(category: string | undefined, policy: SofiaPolicy): SofiaDownPaymentRange {
  const normalized = category?.trim().toLowerCase() ?? "";
  return policy.downPaymentRanges[normalized] ?? policy.downPaymentRanges.default ?? { min: 1_500 };
}

function nextQuestion(dealerName: string, facts: SofiaFacts): string | undefined {
  if (!facts.vehicle_category && !facts.vehicle_model_interest) return `¿Qué carro estás buscando financiar en ${dealerName}?`;
  if (!facts.vehicle_use) return "¿Es para ti o para la familia?";
  if (facts.down_payment_declared === undefined) return "¿Con cuánto cuentas para el enganche?";
  if (facts.has_trade_in === undefined) return "¿Tienes algún carro para darlo como parte de pago?";
  if (!facts.contact_value) return "¿Me compartes tu número para que el gerente pueda ayudarte?";
  if (facts.first_time_buyer === undefined) return "¿Ya has financiado un carro antes en Estados Unidos?";
  if (facts.employment_months === undefined) return "¿Cuánto tiempo llevas trabajando en tu empleo actual?";
  if (facts.has_income_proof === undefined) return "¿Cuentas con estados de cuenta o comprobantes de pago?";
  return undefined;
}

function isStrongPurchaseSignal(facts: SofiaFacts): boolean {
  return Boolean(facts.contact_value && facts.down_payment_declared !== undefined && facts.visit_intent === true);
}

function nextPushTarget(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value <= 1_000) return 1_500;
  if (value === 1_500) return 2_000;
  if (value === 2_000) return 2_500;
  return undefined;
}

function applyPushDecision(facts: SofiaFacts, message: string): void {
  const normalized = message.trim().toLowerCase();
  const target = facts.down_payment_push_target;
  if (target === undefined || facts.push_accepted !== undefined) return;
  if (/^(sí|si|yes|claro|puedo|de acuerdo|ok|okay)(?:\s|[.!?,;:]|$)/.test(normalized)) {
    facts.push_accepted = true;
    facts.down_payment_accepted = target;
  } else if (/^(no|no puedo|ahorita no)(?:\s|[.!?,;:]|$)/.test(normalized)) {
    facts.push_accepted = false;
    facts.down_payment_accepted = facts.down_payment_declared;
  }
}

function extractFacts(message: string): SofiaFacts {
  const normalized = message.trim().toLowerCase();
  const facts: SofiaFacts = {};
  const phone = message.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  const normalizedWithoutPhone = phone ? normalized.replace(phone[0].toLowerCase(), " ") : normalized;
  const amount = normalizedWithoutPhone.match(/(?:\$|usd\s*)?(\d{3,5}(?:[,.]\d{3})*|\d{1,3}(?:[,.]\d{3})+)(?:\s*(?:d[oó]lares|usd))?/i);
  if (amount) {
    const value = Number(amount[1].replace(/[,.]/g, ""));
    if (Number.isFinite(value)) facts.down_payment_declared = value;
  }
  if (/\b(suv|camioneta)\b/.test(normalized)) facts.vehicle_category = "suv";
  else if (/\b(sedan|carro|auto)\b/.test(normalized)) facts.vehicle_category = "sedan";
  else if (/\b(camion|truck|pickup|trabajo)\b/.test(normalized)) facts.vehicle_category = "work truck";
  else if (/\b(van|minivan)\b/.test(normalized)) facts.vehicle_category = "van";
  if (/\bpara m[ií] mismo\b|\bsolo para m[ií]\b|\bpara m[ií]\b(?!\s+familia)/.test(normalized)) facts.vehicle_use = "solo";
  else if (/\bpara la familia|para mi familia|familia\b/.test(normalized)) facts.vehicle_use = "familia";
  if (/\b(no|ninguno|no tengo)\b.*\b(trade|carro|veh[ií]culo)\b|\bno trade\b/.test(normalized)) facts.has_trade_in = false;
  else if (/\b(trade|parte de pago|dar mi carro|tengo un carro)\b/.test(normalized)) {
    facts.has_trade_in = true;
    facts.trade_in_description = message.trim();
  }
  if (/\b(todav[ií]a debo|a[uú]n debo|sigo pagando|financiado|payments?)\b/.test(normalized)) facts.trade_in_financed = true;
  else if (/\b(pagado|no debo|libre)\b/.test(normalized)) facts.trade_in_financed = false;
  if (/\b(primera vez|nunca|first time)\b/.test(normalized)) facts.first_time_buyer = true;
  else if (/\b(ya he financiado|he comprado a cr[eé]dito|financi[eé]|ya compr[eé] carro)\b/.test(normalized)) facts.first_time_buyer = false;
  const months = normalized.match(/(\d+)\s*(?:meses?|months?)/);
  const years = normalized.match(/(\d+(?:[.,]\d+)?)\s*(?:a[nñ]os?|years?)/);
  if (months) facts.employment_months = Number(months[1]);
  else if (years) facts.employment_months = Math.round(Number(years[1].replace(",", ".")) * 12);
  if (/\b(no tengo|sin)\b.*\b(comprobantes?|estados de cuenta|talones?)\b/.test(normalized)) facts.has_income_proof = false;
  else if (/\b(comprobantes?|estados de cuenta|talones?|pay ?stubs?|bank statements?)\b/.test(normalized)) facts.has_income_proof = true;
  if (/\b(quiero ir|quiero visitar|visitar el dealer|hacer una cita|cita|pasar por)\b/.test(normalized)) facts.visit_intent = true;
  if (phone) {
    facts.contact_channel = "phone";
    facts.contact_value = phone[0].replace(/\D/g, "");
  }
  return facts;
}
