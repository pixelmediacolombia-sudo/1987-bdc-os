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
assert.ok(aiEnabled, "CONVERSATIONAL_AI_ENABLED must be true for the real Spanish local test");
assert.ok(apiKey, "CONVERSATIONAL_MODEL_API_KEY is missing");
assert.equal(sendEnabled, false, "Spanish local test refuses to run with automatic sending enabled");

const scenarios = [
  { id: "01-A-es-completa", channel: "WhatsApp", turns: ["Hola", "Soy María", "Busco un Corolla 2022", "Tengo $1500 para el enganche", "No tengo carro para dar", "Ya he financiado antes", "Esta semana", "Sí, tengo talones de pago"] },
  { id: "02-B-es-parcial", channel: "WhatsApp", turns: ["Hola", "Soy Jorge", "Quiero un Corolla"] },
  { id: "03-C-es-indeciso", channel: "WhatsApp", turns: ["Hola", "No se todavía", "talvez despues", "solo miro"] },
  { id: "04-C-es-mala-ortografia", channel: "WhatsApp", turns: ["Ola", "busco una corrola", "tengo quinientos de enganche"] },
  { id: "05-C-es-mensajes-minimos", channel: "WhatsApp", turns: ["Hola", "Busco", "Corolla"] },
  { id: "06-C-messenger-sin-numero", channel: "Messenger", turns: ["Hola", "Soy Ana", "Busco una troca", "Tengo 2000", "No tengo carro", "Es mi primera vez", "Este mes", "Si tengo talones"] },
  { id: "07-A-unidad-especifica", channel: "WhatsApp", turns: ["Hola, tienen el Toyota Corolla 2022 azul?", "Soy Roberto", "Me interesa esa unidad", "Tengo $1500", "No trade", "Ya he financiado", "Esta semana", "Tengo comprobantes"] },
  { id: "08-C-es-mixto-sin-fecha", channel: "WhatsApp", turns: ["Hola, I'm looking for un carro", "No se que modelo todavía", "quizas el otro año", "ahorita no estoy listo"] },
];

const objectiveOrder = [
  "vehicle_category", "vehicle_model_interest", "down_payment_declared", "has_trade_in",
  "first_time_buyer", "purchase_timeline", "has_income_proof", "contact_value",
];

function pendingObjectives(facts, channel) {
  return objectiveOrder.filter((objective) => {
    if (objective === "vehicle_category") return !facts.vehicle_category && !facts.vehicle_model_interest;
    if (objective === "contact_value") return /messenger|facebook|fb/i.test(channel) && !facts.contact_value;
    return facts[objective] === undefined;
  });
}

