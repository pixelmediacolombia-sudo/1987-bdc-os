export type SofiaLeadLevel = "A" | "B" | "C";

export type SofiaFacts = {
  contact_name?: string;
  vehicle_category?: string;
  vehicle_model_interest?: string;
  vehicle_year?: number;
  vehicle_use?: "solo" | "familia" | string;
  down_payment_declared?: number;
  down_payment_accepted?: number;
  down_payment_push_target?: number;
  push_accepted?: boolean;
  has_trade_in?: boolean;
  trade_in_description?: string;
  trade_in_model?: string;
  trade_in_year?: number;
  trade_in_financed?: boolean;
  contact_channel?: string;
  contact_value?: string;
  first_time_buyer?: boolean;
  employment_months?: number;
  has_income_proof?: boolean;
  has_id_document?: boolean;
  has_income_proof_document?: boolean;
  purchase_timeline?: "this_week" | "this_month" | "soon" | "none" | string;
  has_co_signer?: boolean;
  visit_intent?: boolean;
  handoff_completed?: boolean;
};

export type SofiaDownPaymentRange = { min: number; max?: number };

export type SofiaPolicy = {
  downPaymentRanges: Record<string, SofiaDownPaymentRange>;
  knowledge?: SofiaKnowledge;
};

export type SofiaKnowledge = {
  id: "country_club_cars";
  formalAddress: true;
  dealer: {
    name: string;
    address: string;
    hours: { es: string; en: string };
  };
  modelCategories: Record<string, string>;
  requirements: { es: string; en: string };
  safeExit: { es: string; en: string };
  noTimeline: { es: string; en: string };
  qualifiedHandoff: { es: string; en: string };
  notQualifiedClose: { es: string; en: string };
};

