require("dotenv/config");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const { SofiaConversationEngine } = require("../dist/modules/decisions/domain/sofia-conversation");
const { ConversationAiService } = require("../dist/modules/control/application/conversation-ai.service");
const { OpenAICompatibleConversationalModel } = require("../dist/features/ghl-oauth/infrastructure/ghl/conversational-model.adapter");
const policy = require("../policies/country_club_cars_v8.json");

const apiKey = String(process.env.CONVERSATIONAL_MODEL_API_KEY || "").trim();
const aiEnabled = /^(1|true|yes)$/i.test(String(process.env.CONVERSATIONAL_AI_ENABLED || ""));
const sendEnabled = /^(1|true|yes)$/i.test(String(process.env.CONVERSATIONAL_AI_SEND_ENABLED || ""));
assert.ok(aiEnabled, "CONVERSATIONAL_AI_ENABLED must be true for the real Spanish extraction test");
assert.ok(apiKey, "CONVERSATIONAL_MODEL_API_KEY is missing");
assert.equal(sendEnabled, false, "Spanish extraction test refuses to run with automatic sending enabled");

const scenarios = [
  { id: "01-combinado-en-un-mensaje", channel: "WhatsApp", turns: ["Soy Luis, busco una troca y tengo dos mil de enganche"], expected: [{ contact_name: "Luis", vehicle_category: "work truck", down_payment_declared: 2000 }] },
  { id: "02-numero-en-letras", channel: "WhatsApp", turns: ["Busco Corolla. Tengo mil quinientos para el enganche"], expected: [{ vehicle_model_interest: "Corolla", vehicle_category: "sedan", down_payment_declared: 1500 }] },
  { id: "03-ortografia-suelta", channel: "WhatsApp", turns: ["busco una corrola, tengo quinientos de enganshe"], expected: [{ vehicle_model_interest: "Corolla", vehicle_category: "sedan", down_payment_declared: 500 }] },
  { id: "04-spanglish-y-negacion", channel: "WhatsApp", turns: ["Soy Ana, tengo un down de 1500, no trade y busco una troca"], expected: [{ contact_name: "Ana", vehicle_category: "work truck", down_payment_declared: 1500, has_trade_in: false }] },
  { id: "05-fuera-de-orden", channel: "WhatsApp", turns: ["dos mil para el enganche", "busco una Tacoma", "soy Roberto"], expected: [{ down_payment_declared: 2000 }, { vehicle_model_interest: "Tacoma", vehicle_category: "work truck" }, { contact_name: "Roberto" }] },
  { id: "06-negacion-con-correccion", channel: "WhatsApp", turns: ["Hola", "no tengo talones pero sí carta del trabajo", "busco un Camry"], expected: [{}, { has_income_proof: true }, { vehicle_model_interest: "Camry", vehicle_category: "sedan" }] },
  { id: "07-correccion-de-monto", channel: "WhatsApp", turns: ["Busco Corolla y tengo $1500", "dije $1500, mejor $2000"], expected: [{ vehicle_model_interest: "Corolla", vehicle_category: "sedan", down_payment_declared: 1500 }, { down_payment_declared: 2000 }] },
  { id: "08-datos-embebidos-y-marca", channel: "Messenger", turns: ["Soy Marta, busco una tayota corrola y cuento con dos mil"], expected: [{ contact_name: "Marta", vehicle_model_interest: "Toyota Corolla", vehicle_category: "sedan", down_payment_declared: 2000 }] },
];

const objectiveOrder = [
  "contact_name", "vehicle_model_interest", "vehicle_category", "down_payment_declared", "has_trade_in",
  "first_time_buyer", "purchase_timeline", "has_income_proof", "contact_value",
];

function pendingObjectives(facts, channel) {
  return objectiveOrder.filter((objective) => {
    if (objective === "contact_value") return /messenger|facebook|fb/i.test(channel) && !facts.contact_value;
    if (objective === "vehicle_model_interest") return !facts.vehicle_model_interest && !facts.vehicle_category;
    if (objective === "vehicle_category") return !facts.vehicle_category && !facts.vehicle_model_interest;
    return facts[objective] === undefined;
  });
}