function normalize(value) {
  return String(value || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function hasGenericFiller(value) {
  return /i am still here to help|sigo aqui para ayudarle|gracias por compartirlo|let me get the next detail/i.test(value || "");
}

function hasQuestion(value) {
  return /\?/.test(value || "");
}

function classifyTurn(rule, actual) {
  const candidate = actual.accepted ? actual.rawDraft || "" : "";
  if (!candidate || actual.safety.length > 0) return "rule_better";
  if (normalize(candidate) === normalize(rule.response)) return "equal";
  if (hasGenericFiller(rule.response) && !hasGenericFiller(candidate)) return "model_better";
  if (rule.nextStep === "ask" && hasQuestion(candidate) && !hasGenericFiller(candidate)) return "equal";
  return "rule_better";
}

async function runBaseline(scenario) {
  const engine = new SofiaConversationEngine(policy.sofia);
  let facts = {};
  let previous;
  const transcript = [];
  const turns = [];
  for (const latestMessage of scenario.turns) {
    const rule = engine.processTurn({
      dealerName: "Country Club Cars Inc.", latestMessage, priorFacts: facts,
      contactChannel: scenario.channel, language: "es", turnCount: turns.length + 1,
      isFirstTurn: turns.length === 0, lastResponse: previous,
    });
    turns.push({ message: latestMessage, response: rule.response || "(sin respuesta)", lead: rule.leadLevel, next: rule.nextStep });
    facts = rule.facts;
    if (rule.response) transcript.push({ direction: "outbound", content: rule.response });
    transcript.push({ direction: "inbound", content: latestMessage });
    previous = rule.response;
  }
  return { id: scenario.id, channel: scenario.channel, turns };
}

async function runReal(scenario, records) {
  const engine = new SofiaConversationEngine(policy.sofia);
  const service = new ConversationAiService(model, { save: async (record) => records.push(record) });
  let facts = {};
  let previous;
  const transcript = [];
  const turns = [];
  for (const latestMessage of scenario.turns) {
    const result = await service.process({
      tenantId: "local-country-club-spanish",
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
        contactChannel: scenario.channel, language: "es", turnCount: turns.length + 1,
        isFirstTurn: turns.length === 0, lastResponse: previous,
      }),
    });
    const effectiveResponse = result.draftAccepted && result.modelResponse ? result.modelResponse : result.ruleResult.response || "(sin respuesta)";
    turns.push({
      message: latestMessage,
      response: effectiveResponse,
      rawDraft: result.modelResponse || "(sin borrador)",
      lead: result.ruleResult.leadLevel,
      next: result.ruleResult.nextStep,
      accepted: result.draftAccepted,
      safety: result.safetyIssues,
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
  process.env.CONVERSATIONAL_DRAFTING_MODEL || "gpt-5.6-luna",
  Number(process.env.CONVERSATIONAL_MODEL_TIMEOUT_MS || 20_000),
);

async function main() {
  const baselines = Object.fromEntries(await Promise.all(scenarios.map(async (scenario) => [scenario.id, await runBaseline(scenario)])));
  const records = [];
  const startedAt = Date.now();
  const real = await Promise.all(scenarios.map((scenario) => runReal(scenario, records)));
  const outcomes = [];
  const counts = { model_better: 0, equal: 0, rule_better: 0 };
  const lines = [];

  for (const actual of real) {
    const baseline = baselines[actual.id];
    lines.push(`\n=== ${actual.id} channel=${actual.channel} ===`);
    for (let index = 0; index < actual.turns.length; index += 1) {
      const rule = baseline.turns[index];
      const current = actual.turns[index];
      const verdict = classifyTurn(rule, current);
      counts[verdict] += 1;
      lines.push(`\nTURN ${index + 1}\nCLIENT: ${current.message}\nRULE: ${rule.response}\nOPENAI EFFECTIVE: ${current.response}\nOPENAI RAW: ${current.rawDraft}\nSTATE: lead=${current.lead} next=${current.next} accepted=${current.accepted ? "yes" : "no"} safety=${current.safety.join(",") || "none"}\nVERDICT: ${verdict}`);
    }
    outcomes.push({ id: actual.id, finalLead: actual.turns.at(-1).lead, finalNext: actual.turns.at(-1).next });
  }

  const summary = {
    conversations: real.length,
    turns: real.reduce((sum, item) => sum + item.turns.length, 0),
    parallel: true,
    completedExtractions: records.filter((record) => record.extraction).length,
    completedDrafts: records.filter((record) => record.modelResponse).length,
    acceptedDrafts: records.filter((record) => record.draftAccepted).length,
    safetyRejected: records.filter((record) => !record.draftAccepted && record.safetyIssues.length > 0).length,
    callFailures: records.filter((record) => record.safetyIssues.includes("draft_call_failed")).length,
    inputTokens: records.reduce((sum, record) => sum + (record.inputTokens || 0), 0),
    outputTokens: records.reduce((sum, record) => sum + (record.outputTokens || 0), 0),
    verdicts: counts,
    finalLeads: outcomes,
    elapsedMs: Date.now() - startedAt,
    automaticSending: sendEnabled,
    model: model.draftingModel,
  };
  lines.push(`\nSPANISH_LOCAL_SUMMARY ${JSON.stringify(summary)}`);
  fs.writeFileSync("tmp/conversation-ai-spanish-local.log", lines.join("\n"), "utf8");
  console.log(lines.join("\n"));
  assert.equal(real.length, 8);
  assert.equal(summary.turns, 41);
  assert.equal(summary.callFailures, 0);
}

main().catch((error) => {
  console.error(`SPANISH_LOCAL_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