export type SofiaTurnInput = {
  dealerName: string;
  latestMessage: string;
  priorFacts: SofiaFacts;
  turnCount: number;
  isFirstTurn?: boolean;
  language?: string;
  contactChannel?: string;
  pendingQuestion?: "has_trade_in" | "trade_in_financed" | "has_income_proof" | "first_time_buyer" | "purchase_timeline";
  lastResponse?: string;
  isAdvertisementMetadata?: boolean;
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

export function sofiaPolicyFromPolicyPack(policy: { sofia?: SofiaPolicy }): SofiaPolicy {
  return policy.sofia ?? DEFAULT_SOFIA_POLICY;
}

export class SofiaConversationEngine {
  constructor(private readonly policy: SofiaPolicy = DEFAULT_SOFIA_POLICY) {}

  withPolicy(policy?: SofiaPolicy): SofiaConversationEngine {
    return policy ? new SofiaConversationEngine(policy) : this;
  }

  processTurn(input: SofiaTurnInput): SofiaTurnResult {
    if (this.policy.knowledge?.id === "country_club_cars") {
      return processCountryClubTurn(input, this.policy, this.policy.knowledge);
    }
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

function processCountryClubTurn(input: SofiaTurnInput, policy: SofiaPolicy, knowledge: SofiaKnowledge): SofiaTurnResult {
  const cleanMessage = stripAdMetadata(input.latestMessage);
  if ((!cleanMessage || !/[\p{L}\p{N}]/u.test(cleanMessage) || input.isAdvertisementMetadata) && !input.mediaContext?.audioTranscriptionFailed) {
    return makeResult(input.priorFacts, classifyLead(input.priorFacts, policy), [], "none", hasCountryClubContactPath(input.priorFacts), false);
  }
  const extractedFacts = extractFacts(input.latestMessage, input.priorFacts, true, input.pendingQuestion);
  if (!extractedFacts.contact_name && isCountryClubStandaloneName(input.latestMessage, input.priorFacts)) {
    extractedFacts.contact_name = input.latestMessage.trim().replace(/[.!?]+$/, "");
    delete extractedFacts.vehicle_model_interest;
  }
  const facts = mergeFacts(input.priorFacts, factsFromMedia(input.mediaContext, true), extractedFacts);
  const vehicleCorrection = isCountryClubVehicleCorrection(cleanMessage);
  if (vehicleCorrection) {
    delete facts.vehicle_category;
    delete facts.vehicle_model_interest;
    delete facts.down_payment_push_target;
  }
  if (input.priorFacts.has_trade_in === false) {
    facts.has_trade_in = false;
    delete facts.trade_in_description;
  }
  applyCountryClubCategoryFromModel(facts, knowledge);
  const contactChannel = normalizeContactChannel(input.contactChannel);
  if (contactChannel) facts.contact_channel = contactChannel;
  const language = countryClubLanguage(input.language);
  const contactCaptured = hasCountryClubContactPath(facts);
  const hardRuleFailure = hasHardRuleFailure(facts);
  const leadLevel = classifyLead(facts, policy);
  const directAnswer = countryClubAnswer(input.latestMessage, facts, policy, knowledge, language);
  const acknowledgement = countryClubAcknowledgement(extractedFacts, facts, language, input.priorFacts);
  const firstTurn = input.isFirstTurn || (input.turnCount === 1 && Object.keys(input.priorFacts).length === 0);

  if (input.mediaContext?.audioTranscriptionFailed) {
    return makeResult(facts, leadLevel, [
      language === "en" ? "I could not hear you clearly. Could you repeat that, please?" : "No le escuché bien, ¿me lo repite, por favor?",
    ], "ask", contactCaptured, hardRuleFailure);
  }

  if (facts.purchase_timeline === "none" && input.priorFacts.purchase_timeline === undefined && /no estoy listo|not ready/i.test(cleanMessage)) {
    return makeResult(facts, "C", [knowledge.notQualifiedClose[language]], "follow_up", contactCaptured, false);
  }
  if (facts.purchase_timeline === "none" && input.priorFacts.purchase_timeline === undefined) {
    return makeResult(
      facts,
      leadLevel,
      [language === "en" ? "I understand, you are still looking." : "Entiendo, todavía está revisando opciones.", countryClubNoTimelineQuestion(policy, language)],
      "ask",
      contactCaptured,
      false,
    );
  }

  if (facts.handoff_completed && !directAnswer) {
    return makeResult(facts, leadLevel, [countryClubSafeExit(knowledge, language)], "follow_up", contactCaptured, hardRuleFailure);
  }

  const mediaResponse = countryClubMediaResponse(input, facts, language);
  if (mediaResponse) {
    const opening = firstTurn ? countryClubOpening(facts, knowledge, policy, language, directAnswer) : [];
    const question = countryClubNextQuestion(facts, input.contactChannel, policy, language);
    return makeResult(facts, leadLevel, [...opening, mediaResponse, question].filter(Boolean) as string[], "ask", contactCaptured, hardRuleFailure);
  }

  if (firstTurn) {
    const opening = countryClubOpening(facts, knowledge, policy, language, directAnswer);
    const question = facts.contact_name ? countryClubNextQuestion(facts, input.contactChannel, policy, language) : countryClubNameQuestion(language);
    return makeResult(facts, leadLevel, [...opening, question].filter(Boolean) as string[], "ask", contactCaptured, hardRuleFailure);
  }

  if (vehicleCorrection) {
    const correctionMessages = [
      language === "en" ? "You are right, I am sorry. We have not established the vehicle yet." : "Tiene toda la razón, disculpe. Todavía no hemos definido el vehículo.",
      language === "en" ? "Are you looking for a car, an SUV, or a truck?" : "¿Qué tipo de vehículo anda buscando: carro, SUV o troca?",
    ];
    return makeResult(facts, classifyLead(facts, policy), countryClubAvoidLiteralRepeat(correctionMessages, input.lastResponse, language), "ask", contactCaptured, false);
  }

  if (hardRuleFailure) {
    return makeResult(facts, "C", [acknowledgement ?? countryClubThanks(language), countryClubSafeExit(knowledge, language)], "follow_up", contactCaptured, true);
  }

  if (input.priorFacts.purchase_timeline === "none" && /^(?:no|nop|todav[ií]a no|no estoy listo|not yet|not right now)\b/.test(stripAdMetadata(input.latestMessage).trim().toLowerCase())) {
    return makeResult(facts, "C", [knowledge.notQualifiedClose[language]], "follow_up", contactCaptured, false);
  }

  const question = countryClubNextQuestion(facts, input.contactChannel, policy, language);
  if (question) {
    const belowFloor = countryClubBelowFloor(facts, policy);
    const firstPush = belowFloor && facts.down_payment_push_target !== countryClubMinimum(facts, policy);
    const categoryJustCaptured = Boolean(extractedFacts.vehicle_category && !input.priorFacts.vehicle_category);
    if (firstPush) facts.down_payment_push_target = countryClubMinimum(facts, policy);
    const messages = [
      directAnswer,
      acknowledgement,
      categoryJustCaptured ? countryClubCategoryFloorMessage(facts, policy, language) : undefined,
      firstPush ? countryClubBelowFloorMessage(facts, policy, language) : undefined,
      question,
    ].filter(Boolean) as string[];
    return makeResult(facts, leadLevel, countryClubAvoidLiteralRepeat(dedupeMessages(messages), input.lastResponse, language), "ask", contactCaptured, false);
  }

  if (leadLevel === "A" || leadLevel === "B") {
    facts.handoff_completed = true;
    return makeResult(facts, leadLevel, [countryClubQualifiedHandoff(knowledge, language, facts.contact_name)], "handoff", contactCaptured, false);
  }
  return makeResult(facts, leadLevel, countryClubAvoidLiteralRepeat([knowledge.notQualifiedClose[language]], input.lastResponse, language), "follow_up", contactCaptured, false);
}

function countryClubOpening(
  facts: SofiaFacts,
  knowledge: SofiaKnowledge,
  policy: SofiaPolicy,
  language: "es" | "en",
  directAnswer?: string,
): string[] {
  const greeting = language === "en"
    ? `Hi, this is Sofía with ${knowledge.dealer.name.replace(/[.!?]+$/, "")}.`
    : `Hola, soy Sofía de ${knowledge.dealer.name.replace(/[.!?]+$/, "")}.`;
  const vehicle = facts.vehicle_model_interest ?? (facts.vehicle_category ? displayCountryClubCategory(facts.vehicle_category, language) : undefined);
  const category = facts.vehicle_category ? countryClubMinimumForCategory(facts.vehicle_category, policy) : undefined;
  const vehicleLine = vehicle && category
    ? language === "en"
      ? `I see you are looking at ${vehicle}. We start at $${category.toLocaleString("en-US")} down for that category.`
      : `Veo que busca ${vehicle}. Trabajamos desde $${category.toLocaleString("en-US")} de enganche para esa categoría.`
    : undefined;
  return [greeting, vehicleLine, directAnswer].filter(Boolean) as string[];
}

function countryClubNextQuestion(
  facts: SofiaFacts,
  channel: string | undefined,
  policy: SofiaPolicy,
  language: "es" | "en",
): string | undefined {
  if (!facts.contact_name) return countryClubNameQuestion(language);
  if (!facts.vehicle_category && !facts.vehicle_model_interest) return language === "en" ? "What vehicle are you looking to finance?" : "¿Qué vehículo está buscando financiar?";
  if (!facts.vehicle_category && facts.vehicle_model_interest) return language === "en" ? "Would you describe that as a sedan, SUV, or truck?" : "¿Lo considera un sedán, una SUV o una troca?";
  if (facts.down_payment_declared === undefined) return language === "en" ? "How much would you have for the down payment?" : "¿Con cuánto contaría para el enganche?";
  if (facts.has_trade_in === undefined) return countryClubTradeInQuestion(facts, policy, language);
  if (facts.has_trade_in === true && !facts.trade_in_description) return language === "en" ? "What year and model is it?" : "¿De qué año y modelo es?";
  if (facts.first_time_buyer === undefined) return language === "en" ? "Have you financed a vehicle before, or would this be your first time?" : "¿Ha financiado alguna vez o sería su primera vez?";
  if (facts.purchase_timeline === undefined) return language === "en" ? "How soon are you looking to get into a vehicle?" : "¿En cuánto tiempo piensa tener el vehículo?";
  if (facts.purchase_timeline === "none") return countryClubNoTimelineQuestion(policy, language);
  if (facts.has_income_proof === undefined && facts.has_income_proof_document !== true) return language === "en" ? "Do you have pay stubs, bank statements, or an employer letter?" : "¿Cuenta con talones de pago, estados de cuenta o una carta del empleador?";
  const normalizedChannel = normalizeContactChannel(channel ?? facts.contact_channel);
  if ((normalizedChannel === "messenger" || normalizedChannel === "facebook" || normalizedChannel === "fb") && !facts.contact_value) {
    return language === "en" ? "May I have the best phone number for you?" : "¿Me comparte el mejor número de teléfono?";
  }
  return undefined;
}

function countryClubAvoidLiteralRepeat(messages: string[], lastResponse: string | undefined, language: "es" | "en"): string[] {
  const previous = lastResponse?.trim();
  if (!previous) return messages;
  const current = messages.join("\n").trim();
  if (current !== previous && !messages.some((message) => message.trim() === previous)) return messages;
  const last = messages.at(-1) ?? "";
  if (/con qui[eé]n tengo el gusto|may i have your name/i.test(last)) {
    return [...messages.slice(0, -1), language === "en" ? "Could you please confirm your name?" : "Disculpe, ¿me confirma su nombre?"];
  }
  if (/con cu[aá]nto.*enganche|how much.*down payment/i.test(last)) {
    return [...messages.slice(0, -1), language === "en" ? "What amount would you have available for the down payment?" : "¿Qué monto tendría disponible para el enganche?"];
  }
  if (/qu[eé] veh[ií]culo est[aá] buscando|what vehicle are you looking/i.test(last)) {
    return [...messages.slice(0, -1), language === "en" ? "To guide you better, what type of vehicle interests you?" : "Para orientarle mejor, ¿qué tipo de vehículo le interesa?"];
  }
  if (/qu[eé] tipo de veh[ií]culo|carro.*SUV.*troca|an SUV.*truck/i.test(last)) {
    return [...messages.slice(0, -1), language === "en" ? "Are you looking for a car, an SUV, or a truck?" : "¿Busca un carro, una SUV o una troca?"];
  }
  return [language === "en" ? "I am still here to help with the next detail." : "Sigo aquí para ayudarle con el siguiente dato."];
}

function countryClubAnswer(message: string, facts: SofiaFacts, policy: SofiaPolicy, knowledge: SofiaKnowledge, language: "es" | "en"): string | undefined {
  const normalized = stripAdMetadata(message).toLowerCase();
  if (/requisit|qué necesito|que necesito|document|what do i need|requirements/.test(normalized)) return knowledge.requirements[language];
  if (/dónde|donde|ubicación|ubicacion|horario|domingo|abierto|where are you|hours|open/.test(normalized)) {
    return language === "en"
      ? `${knowledge.dealer.address}. Our hours are ${knowledge.dealer.hours.en}.`
      : `Estamos en ${knowledge.dealer.address}. Nuestro horario es ${knowledge.dealer.hours.es}.`;
  }
  if (/mensualidad|mensualida|pago mensual|monthly payment/.test(normalized)) {
    return language === "en" ? "The monthly payment depends on financing; the advisor confirms the exact numbers." : "La mensualidad depende del financiamiento; el asesor confirma los números exactos.";
  }
  if (/licencia|license|itin/.test(normalized)) {
    return language === "en" ? "We can review options with an ITIN; the advisor confirms the exact requirements." : "Podemos revisar opciones con ITIN; el asesor confirma los requisitos exactos.";
  }
  const model = facts.vehicle_model_interest;
  if (model && /tienen|tienen el|manejan|disponib|do you have|carry|available/.test(normalized)) {
    const category = facts.vehicle_category ? countryClubMinimumForCategory(facts.vehicle_category, policy) : undefined;
    return language === "en"
      ? `Yes, we can help with ${model}${category ? `; that category starts at $${category.toLocaleString("en-US")} down.` : "."}`
      : `Sí, le ayudamos con ${model}${category ? `; esa categoría trabaja desde $${category.toLocaleString("en-US")} de enganche.` : "."}`;
  }
  return undefined;
}

function isCountryClubVehicleCorrection(message: string): boolean {
  const normalized = normalizeClientText(message).replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return /enganche de qu[eé]/.test(normalized) ||
    /no (?:te )?he dicho (?:qu[eé] )?(?:auto|carro|veh[ií]culo|suv|troca)/.test(normalized) ||
    /no (?:te )?dije (?:qu[eé] )?(?:auto|carro|veh[ií]culo|suv|troca)/.test(normalized);
}

function countryClubAcknowledgement(newFacts: SofiaFacts, facts: SofiaFacts, language: "es" | "en", priorFacts: SofiaFacts): string {
  if (newFacts.contact_name) {
    return priorFacts.contact_name === facts.contact_name
      ? language === "en" ? `Thanks, ${facts.contact_name}.` : `Claro, ${facts.contact_name}.`
      : language === "en" ? `Nice to meet you, ${facts.contact_name}.` : `Mucho gusto, ${facts.contact_name}.`;
  }
  if (newFacts.down_payment_declared !== undefined) return language === "en" ? `Thank you. I have noted $${newFacts.down_payment_declared.toLocaleString("en-US")} for the down payment.` : `Gracias. Anoto $${newFacts.down_payment_declared.toLocaleString("en-US")} para el enganche.`;
  if (newFacts.vehicle_model_interest || newFacts.vehicle_category) {
    const vehicle = newFacts.vehicle_model_interest ?? displayCountryClubCategory(facts.vehicle_category ?? "vehicle", language);
    return language === "en" ? `Got it, you are looking at ${vehicle}.` : `Perfecto, entonces busca ${vehicle}.`;
  }
  if (newFacts.has_trade_in === false) return language === "en" ? "Understood. We will continue without a trade-in." : "Entendido. Seguimos sin vehículo de parte de pago.";
  if (newFacts.has_trade_in === true) return language === "en" ? "Thank you. That trade-in can help with the down payment." : "Gracias. Ese vehículo puede ayudar con el enganche.";
  if (newFacts.first_time_buyer !== undefined) return language === "en" ? "Thank you for sharing that." : "Gracias por compartirlo.";
  if (newFacts.purchase_timeline) return language === "en" ? "Perfect, thank you." : "Perfecto, gracias.";
  if (newFacts.has_income_proof === true || newFacts.has_income_proof_document === true) return language === "en" ? "Perfect, thank you." : "Perfecto, gracias.";
  return language === "en" ? "Got it, thanks." : "Entiendo, gracias.";
}

function countryClubCategoryFloorMessage(facts: SofiaFacts, policy: SofiaPolicy, language: "es" | "en"): string {
  const minimum = countryClubMinimum(facts, policy).toLocaleString("en-US");
  const category = displayCountryClubCategory(facts.vehicle_category ?? "vehicle", language);
  return language === "en"
    ? `For ${category}, we usually start at $${minimum} down.`
    : `Para ${category}, normalmente trabajamos desde $${minimum} de enganche.`;
}

function countryClubTradeInQuestion(facts: SofiaFacts, policy: SofiaPolicy, language: "es" | "en"): string {
  const reachesFloor = !countryClubBelowFloor(facts, policy);
  return reachesFloor
    ? language === "en" ? "Do you have a vehicle to trade in?" : "¿Tiene un vehículo para dar de parte de pago?"
    : language === "en" ? "Do you have a vehicle to trade in? That would help with your down payment." : "¿Tiene un carro para dar de parte de pago? Eso le ayudaría con su enganche.";
}

function countryClubBelowFloor(facts: SofiaFacts, policy: SofiaPolicy): boolean {
  const amount = facts.down_payment_accepted ?? facts.down_payment_declared;
  return amount !== undefined && amount < countryClubMinimum(facts, policy);
}

function countryClubMinimum(facts: SofiaFacts, policy: SofiaPolicy): number {
  const range = rangeFor(facts.vehicle_category, policy);
  return range.min;
}

function countryClubMinimumForCategory(category: string, policy: SofiaPolicy): number {
  return rangeFor(category, policy).min;
}

function countryClubBelowFloorMessage(facts: SofiaFacts, policy: SofiaPolicy, language: "es" | "en"): string {
  const minimum = countryClubMinimum(facts, policy).toLocaleString("en-US");
  return language === "en"
    ? `We work with what you have, but you do need to reach $${minimum}.`
    : `Trabajamos con lo que tenga, pero es necesario llegar a $${minimum}.`;
}

function countryClubNameQuestion(language: "es" | "en"): string {
  return language === "en" ? "May I have your name, please?" : "¿Con quién tengo el gusto?";
}

function countryClubNoTimelineQuestion(policy: SofiaPolicy, language: "es" | "en"): string {
  return policy.knowledge?.noTimeline[language] ?? (language === "en" ? "Would this week or this month work for you?" : "¿Le interesaría venir esta semana o este mes?");
}

function countryClubSafeExit(knowledge: SofiaKnowledge, language: "es" | "en"): string {
  return knowledge.safeExit[language];
}

function countryClubQualifiedHandoff(knowledge: SofiaKnowledge, language: "es" | "en", contactName?: string): string {
  return knowledge.qualifiedHandoff[language].replace("{name}", contactName ?? "");
}

function countryClubThanks(language: "es" | "en"): string {
  return language === "en" ? "Thank you for the information." : "Gracias por la información.";
}

function countryClubMediaResponse(input: SofiaTurnInput, _facts: SofiaFacts, language: "es" | "en"): string | undefined {
  const classifications = input.mediaContext?.imageClassifications ?? [];
  if (classifications.length === 0) return undefined;
  if (classifications.includes("vehicle_photo")) {
    return language === "en"
      ? "Thank you. I will pass the photo to the advisor to review."
      : "Gracias. Se la paso al asesor para que la revise.";
  }
  if (classifications.includes("identity_document") || classifications.includes("income_proof_document")) {
    return language === "en"
      ? "Thank you. I will pass it to the advisor to review."
      : "Gracias. Se la paso al asesor para que la revise.";
  }
  return language === "en"
    ? "Thank you for sharing it. I will have the advisor review it."
    : "Gracias por compartirla. Se la paso al asesor para que la revise.";
}

function dedupeMessages(messages: string[]): string[] {
  return messages.filter((message, index) => messages.indexOf(message) === index);
}

function classifyCountryClubLead(facts: SofiaFacts, policy: SofiaPolicy): SofiaLeadLevel {
  if (!hasCountryClubContactPath(facts)) return "C";
  if (hasHardRuleFailure(facts) || facts.purchase_timeline === "none") return "C";
  const minimum = countryClubMinimum(facts, policy);
  const amount = facts.down_payment_accepted ?? facts.down_payment_declared;
  const reachesFloor = amount !== undefined && amount >= minimum;
  const timelineSupportsA = facts.purchase_timeline === "this_week" || facts.purchase_timeline === "this_month";
  const hasIncomeProof = facts.has_income_proof === true || facts.has_income_proof_document === true;
  if (reachesFloor && hasIncomeProof && timelineSupportsA) return "A";
  if (facts.has_trade_in === true || facts.has_co_signer === true || facts.first_time_buyer === false || reachesFloor) return "B";
  return "C";
}

function applyCountryClubCategoryFromModel(facts: SofiaFacts, knowledge: SofiaKnowledge): void {
  if (facts.vehicle_category || !facts.vehicle_model_interest) return;
  const normalized = facts.vehicle_model_interest.toLowerCase();
  const found = Object.entries(knowledge.modelCategories).find(([model]) => normalized.includes(model));
  if (found) facts.vehicle_category = found[1];
}

function displayCountryClubCategory(category: string, language: "es" | "en"): string {
  const normalized = category.trim().toLowerCase();
  if (language === "en") return normalized === "work truck" ? "a truck" : normalized === "suv" ? "an SUV" : normalized === "sedan" ? "a sedan" : normalized === "van" ? "a minivan" : category;
  return normalized === "work truck" ? "una troca" : normalized === "suv" ? "una SUV" : normalized === "sedan" ? "un sedán" : normalized === "van" ? "una minivan" : category;
}

function countryClubLanguage(language: string | undefined): "es" | "en" {
  return language?.trim().toLowerCase().startsWith("en") ? "en" : "es";
}

function makeResult(
  facts: SofiaFacts,
  leadLevel: SofiaLeadLevel,
  messages: string[],
  nextStep: SofiaTurnResult["nextStep"],
  contactCaptured: boolean,
  hardRuleFailure: boolean,
): SofiaTurnResult {
  return { facts, leadLevel, ...(messages.length > 0 ? { response: messages.join("\n") } : {}), nextStep, contactCaptured, hardRuleFailure };
}

function hasHardRuleFailure(facts: SofiaFacts): boolean {
  return (facts.employment_months !== undefined && facts.employment_months < 6) || facts.has_income_proof === false;
}

function hasVerifiedHardRules(facts: SofiaFacts): boolean {
  return facts.employment_months !== undefined && facts.employment_months >= 6 && (facts.has_income_proof === true || facts.has_income_proof_document === true);
}

export function classifyLead(facts: SofiaFacts, policy: SofiaPolicy = DEFAULT_SOFIA_POLICY): SofiaLeadLevel {
  if (policy.knowledge?.id === "country_club_cars") return classifyCountryClubLead(facts, policy);
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

function hasCountryClubContactPath(facts: SofiaFacts): boolean {
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

function factsFromMedia(media: SofiaTurnInput["mediaContext"], countryClub = false): SofiaFacts {
  const classifications = media?.imageClassifications ?? [];
  const vehicleCategory = media?.imageVehicleCategories?.find((category) => category.trim());
  return {
    ...(vehicleCategory ? { vehicle_category: vehicleCategory } : {}),
    ...(classifications.includes("identity_document") ? { has_id_document: true } : {}),
    ...(classifications.includes("income_proof_document") ? { has_income_proof_document: true } : {}),
    ...(!countryClub && classifications.includes("vehicle_photo") ? { has_trade_in: true } : {}),
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

function extractFacts(message: string, priorFacts: SofiaFacts, countryClub = false, pendingQuestion?: SofiaTurnInput["pendingQuestion"]): SofiaFacts {
  const userMessage = stripAdMetadata(message);
  const normalized = normalizeClientText(userMessage);
  const facts: SofiaFacts = {};
  const phone = userMessage.match(/(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/);
  const normalizedWithoutPhone = phone ? normalized.replace(phone[0].toLowerCase(), " ") : normalized;
  const contactName = extractContactName(userMessage);
  if (contactName) facts.contact_name = contactName;
  const expectsDownPayment = Boolean(
    !priorFacts.down_payment_declared &&
    (priorFacts.vehicle_category || priorFacts.vehicle_model_interest),
  );
  const numericValue = countryClub && isStandaloneVehicleYear(normalizedWithoutPhone)
    ? undefined
    : extractDownPaymentNumber(normalizedWithoutPhone, expectsDownPayment);
  const wordAmount = normalizedWithoutPhone.match(SPANISH_THOUSANDS_AMOUNT_PATTERN);
  const wordValue = wordAmount && (expectsDownPayment || hasDownPaymentContext(normalizedWithoutPhone))
    ? parseSpanishAmount(wordAmount[0])
    : undefined;
  const shorthandAmount = normalizedWithoutPhone.match(/\b(\d+(?:[.,]\d+)?)\s*k\b/i);
  const shorthandValue = shorthandAmount ? Number(shorthandAmount[1].replace(",", ".")) * 1000 : undefined;
  const value = numericValue ?? shorthandValue ?? wordValue;
  const ambiguousAmount = /\bentre\b[\s\S]*\b(?:y|o)\b[\s\S]*\b(?:mil|\d)\b/i.test(normalizedWithoutPhone);
  if (value !== undefined && Number.isFinite(value) && value >= 100 && value <= 50_000 && !ambiguousAmount) facts.down_payment_declared = value;
  if (!priorFacts.vehicle_category && !isGenericVehicleFinancingCall(normalized)) {
    if (/\b(?:suv|suvcita|camioneta\s+(?:grande|familiar))\b/.test(normalized)) facts.vehicle_category = "suv";
    else if (/\b(?:sedan|carro|carrito|cochecito|auto)\b/.test(normalized)) facts.vehicle_category = "sedan";
    else if (/\b(?:troca|troka|trocka|trokita|troque|camioneta\s+de\s+trabajo|camion|truck|pickup|trabajo)\b/.test(normalized)) facts.vehicle_category = "work truck";
    else if (/\b(?:van|vanesita|minivan)\b/.test(normalized)) facts.vehicle_category = "van";
    if (/\bno s[eé] si\b[\s\S]*\b(?:carro|auto|suv|troca)\b/.test(normalized)) delete facts.vehicle_category;
  }
  if (countryClub && isStandaloneVehicleYear(normalizedWithoutPhone) && priorFacts.vehicle_model_interest) facts.vehicle_year = Number(normalizedWithoutPhone);
  const vehicleModel = contactName && !hasVehicleInterestCue(userMessage)
    ? undefined
    : extractVehicleModelInterest(userMessage, priorFacts, normalizedWithoutPhone, countryClub);
  if (vehicleModel) facts.vehicle_model_interest = vehicleModel;
  if (/\bpara m[ií] mismo\b|\bsolo para m[ií]\b|\bpara m[ií]\b(?!\s+familia)/.test(normalized)) facts.vehicle_use = "solo";
  else if (/\bpara la familia|para mi familia|familia\b/.test(normalized)) facts.vehicle_use = "familia";
  if (!/no s[eé] si/.test(normalized) && (/\b(no|ninguno|no tengo)\b.*\b(trade|carro|veh[ií]culo)\b|\bno trade\b/.test(normalized) || (pendingQuestion === "has_trade_in" && /^(?:no|nop)$/i.test(normalized)))) facts.has_trade_in = false;
  else if (/\b(trade|parte de pago|dar mi carro|tengo un carro|\w+\s+para dar)\b/.test(normalized)) {
    facts.has_trade_in = true;
    facts.trade_in_description = message.trim();
  }
  if (pendingQuestion === "has_trade_in" && /^(?:s[ií]|yes|claro)$/i.test(normalized)) facts.has_trade_in = true;
  const hasTradeInContext = facts.has_trade_in === true || priorFacts.has_trade_in === true;
  if (hasTradeInContext && /\b(todav[ií]a(?:\s+\w+)?\s+debo|a[uú]n debo|sigo pagando|financiado|payments?)\b/.test(normalized)) facts.trade_in_financed = true;
  else if (hasTradeInContext && /\b(pagado|no debo|libre)\b/.test(normalized)) facts.trade_in_financed = false;
  const neverFinanced = /\b(?:nunca|never)\b.{0,24}\b(?:financiado|financ(?:e|é|ed)|financiao)\b/.test(normalized);
  const financedBefore = /\b(?:no es mi primera vez|not my first time|i have financed before|have financed before|already financed|ya he financiado|he comprado a cr[eé]dito|ya compr[eé] carro)\b/.test(normalized) || /(?:financie|financié)(?:\s+antes)?(?![a-záéíóúüñ])/i.test(normalized);
  if (financedBefore && !neverFinanced) facts.first_time_buyer = false;
  else if (neverFinanced || /\b(primera vez|primera compra|first time|first purchase)\b/.test(normalized)) facts.first_time_buyer = true;
  const months = normalized.match(/(\d+)\s*(?:meses?|months?)/);
  const years = normalized.match(/(\d+(?:[.,]\d+)?)\s*(?:a[nñ]os?|years?)/);
  if (months) facts.employment_months = Number(months[1]);
  else if (years) facts.employment_months = Math.round(Number(years[1].replace(",", ".")) * 12);
  if (/\b(esta semana|este mes|this week|this month)\b/.test(normalized)) facts.purchase_timeline = /this week|esta semana/.test(normalized) ? "this_week" : "this_month";
  else if (/\b(pronto|soon)\b/.test(normalized)) facts.purchase_timeline = "none";
  else if (/\b(solo estoy mirando|s[oó]lo estoy mirando|sin fecha|no estoy listo|just looking|no timeline)\b/.test(normalized)) facts.purchase_timeline = "none";
  if (/\b(co[- ]?signer|cosigner|codeudor)\b/.test(normalized)) facts.has_co_signer = true;
  const hasIncomeProof = hasIncomeProofMention(normalized);
  const usableIncomeProof = hasUsableIncomeProof(normalized);
  const deniesIncomeProof = /\b(no tengo|sin|do not have|don't have|dont have)\b.*\b(comprobantes?|estados de cuenta|talones?|carta del empleador|carta laboral|pay ?stubs?|bank statements?|employer letter)\b/.test(normalized);
  if (usableIncomeProof || (pendingQuestion === "has_income_proof" && /^(?:s[ií]|yes|claro)$/i.test(normalized))) facts.has_income_proof = true;
  else if (deniesIncomeProof) facts.has_income_proof = false;
  else if (pendingQuestion === "has_income_proof" && /^(?:no|nop)$/i.test(normalized)) facts.has_income_proof = false;
  else if (hasIncomeProof) facts.has_income_proof = true;
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

function normalizeClientText(message: string): string {
  return stripAdMetadata(message)
    .toLowerCase()
    .replace(/\bq\b/g, "que")
    .replace(/\bkuenta(s)?\b/g, "cuenta$1")
    .replace(/\bkiero\b/g, "quiero")
    .replace(/\bpoko\b/g, "poco")
    .replace(/\bfinanciao\b/g, "financiado")
    .replace(/\bpal\b/g, "para el")
    .replace(/\bpa\b/g, "para");
}

function isStandaloneVehicleYear(message: string): boolean {
  return /^(?:19|20)\d{2}[.!?]?$/.test(message.trim());
}

function hasIncomeProofMention(message: string): boolean {
  return /\b(?:comprobantes?|estados de cuenta|talones?|carta del empleador|carta laboral|pay ?stubs?|bank statements?|employer letter)\b/.test(message);
}

function hasUsableIncomeProof(message: string): boolean {
  const proofPatterns = [
    /comprobantes?/,
    /estados de cuenta/,
    /talones?/,
    /carta del empleador/,
    /carta laboral/,
    /pay ?stubs?/,
    /bank statements?/,
    /employer letter/,
  ];
  return proofPatterns.some((proofPattern) => new RegExp(`(?:\\b(?:sí|si|cuento con|cuenta con|have|has)\\b|(?<!\\bno )\\btengo\\b)[^.!?]{0,32}${proofPattern.source}`).test(message));
}

function extractDownPaymentNumber(message: string, expectsDownPayment: boolean): number | undefined {
  const matches = [...message.matchAll(/(?:\$|usd\s*)?(\d{1,3}(?:[,.]\d{3})+|\d{3,5})(?:\s*(?:d[oó]lares|usd))?/gi)];
  const explicit = matches.find((match) => {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    const before = message.slice(Math.max(0, start - 32), start);
    const after = message.slice(end, Math.min(message.length, end + 24));
    return /^\s*(?:\$|usd\b)/i.test(match[0]) ||
      /(?:\$|\busd\b|d[oó]lares?|enganche|anticipo|inicial|parte de pago|down(?:\s+payment)?|deposit|cuento con|\b(?:con|with)\b|tengo|dispongo|ahorrad[oa])\s*$/i.test(before) ||
      /^\s*(?:d[oó]lares?|\busd\b|down(?:\s+payment)?|deposit|de\s+(?:el\s+)?enganche|para\s+(?:el\s+)?enganche)\b/i.test(after);
  });
  const selected = explicit ?? (
    expectsDownPayment && matches.length === 1 &&
    (/^(?:(?:con|with|tengo|cuento con|dispongo de|puedo dar|son)\s+)?(?:\$\s*)?\d[\d,.]*(?:\s*(?:d[oó]lares|usd|down(?:\s+payment)?|deposit))?(?:\s+como\s+down(?:\s+payment)?)?[.!?]?$/i.test(message.trim()) || /\bcomo\b[\s\S]*\bm[aá]s\s+o\s+menos\b/i.test(message))
      ? matches[0]
      : undefined
  );
  return selected ? Number(selected[1].replace(/[,.]/g, "")) : undefined;
}

function hasDownPaymentContext(message: string): boolean {
  return /\$|\busd\b|d[oó]lares?|enganche|anticipo|inicial|parte de pago|down(?:\s+payment)?|deposit|cuento con|\b(?:con|with)\b|tengo|dispongo|ahorrad[oa]/i.test(message);
}

function extractVehicleModelInterest(message: string, priorFacts: SofiaFacts, normalized: string, countryClub = false): string | undefined {
  if (priorFacts.vehicle_model_interest) return undefined;
  if (isGenericVehicleFinancingCall(normalized)) return undefined;
  const explicit = message.match(/\b(?:quiero|busco|quisiera|necesito|me interesa|interested in|estoy buscando|looking for|ando buscando)\s+(?:(?:un|una|el|la|a)\s+)?([\s\S]+?)(?:\s+(?:para|con|porque|y|so|because)\b[\s\S]*)?$/i);
  const candidate = explicit?.[1]?.trim() ?? (
    !priorFacts.vehicle_category && !priorFacts.vehicle_model_interest &&
    normalized.split(/\s+/).length <= 5 &&
    !/[¿?]/.test(message) &&
    !/\b(?:hola|gracias|informaci[oó]n|ayuda|quiero(?:\s+m[aá]s)?|busco|buscando|looking|requisit|d[oó]nde|donde|cu[aá]nto|horario|mensualidad|document|piden|necesito|buenas|buenos d[ií]as|buenas tardes|buenas noches)\b/i.test(normalized) &&
    !/^(?:si|sí|no|ok|okay|claro|un carro|un auto|una camioneta|una suv|un sedan)$/i.test(normalized)
      ? message.trim()
      : undefined
  );
  const countryClubUnknownCandidate = countryClub && !candidate
    ? message.match(/\b(?:de|marca)\s+([A-Za-z0-9-]+)/i)?.[1] ?? (/\bmodelo\b[\s\S]*\btabla\b/i.test(message) ? "modelo desconocido" : undefined)
    : undefined;
  const selectedCandidate = candidate ?? countryClubUnknownCandidate;
  if (!selectedCandidate) return undefined;
  const cleaned = selectedCandidate
    .split(/[?!.:,]/, 1)[0]
    .replace(countryClub ? /\b(?:19|20)\d{2}\b.*$/i : /$^/, "")
    .replace(/[,:;]+$/, "")
    .replace(/\b(?:usado|usada|de segunda mano)\b/gi, "")
    .replace(/^(?:un|una|el|la)\s+/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /^(?:suv|suvcita|camioneta|camioneta\s+(?:grande|familiar)|sedan|carro|carrito|cochecito|auto|troca|troka|trocka|trokita|troque|camion|truck|pickup|van|vanesita|minivan)(?:\s+(?:barato|barata|usado|usada|familiar|grande))?$/i.test(cleaned) || /^(?:m[aá]s\s+informaci[oó]n|informaci[oó]n|ayuda)$/i.test(cleaned)) return undefined;
  return cleaned;
}

function isCountryClubStandaloneName(message: string, priorFacts: SofiaFacts): boolean {
  const trimmed = message.trim();
  if (priorFacts.contact_name || !trimmed || trimmed.length > 40) return false;
  if (!priorFacts.vehicle_category && !priorFacts.vehicle_model_interest) return false;
  if (/^(?:sí|si|yes|no|ok|okay|claro|gracias|thanks|hola)$/i.test(trimmed)) return false;
  return /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:[\s-]+[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)?$/.test(trimmed);
}

function extractContactName(message: string): string | undefined {
  const token = "[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:-[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+)?";
  const nameToken = `(?!(?:y|and|como|est[aá]|busco|quiero|tengo|para|con|de|mucho|gusto)\\b)${token}`;
  const name = `(${nameToken}(?:\\s+${nameToken}){0,2})`;
  const patterns = [
    new RegExp(`^\\s*(?:soy|me llamo|mi nombre es|my name is|i am(?!\\s+(?:interested|looking)\\b))\\s+(?:el\\s+señor\\s+|la\\s+señora\\s+)?${name}(?=\\s*(?:,|\\.|!|\\?|$|\\b(?:y|and|quiero|busco|i|i'm)\\b))`, "i"),
    new RegExp(`^\\s*con\\s+${name}(?=\\s*(?:,|\\.|!|\\?|$|\\bcomo\\b|\\bmucho\\s+gusto\\b))`, "i"),
    new RegExp(`^\\s*de\\s+parte\\s+de\\s+${name}(?=\\s*(?:,|\\.|!|\\?|$))`, "i"),
    new RegExp(`^\\s*habla\\s+con\\s+${name}(?=\\s*(?:,|\\.|!|\\?|$))`, "i"),
    new RegExp(`^\\s*${name},?\\s+(?:mucho\\s+gusto|como\\s+est[aá])\\s*[.!?]*$`, "i"),
  ];
  for (const pattern of patterns) {
    const match = message.trim().match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate && isValidContactName(candidate)) return candidate;
  }
  return undefined;
}

function isValidContactName(candidate: string): boolean {
  const normalized = candidate.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (/\b(?:con|de|para|por|como|esta|est[aá]|soy|habla|busco|quiero|tengo|mucho|gusto|down|payment|deposit|enganche|suv|troca|troka|trokita|truck|pickup|carro|auto|camioneta)\b/.test(normalized)) return false;
  if (SPANISH_NUMBER_WORDS.some((word) => new RegExp(`\\b${word}\\b`).test(normalized))) return false;
  return /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+(?:[-\s][A-Za-zÁÉÍÓÚÜÑáéíóúüñ]+){0,2}$/.test(candidate);
}

function isGenericVehicleFinancingCall(normalized: string): boolean {
  const clean = normalized.replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
  return /^(?:quiero|busco|quisiera|necesito) (?:financiar|comprar) (?:un|una) (?:auto|carro|veh[ií]culo)$/.test(clean) ||
    /^(?:un|una) (?:auto|carro|veh[ií]culo)$/.test(clean);
}

function hasVehicleInterestCue(message: string): boolean {
  return /\b(?:quiero|busco|quisiera|necesito|me interesa|estoy buscando|ando buscando|looking for|interested in)\b/i.test(message);
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
