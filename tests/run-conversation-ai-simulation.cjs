const assert = require("node:assert/strict");
const { SofiaConversationEngine } = require("../dist/modules/decisions/domain/sofia-conversation");
const { ConversationAiService } = require("../dist/modules/control/application/conversation-ai.service");
const policy = require("../policies/country_club_cars_v8.json");

class FakeOpenAI {
  extractionModel = "fake-gpt-5.6-luna";
  draftingModel = "fake-gpt-5.6-luna";

  async extract(input) {
    const message = input.latestMessage.toLowerCase();
    const facts = {};
    if (/corrola|corolla/.test(message)) { facts.vehicle_model_interest = "Corolla"; facts.vehicle_category = "sedan"; }
    if (/fiv[e ]+hundred|fiv.*hunderd|quinientos/.test(message)) facts.down_payment_declared = 500;
    if (/one thousand|mil quinientos|fifteen hundred|1500/.test(message)) facts.down_payment_declared = /one thousand/.test(message) ? 1000 : 1500;
    if (/no trade|no carro|no vehicle/.test(message)) facts.has_trade_in = false;
    if (/first taim|first time|never financed/.test(message)) facts.first_time_buyer = true;
    if (/not my first time|financed before/.test(message)) facts.first_time_buyer = false;
    if (/this week|dis week/.test(message)) facts.purchase_timeline = "this_week";
    if (/this month/.test(message)) facts.purchase_timeline = "this_month";
    if (/next year|maybe later|not ready|just looking/.test(message)) facts.purchase_timeline = "none";
    if (/pay stubz|pay stubs|bank statements|employer letter|yes.*proof/.test(message)) facts.has_income_proof = true;
    if (/no.*pay|no.*proof/.test(message)) facts.has_income_proof = false;
    const phone = message.match(/(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}/);
    if (phone) facts.contact_value = phone[0].replace(/\D/g, "");
    return { value: { facts, intent: "qualification", missingFields: input.missingObjectives }, usage: { inputTokens: 20, outputTokens: 8 } };
  }

}

async function main() {
  const records = [];
  const service = new ConversationAiService(new FakeOpenAI(), { save: async (record) => records.push(record) });
  const engine = new SofiaConversationEngine(policy.sofia);
  const outcomes = [];
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

  for (const scenario of scenarios) {
    let facts = {};
    let transcript = [];
    let previous;
    const turns = [];
    for (const latestMessage of scenario.turns) {
      const result = await service.process({
        tenantId: "local-country-club",
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
          turnCount: turns.length + 1,
          isFirstTurn: turns.length === 0,
          lastResponse: previous,
        }),
      });
      facts = result.ruleResult.facts;
      turns.push({ customer: latestMessage, sofia: result.ruleResult.response || "(no response)", lead: result.ruleResult.leadLevel, next: result.ruleResult.nextStep, shadow: result.responseSource, extraction: result.extractionSucceeded ? "ok" : result.extractionIssues.join(",") || "fallback" });
      if (result.ruleResult.response) transcript.push({ direction: "outbound", content: result.ruleResult.response });
      transcript.push({ direction: "inbound", content: latestMessage });
      previous = result.ruleResult.response;
    }
    console.log(`\n=== ${scenario.id} channel=${scenario.channel} final=${turns.at(-1).lead} ===`);
    for (const turn of turns) console.log(`CLIENT: ${turn.customer}\nSOFIA: ${turn.sofia}\nSTATE: lead=${turn.lead} next=${turn.next} source=${turn.shadow} extraction=${turn.extraction}`);
    assert.ok(["A", "B", "C"].includes(turns.at(-1).lead));
    outcomes.push({ id: scenario.id, finalLead: turns.at(-1).lead, finalNext: turns.at(-1).next });
  }
  console.log(`\nSIMULATION_SUMMARY ${JSON.stringify({ conversations: scenarios.length, shadowRuns: records.length, successfulExtractions: records.filter((record) => record.extraction).length, responseSource: "deterministic_rule", finalLeads: outcomes })}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