function comparable(value) {
  return String(value ?? "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[_-]/g, " ").replace(/\bcorrola\b/g, "corolla").replace(/\btayota\b/g, "toyota").replace(/\s+/g, " ").trim();
}

function matchedFields(actual, expected) {
  return Object.entries(expected).filter(([key, value]) => comparable(actual[key]) === comparable(value)).map(([key]) => key);
}

function questionObjective(response) {
  const questions = String(response || "").match(/[^?]*\?/g) || [];
  const question = (questions.at(-1) || "").split("\n").at(-1).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (!question) return "none";
  if (/nombre|gusto|name/.test(question)) return "contact_name";
  if (/telefono|numero|phone|number/.test(question)) return "contact_value";
  if (/parte de pago|trade|carro para/.test(question)) return "has_trade_in";
  if (/sedan|suv|troca|truck|tipo/.test(question)) return "vehicle_category";
  if (/vehiculo|carro|modelo|auto|vehicle/.test(question)) return "vehicle_model_interest";
  if (/enganche|down|monto|cuanto/.test(question)) return "down_payment_declared";
  if (/financ|primera vez/.test(question)) return "first_time_buyer";
  if (/tiempo|semana|mes|soon|when/.test(question)) return "purchase_timeline";
  if (/talones|comprobantes|carta|estados|pay stubs|income/.test(question)) return "has_income_proof";
  return "unknown";
}

function nextObjective(facts, channel) {
  if (!facts.contact_name) return "contact_name";
  if (!facts.vehicle_category && !facts.vehicle_model_interest) return "vehicle_model_interest";
  if (facts.down_payment_declared === undefined) return "down_payment_declared";
  if (facts.has_trade_in === undefined) return "has_trade_in";
  if (facts.first_time_buyer === undefined) return "first_time_buyer";
  if (facts.purchase_timeline === undefined || facts.purchase_timeline === "none") return facts.purchase_timeline === "none" ? "purchase_timeline" : "purchase_timeline";
  if (facts.has_income_proof === undefined) return "has_income_proof";
  if (/messenger|facebook|fb/i.test(channel) && !facts.contact_value) return "contact_value";
  return "none";
}

function repeatedQuestion(response, ledgerFacts) {
  const current = questionObjective(response);
  if (current === "none" || current === "unknown") return false;
  return ledgerFacts[current] !== undefined && current !== "contact_value";
}

async function runScenario(scenario, records) {
  const engine = new SofiaConversationEngine(policy.sofia);
  const service = new ConversationAiService(model, { save: async (record) => records.push(record) });
  let facts = {};
  let previous;
  const transcript = [];
  const turns = [];
  for (let index = 0; index < scenario.turns.length; index += 1) {
    const latestMessage = scenario.turns[index];
    const result = await service.process({
      tenantId: "local-country-club-extraction-v3",
      contactId: scenario.id,
      latestMessage,
      transcript,
      channel: scenario.channel,
      language: "es",
      dealerName: "Country Club Cars Inc.",
      priorFacts: facts,
      missingObjectives: pendingObjectives(facts, scenario.channel),
      ruleTurn: (candidateFacts) => engine.processTurn({
        dealerName: "Country Club Cars Inc.", latestMessage, priorFacts: candidateFacts,
        contactChannel: scenario.channel, language: "es", turnCount: index + 1,
        isFirstTurn: index === 0, lastResponse: previous,
      }),
    });
    const expected = scenario.expected[index] || {};
    const modelMatched = matchedFields(result.modelFacts, expected);
    const ledgerMatched = matchedFields(result.ruleResult.facts, expected);
    const ledgerCaptured = ledgerMatched.length === Object.keys(expected).length;
    const modelCaptured = modelMatched.length === Object.keys(expected).length;
    const nextExpected = nextObjective(result.ruleResult.facts, scenario.channel);
    const nextActual = questionObjective(result.ruleResult.response);
    const nextQuestionCorrect = nextActual === nextExpected || (nextExpected === "none" && result.ruleResult.nextStep !== "ask");
    const repeated = repeatedQuestion(result.ruleResult.response, result.ruleResult.facts);
    turns.push({
      message: latestMessage,
      expected,
      modelFacts: result.modelFacts,
      ledgerFacts: result.ruleResult.facts,
      response: result.ruleResult.response || "(sin respuesta)",
      lead: result.ruleResult.leadLevel,
      next: result.ruleResult.nextStep,
      modelCaptured,
      ledgerCaptured,
      modelMatched,
      ledgerMatched,
      nextExpected,
      nextActual,
      nextQuestionCorrect,
      repeatedQuestion: repeated,
      extractionSucceeded: result.extractionSucceeded,
      extractionIssues: result.extractionIssues,
      responseSource: result.responseSource,
    });
    facts = result.ruleResult.facts;
    if (result.ruleResult.response) transcript.push({ direction: "outbound", content: result.ruleResult.response });
    transcript.push({ direction: "inbound", content: latestMessage });
    previous = result.ruleResult.response;
  }
  return { id: scenario.id, channel: scenario.channel, turns };
}

const model = new OpenAICompatibleConversationalModel(
  process.env.CONVERSATIONAL_MODEL_BASE_URL || "https://api.openai.com/v1",
  apiKey,
  process.env.CONVERSATIONAL_EXTRACTION_MODEL || "gpt-5.6-luna",
  process.env.CONVERSATIONAL_DRAFTING_MODEL || "not-used-deterministic-rule",
  Number(process.env.CONVERSATIONAL_MODEL_TIMEOUT_MS || 20_000),
);

async function main() {
  const records = [];
  const startedAt = Date.now();
  const results = await Promise.all(scenarios.map((scenario) => runScenario(scenario, records)));
  const lines = [];
  const metrics = { expectedFields: 0, modelCapturedFields: 0, ledgerCapturedFields: 0, nextQuestionChecks: 0, nextQuestionCorrect: 0, repeatedQuestionFailures: 0 };
  for (const result of results) {
    lines.push(`\n=== ${result.id} channel=${result.channel} ===`);
    for (let index = 0; index < result.turns.length; index += 1) {
      const turn = result.turns[index];
      const expectedCount = Object.keys(turn.expected).length;
      metrics.expectedFields += expectedCount;
      metrics.modelCapturedFields += turn.modelMatched.length;
      metrics.ledgerCapturedFields += turn.ledgerMatched.length;
      metrics.nextQuestionChecks += 1;
      if (turn.nextQuestionCorrect) metrics.nextQuestionCorrect += 1;
      if (turn.repeatedQuestion) metrics.repeatedQuestionFailures += 1;
      lines.push(`\nTURN ${index + 1}\nCLIENT: ${turn.message}\nEXPECTED FACTS: ${JSON.stringify(turn.expected)}\nMODEL FACTS: ${JSON.stringify(turn.modelFacts)}\nLEDGER FACTS: ${JSON.stringify(turn.ledgerFacts)}\nRULE RESPONSE: ${turn.response}\nSTATE: lead=${turn.lead} next=${turn.next} response_source=${turn.responseSource}\nCAPTURE: model=${turn.modelMatched.join(",") || "none"} ledger=${turn.ledgerMatched.join(",") || "none"}\nNEXT QUESTION: expected=${turn.nextExpected} actual=${turn.nextActual} correct=${turn.nextQuestionCorrect ? "yes" : "no"} repeated=${turn.repeatedQuestion ? "yes" : "no"}\nEXTRACTION: ${turn.extractionSucceeded ? "ok" : "fallback"} ${turn.extractionIssues.join(",")}`);
    }
  }
  const summary = {
    direction: "model_extraction_only_deterministic_response",
    conversations: results.length,
    turns: results.reduce((sum, item) => sum + item.turns.length, 0),
    parallel: true,
    completedExtractions: records.filter((record) => record.extraction).length,
    extractionCallFailures: records.filter((record) => record.safetyIssues.includes("extraction_call_failed")).length,
    responseSource: "deterministic_rule",
    automaticSending: sendEnabled,
    metrics,
    captureRateModel: metrics.expectedFields ? Number((metrics.modelCapturedFields / metrics.expectedFields * 100).toFixed(1)) : null,
    captureRateLedger: metrics.expectedFields ? Number((metrics.ledgerCapturedFields / metrics.expectedFields * 100).toFixed(1)) : null,
    nextQuestionRate: Number((metrics.nextQuestionCorrect / metrics.nextQuestionChecks * 100).toFixed(1)),
    inputTokens: records.reduce((sum, record) => sum + (record.inputTokens || 0), 0),
    outputTokens: records.reduce((sum, record) => sum + (record.outputTokens || 0), 0),
    elapsedMs: Date.now() - startedAt,
    model: model.extractionModel,
    audioTranscriptsProvided: false,
  };
  lines.push(`\nSPANISH_EXTRACTION_LOCAL_SUMMARY ${JSON.stringify(summary)}`);
  fs.writeFileSync("tmp/conversation-ai-spanish-local.log", lines.join("\n"), "utf8");
  console.log(lines.join("\n"));
  assert.equal(results.length, 8);
  assert.equal(summary.extractionCallFailures, 0);
  assert.ok(summary.turns > 0);
}

main().catch((error) => {
  console.error(`SPANISH_EXTRACTION_LOCAL_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
