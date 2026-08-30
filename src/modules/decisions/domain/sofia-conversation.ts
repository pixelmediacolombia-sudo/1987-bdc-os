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
  has_id_document?: boolean;
  has_income_proof_document?: boolean;
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
  contactChannel?: string;
  mediaContext?: {
    audioTranscriptionFailed?: boolean;
    imageClassifications?: Array<"identity_document" | "income_proof_document" | "vehicle_photo" | "unrelated" | "unknown">;
    imageVehicleCategories?: string[];
  };
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
    const extractedFacts = extractFacts(input.latestMessage, input.priorFacts);
    const facts = mergeFacts(input.priorFacts, factsFromMedia(input.mediaContext), extractedFacts);
    const contactChannel = normalizeContactChannel(input.contactChannel);
    if (contactChannel) facts.contact_channel = contactChannel;
    applyPushDecision(facts, input.latestMessage);
    const contactCaptured = hasContactPath(facts);
    const hardRuleFailure = hasHardRuleFailure(facts);
    const hardRulesVerified = hasVerifiedHardRules(facts);
    const leadLevel = classifyLead(facts, this.policy);
    const reaction = reactionFor(input, extractedFacts, facts);

    if (input.mediaContext?.audioTranscriptionFailed) {
      return makeResult(facts, leadLevel, ["No te escuché bien, ¿me lo repites?"], "ask", contactCaptured, hardRuleFailure);
    }

    if (input.isFirstTurn || (input.turnCount === 1 && Object.keys(input.priorFacts).length === 0)) {
      const greeting = `Hola! Te saludamos desde ${input.dealerName}. Soy Sofía.`;
      const question = nextQuestion(input.dealerName, facts, this.policy);
      const opening = reaction ?? "Con gusto te ayudo.";
      return makeResult(facts, leadLevel, [greeting, [opening, question].filter(Boolean).join(" ")], "ask", contactCaptured, hardRuleFailure);
    }

    if (hardRuleFailure) return makeResult(facts, "C", [reaction ?? "Gracias por compartirlo.", "Con eso el gerente puede revisar contigo la mejor opción de seguimiento."], "follow_up", contactCaptured, true);
    if (isStrongPurchaseSignal(facts)) return makeResult(facts, leadLevel, [reaction ?? "Perfecto.", "Ya le paso tu información al gerente para que te ayude con los números exactos."], "handoff", contactCaptured, false);
    const pushTarget = nextPushTarget(facts.down_payment_declared);
    if (pushTarget !== undefined && facts.push_accepted === undefined) {
      facts.down_payment_push_target = pushTarget;
      return makeResult(facts, "B", [reaction ?? "Gracias por compartir tu enganche.", `Para una ${facts.vehicle_category ?? "opción como esa"}, llegar a $${pushTarget.toLocaleString("en-US")} puede ayudar con una mejor aprobación y un pago mensual más cómodo. ¿Te sería posible llegar a ese monto?`], "ask", contactCaptured, false);
    }

    if (input.turnCount >= 3 && !contactCaptured) {
      return makeResult(facts, leadLevel, [reaction ?? "Gracias por la información.", "Para que el gerente pueda ayudarte, ¿me compartes tu número de teléfono?"], "ask", false, false);
    }

    const question = nextQuestion(input.dealerName, facts, this.policy);
    if (question) return makeResult(facts, leadLevel, [reaction ?? "Gracias por la información.", question], "ask", contactCaptured, false);
    if (leadLevel === "A" && hardRulesVerified && contactCaptured) return makeResult(facts, "A", [reaction ?? "Perfecto.", "Ya le paso tu información al gerente para que te ayude con los números exactos."], "handoff", true, false);
    return makeResult(facts, leadLevel, [reaction ?? "Gracias.", "El gerente puede revisar contigo el siguiente paso y los números exactos."], "follow_up", contactCaptured, false);
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
  return facts.employment_months !== undefined && facts.employment_months >= 6 && (facts.has_income_proof === true || facts.has_income_proof_document === true);
}

