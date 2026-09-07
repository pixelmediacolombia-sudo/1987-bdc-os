require("dotenv/config");

const assert = require("node:assert/strict");
const { SofiaConversationEngine } = require("../dist/modules/decisions/domain/sofia-conversation");
const { ConversationAiService } = require("../dist/modules/control/application/conversation-ai.service");
const { OpenAICompatibleConversationalModel } = require("../dist/features/ghl-oauth/infrastructure/ghl/conversational-model.adapter");
const policy = require("../policies/country_club_cars_v8.json");

const apiKey = String(process.env.CONVERSATIONAL_MODEL_API_KEY || "").trim();
const aiEnabled = /^(1|true|yes)$/i.test(String(process.env.CONVERSATIONAL_AI_ENABLED || ""));
const sendEnabled = /^(1|true|yes)$/i.test(String(process.env.CONVERSATIONAL_AI_SEND_ENABLED || ""));

assert.ok(aiEnabled, "CONVERSATIONAL_AI_ENABLED must be true for the real local API test");
assert.ok(apiKey, "CONVERSATIONAL_MODEL_API_KEY is missing");
assert.equal(sendEnabled, false, "Real local test refuses to run with automatic sending enabled");

const model = new OpenAICompatibleConversationalModel(
  process.env.CONVERSATIONAL_MODEL_BASE_URL || "https://api.openai.com/v1",
  apiKey,
  process.env.CONVERSATIONAL_EXTRACTION_MODEL || "gpt-5.6-luna",
  process.env.CONVERSATIONAL_DRAFTING_MODEL || "gpt-5.6-luna",
  Number(process.env.CONVERSATIONAL_MODEL_TIMEOUT_MS || 20_000),
);
const engine = new SofiaConversationEngine(policy.sofia);
const scenarios = [
  { id: "01-A-whatsapp-complete", channel: "WhatsApp", turns: ["Hi", "My name is Maria", "Corolla", "$1500 down", "No trade", "I financed before", "This week", "Yes, I have pay stubs"] },
  { id: "02-B-partial", channel: "WhatsApp", turns: ["Hello", "I am James", "Corolla", "$1500 down"] },
  { id: "03-C-indecisive", channel: "WhatsApp", turns: ["Hi", "I am not sure yet", "Maybe later", "Just looking"] },
  { id: "04-C-poor-spelling", channel: "WhatsApp", turns: ["Helo", "My name is Luis", "Corrola", "fiv hunderd down"] },
  { id: "05-C-minimal-messages", channel: "WhatsApp", turns: ["Hola", "Busco", "Corolla"] },
  { id: "06-A-messenger-phone", channel: "Messenger", turns: ["Hi", "My name is Ana", "Corolla", "$1500 down", "No trade", "Not my first time", "This month", "Yes, I have pay stubs", "410-555-0199"] },
  { id: "07-C-hard-financial-stop", channel: "WhatsApp", turns: ["Hello", "My name is Robert", "Corolla", "$500 down", "No trade", "First time", "This week", "No, I do not have pay stubs"] },
  { id: "08-C-requirements-no-timeline", channel: "WhatsApp", turns: ["Hello, what are the requirements?", "My name is Sofia", "Maybe next year", "I am not ready"] },
];

async function runScenario(scenario, records) {
  const service = new ConversationAiService(model, { save: async (record) => records.push(record) });
  const conversation = { id: scenario.id, channel: scenario.channel, turns: [] };
  let facts = {};
  let transcript = [];
  let previous;

  for (const latestMessage of scenario.turns) {
    const result = await service.process({
      tenantId: "local-country-club-openai",
      contactId: scenario.id,
      latestMessage,
      transcript,
      channel: scenario.channel,
      language: "en",
      dealerName: "Country Club Cars Inc.",
      priorFacts: facts,
      missingObjectives: [],
      ruleTurn: (candidateFacts) => engine.processTurn({
        dealerName: "Country Club Cars Inc.",
        latestMessage,
        priorFacts: candidateFacts,
        contactChannel: scenario.channel,
        language: "en",
        turnCount: conversation.turns.length + 1,
        isFirstTurn: conversation.turns.length === 0,
        lastResponse: previous,
      }),
    });
    facts = result.ruleResult.facts;
    conversation.turns.push({
      customer: latestMessage,
      sofia: result.modelResponse || result.ruleResult.response || "(no response)",
      lead: result.ruleResult.leadLevel,
      next: result.ruleResult.nextStep,
      model: result.modelResponse ? "completed" : "fallback",
      safety: result.safetyIssues,
    });
    if (result.ruleResult.response) transcript.push({ direction: "outbound", content: result.ruleResult.response });
    transcript.push({ direction: "inbound", content: latestMessage });
    previous = result.ruleResult.response;
  }
  return conversation;
}

async function main() {
  const records = [];
  const startedAt = Date.now();
  const outcomes = await Promise.all(scenarios.map((scenario) => runScenario(scenario, records)));

  for (const outcome of outcomes) {
    console.log(`\n=== ${outcome.id} channel=${outcome.channel} final=${outcome.turns.at(-1).lead} ===`);
    for (const turn of outcome.turns) {
      console.log(`CLIENT: ${turn.customer}\nSOFIA: ${turn.sofia}\nSTATE: lead=${turn.lead} next=${turn.next} model=${turn.model}${turn.safety.length ? ` safety=${turn.safety.join(",")}` : ""}`);
    }
  }

  const completedExtractions = records.filter((record) => record.extraction).length;
  const completedDrafts = records.filter((record) => record.modelResponse).length;
  const safetyRejected = records.filter((record) => !record.draftAccepted && record.safetyIssues.length > 0).length;
  const failures = records.filter((record) => record.safetyIssues.includes("draft_call_failed")).length;
  const totalInputTokens = records.reduce((sum, record) => sum + record.inputTokens, 0);
  const totalOutputTokens = records.reduce((sum, record) => sum + record.outputTokens, 0);
  const summary = {
    conversations: outcomes.length,
    turns: outcomes.reduce((sum, outcome) => sum + outcome.turns.length, 0),
    shadowRuns: records.length,
    completedExtractions,
    completedDrafts,
    safetyRejected,
    callFailures: failures,
    totalInputTokens,
    totalOutputTokens,
    elapsedMs: Date.now() - startedAt,
    automaticSending: sendEnabled,
    model: model.draftingModel,
  };
  console.log(`\nOPENAI_LOCAL_SIMULATION_SUMMARY ${JSON.stringify(summary)}`);
  assert.equal(outcomes.length, 8);
  assert.equal(records.length, summary.turns);
}

main().catch((error) => {
  console.error(`OPENAI_LOCAL_SIMULATION_FAILED ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