export function classifyLead(facts: SofiaFacts, policy: SofiaPolicy = DEFAULT_SOFIA_POLICY): SofiaLeadLevel {
  if (!hasContactPath(facts)) return "C";
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

function nextQuestion(dealerName: string, facts: SofiaFacts, policy: SofiaPolicy): string | undefined {
  if (!facts.vehicle_category && !facts.vehicle_model_interest) return `¿Qué carro estás buscando financiar en ${dealerName}?`;
  if (!facts.vehicle_use) return "¿Es para ti o para la familia?";
  if (facts.down_payment_declared === undefined) return "¿Con cuánto cuentas para el enganche?";
  if (facts.has_trade_in === undefined) return tradeInQuestion(facts, policy);
  if (facts.has_trade_in === true && !facts.trade_in_description) return "¿De qué año, marca y modelo es?";
  if (!hasContactPath(facts)) return "¿Me compartes tu número para que el gerente pueda ayudarte?";
  if (facts.first_time_buyer === undefined) return "¿Ya has financiado un carro antes en Estados Unidos?";
  if (facts.employment_months === undefined) return "¿Cuánto tiempo llevas trabajando en tu empleo actual?";
  if (facts.has_income_proof === undefined) return "¿Cuentas con estados de cuenta o comprobantes de pago?";
  return undefined;
}

function isStrongPurchaseSignal(facts: SofiaFacts): boolean {
  return Boolean(hasContactPath(facts) && facts.down_payment_declared !== undefined && facts.visit_intent === true);
}

function normalizeContactChannel(channel: string | undefined): string | undefined {
  const normalized = channel?.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  return normalized || undefined;
}

function hasContactPath(facts: SofiaFacts): boolean {
  if (Boolean(facts.contact_value?.trim())) return true;
  const channel = normalizeContactChannel(facts.contact_channel);
  return channel === "whatsapp" || channel === "whatsapp_business";
}

function nextPushTarget(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (value <= 1_000) return 1_500;
  if (value === 1_500) return 2_000;
  if (value === 2_000) return 2_500;
  return undefined;
}

function tradeInQuestion(facts: SofiaFacts, policy: SofiaPolicy): string {
  const range = rangeFor(facts.vehicle_category, policy);
  const downPayment = facts.down_payment_accepted ?? facts.down_payment_declared;
  const reachesCategory = downPayment !== undefined && (range.max === undefined ? downPayment >= range.min : downPayment >= range.max);
  return reachesCategory
    ? "¿Traes algún carro para dar de cambio?"
    : "¿Tienes algún carro que puedas dar de parte de pago? Eso te ayudaría bastante con el enganche.";
}

function factsFromMedia(media: SofiaTurnInput["mediaContext"]): SofiaFacts {
  const classifications = media?.imageClassifications ?? [];
  const vehicleCategory = media?.imageVehicleCategories?.find((category) => category.trim());
  return {
    ...(vehicleCategory ? { vehicle_category: vehicleCategory } : {}),
    ...(classifications.includes("identity_document") ? { has_id_document: true } : {}),
    ...(classifications.includes("income_proof_document") ? { has_income_proof_document: true } : {}),
    ...(classifications.includes("vehicle_photo") ? { has_trade_in: true } : {}),
  };
}

function reactionFor(input: SofiaTurnInput, newFacts: SofiaFacts, facts: SofiaFacts): string | undefined {
  const classifications = input.mediaContext?.imageClassifications ?? [];
  if (classifications.includes("vehicle_photo")) {
    const imageVehicleCategory = input.mediaContext?.imageVehicleCategories?.find((category) => category.trim());
    return imageVehicleCategory
      ? `Se ve buena esa ${displayVehicleCategory(imageVehicleCategory)}.`
      : "Se ve bien. El gerente lo tasa cuando vengas.";
  }
  if (classifications.includes("identity_document") || classifications.includes("income_proof_document")) return "Listo, ya la recibí. Se la paso al gerente.";
  if (classifications.some((classification) => classification === "unrelated" || classification === "unknown")) return "Gracias por compartirla. Seguimos con la información de tu compra.";
  if (newFacts.vehicle_use === "familia") {
    const category = facts.vehicle_category ? `la ${displayVehicleCategory(facts.vehicle_category)}` : "esa opción";
    return `Perfecto, para familia ${category} es buena opción.`;
  }
  if (newFacts.vehicle_use === "solo") return "Perfecto, vamos a buscar una opción que te funcione a ti.";
  if (newFacts.down_payment_declared !== undefined) return "Va, con eso ya tenemos con qué trabajar.";
  if (newFacts.has_trade_in === false) return "Entendido, seguimos sin vehículo de cambio.";
  if (newFacts.has_trade_in === true) return "Perfecto, con ese carro de cambio podemos revisar más opciones.";
  if (newFacts.first_time_buyer === true) return "Perfecto, muchos empiezan así. Trabajamos con bancos para primera compra.";
  if (newFacts.first_time_buyer === false) return "Perfecto, ya tienes experiencia financiando.";
  if (newFacts.employment_months !== undefined) return "Gracias, con ese tiempo ya tenemos un dato importante.";
  if (newFacts.has_income_proof === true || newFacts.has_income_proof_document === true) return "Perfecto, con eso podemos revisar mejor tu perfil.";
  if (newFacts.has_id_document === true) return "Listo, ya la recibí. Se la paso al gerente.";
  if (facts.vehicle_category || facts.vehicle_model_interest) {
    const vehicle = facts.vehicle_model_interest ?? displayVehicleCategory(facts.vehicle_category ?? "opción");
    const article = facts.vehicle_model_interest ? "ese" : "esa";
    return `Perfecto, te ayudo con ${article} ${vehicle}.`;
  }
  return undefined;
}

function displayVehicleCategory(category: string): string {
  const normalized = category.trim().toLowerCase();
  return normalized === "suv" ? "SUV" : normalized === "sedan" ? "sedán" : normalized === "work truck" ? "camioneta de trabajo" : category;
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

function extractFacts(message: string, priorFacts: SofiaFacts): SofiaFacts {
  const userMessage = stripAdMetadata(message);
  const normalized = userMessage.trim().toLowerCase();
  const facts: SofiaFacts = {};
  const phone = userMessage.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  const normalizedWithoutPhone = phone ? normalized.replace(phone[0].toLowerCase(), " ") : normalized;
  const expectsDownPayment = Boolean(
    !priorFacts.down_payment_declared &&
    (priorFacts.vehicle_category || priorFacts.vehicle_model_interest) &&
    priorFacts.vehicle_use,
  );
  const numericValue = extractDownPaymentNumber(normalizedWithoutPhone, expectsDownPayment);
  const wordAmount = normalizedWithoutPhone.match(SPANISH_THOUSANDS_AMOUNT_PATTERN);
  const wordValue = wordAmount && (expectsDownPayment || hasDownPaymentContext(normalizedWithoutPhone))
    ? parseSpanishAmount(wordAmount[0])
    : undefined;
  const value = numericValue ?? wordValue;
  if (value !== undefined && Number.isFinite(value)) facts.down_payment_declared = value;
  if (/\b(suv|camioneta)\b/.test(normalized)) facts.vehicle_category = "suv";
  else if (/\b(sedan|carro|auto)\b/.test(normalized)) facts.vehicle_category = "sedan";
  else if (/\b(camion|truck|pickup|trabajo)\b/.test(normalized)) facts.vehicle_category = "work truck";
  else if (/\b(van|minivan)\b/.test(normalized)) facts.vehicle_category = "van";
  const vehicleModel = extractVehicleModelInterest(userMessage, priorFacts, normalizedWithoutPhone);
  if (vehicleModel) facts.vehicle_model_interest = vehicleModel;
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

function stripAdMetadata(message: string): string {
  return message
    .replace(/^\s*\*Headline:\*.*(?:\r?\n|$)/gim, "")
    .replace(/^\s*\*Source URL:\*.*(?:\r?\n|$)/gim, "")
    .trim();
}

function extractDownPaymentNumber(message: string, expectsDownPayment: boolean): number | undefined {
  const matches = [...message.matchAll(/(?:\$|usd\s*)?(\d{1,3}(?:[,.]\d{3})+|\d{3,5})(?:\s*(?:d[oó]lares|usd))?/gi)];
  const explicit = matches.find((match) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = message.slice(Math.max(0, start - 32), start);
    const after = message.slice(end, Math.min(message.length, end + 24));
    return /(?:\$|\busd\b|d[oó]lares?|enganche|anticipo|inicial|parte de pago|cuento con|tengo|dispongo|ahorrad[oa])\s*$/i.test(before) ||
      /^\s*(?:d[oó]lares?|\busd\b|de\s+(?:el\s+)?enganche|para\s+(?:el\s+)?enganche)\b/i.test(after);
  });
  const selected = explicit ?? (
    expectsDownPayment && matches.length === 1 &&
    /^(?:(?:tengo|cuento con|dispongo de|puedo dar|son)\s+)?(?:\$\s*)?\d[\d,.]*(?:\s*(?:d[oó]lares|usd))?[.!?]?$/.test(message.trim())
      ? matches[0]
      : undefined
  );
  return selected ? Number(selected[1].replace(/[,.]/g, "")) : undefined;
}

function hasDownPaymentContext(message: string): boolean {
  return /\$|\busd\b|d[oó]lares?|enganche|anticipo|inicial|parte de pago|cuento con|tengo|dispongo|ahorrad[oa]/i.test(message);
}

function extractVehicleModelInterest(message: string, priorFacts: SofiaFacts, normalized: string): string | undefined {
  if (priorFacts.vehicle_model_interest) return undefined;
  const explicit = message.match(/\b(?:quiero|busco|quisiera|necesito|me interesa|estoy buscando|ando buscando)\s+(?:(?:un|una|el|la)\s+)?(.+?)(?:\s+(?:para|con|porque|y)\b.*)?$/i);
  const candidate = explicit?.[1]?.trim() ?? (
    !priorFacts.vehicle_category && !priorFacts.vehicle_model_interest &&
    normalized.split(/\s+/).length <= 5 &&
    !/\b(?:hola|gracias|informaci[oó]n|ayuda|quiero m[aá]s|buenas|buenos d[ií]as|buenas tardes|buenas noches)\b/i.test(normalized) &&
    !/^(?:si|sí|no|ok|okay|claro|un carro|un auto|una camioneta|una suv|un sedan)$/i.test(normalized)
      ? message.trim()
      : undefined
  );
  if (!candidate) return undefined;
  const cleaned = candidate.replace(/[.!?,;:]+$/, "").replace(/^(?:un|una|el|la)\s+/i, "").trim();
  if (!cleaned || /^(?:suv|camioneta|sedan|carro|auto|camion|truck|pickup|van|minivan)$/i.test(cleaned) || /^(?:m[aá]s\s+informaci[oó]n|informaci[oó]n|ayuda)$/i.test(cleaned)) return undefined;
  return cleaned;
}

const SPANISH_NUMBER_WORDS = [
  "un", "uno", "una", "dos", "tres", "cuatro", "cinco", "seis", "siete", "ocho", "nueve",
  "diez", "once", "doce", "trece", "catorce", "quince", "dieciseis", "diecisiete", "dieciocho", "diecinueve",
  "veinte", "veintiuno", "veintiun", "veintidos", "veintitres", "veinticuatro", "veinticinco", "veintiseis", "veintisiete", "veintiocho", "veintinueve",
  "treinta", "cuarenta", "cincuenta", "sesenta", "setenta", "ochenta", "noventa",
  "cien", "ciento", "doscientos", "trescientos", "cuatrocientos", "quinientos", "seiscientos", "setecientos", "ochocientos", "novecientos",
  "mil",
];
const SPANISH_NUMBER_WORD = `(?:${SPANISH_NUMBER_WORDS.join("|")})`;
const SPANISH_THOUSANDS_AMOUNT_PATTERN = new RegExp(`\\b${SPANISH_NUMBER_WORD}(?:\\s+${SPANISH_NUMBER_WORD})*\\s+mil(?:\\s+${SPANISH_NUMBER_WORD})?\\b|\\bmil(?:\\s+${SPANISH_NUMBER_WORD})?\\b`, "i");

function parseSpanishAmount(value: string): number | undefined {
  const units: Record<string, number> = {
    un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9,
    diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
    veinte: 20, veintiuno: 21, veintiun: 21, veintidos: 22, veintitres: 23, veinticuatro: 24, veinticinco: 25, veintiseis: 26, veintisiete: 27, veintiocho: 28, veintinueve: 29,
    treinta: 30, cuarenta: 40, cincuenta: 50, sesenta: 60, setenta: 70, ochenta: 80, noventa: 90,
    cien: 100, ciento: 100, doscientos: 200, trescientos: 300, cuatrocientos: 400, quinientos: 500, seiscientos: 600, setecientos: 700, ochocientos: 800, novecientos: 900,
  };
  let total = 0;
  let current = 0;
  for (const token of value.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/\s+/)) {
    if (token === "mil") {
      total += (current || 1) * 1000;
      current = 0;
      continue;
    }
    const amount = units[token];
    if (amount === undefined) return undefined;
    current += amount;
  }
  const result = total + current;
  return total > 0 ? result : undefined;
}
