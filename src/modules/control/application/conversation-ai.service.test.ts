import assert from "node:assert/strict";
import test from "node:test";
import type {
  ConversationAiShadowRecord,
  ConversationalModelExtractionInput,
  ConversationalModelPort,
} from "@/modules/control/application/conversation-ai-model-contract";
import { ConversationAiService } from "@/modules/control/application/conversation-ai.service";
import { validateDraftSafety } from "@/modules/control/application/conversation-ai-model-safety";

class FakeOpenAIModel implements ConversationalModelPort {
  readonly extractionModel = "fake-extraction";
  readonly draftingModel = "fake-drafting";
  constructor(
    private readonly extracted: Awaited<ReturnType<ConversationalModelPort["extract"]>>,
  ) {}
  async extract(_input: ConversationalModelExtractionInput) { return this.extracted; }
}

test("local fake OpenAI extraction cannot set lead level and shadow does not replace rules", async () => {
  const records: ConversationAiShadowRecord[] = [];
  const model = new FakeOpenAIModel({
    value: { facts: { contact_value: "not-a-phone", down_payment_declared: 1500, leadLevel: "A" } as never, intent: "vehicle_interest", missingFields: ["employment_months"] },
    usage: { inputTokens: 12, outputTokens: 7 },
  });
  const service = new ConversationAiService(model, { save: async (record) => { records.push(record); } });
  const result = await service.process({
    tenantId: "tenant-1",
    contactId: "contact-1",
    latestMessage: "Busco una SUV",
    transcript: [],
    channel: "WhatsApp",
    language: "es",
    dealerName: "Dealer 1",
    priorFacts: {},
    missingObjectives: ["vehicle_category"],
    ruleTurn: (facts) => ({ facts: { ...facts, vehicle_category: "suv" }, leadLevel: "C", response: "Perfecto, ¿qué tipo de vehículo le interesa?", nextStep: "ask", contactCaptured: false, hardRuleFailure: false }),
  });

  assert.equal(result.ruleResult.leadLevel, "C");
  assert.equal(result.modelFacts.contact_value, undefined);
  assert.equal(result.modelFacts.down_payment_declared, 1500);
  assert.equal(records.length, 1);
  assert.equal(result.extractionSucceeded, true);
  assert.equal(result.responseSource, "deterministic_rule");
  assert.equal(records[0]?.draftAccepted, false);
  assert.equal(records[0]?.responseSource, "deterministic_rule");
  assert.equal(records[0]?.ruleResponse, "Perfecto, ¿qué tipo de vehículo le interesa?");
});

test("model cannot replace the ledger question or use generic filler", () => {
  const question = "¿Con cuánto contaría para el enganche?";
  assert.equal(validateDraftSafety("I am still here to help with the next detail.", {
    knownFacts: {}, ruleResponse: question, requiredAction: "ask", requiredQuestion: question,
  }).accepted, false);
  assert.deepEqual(validateDraftSafety("¿Tiene trade-in?", {
    knownFacts: {}, ruleResponse: question, requiredAction: "ask", requiredQuestion: question,
  }).issues, ["required_question_mismatch"]);
  assert.deepEqual(validateDraftSafety("Perfecto, ya le paso su información al asesor.", {
    knownFacts: {}, ruleResponse: "Perfecto, ya le paso su información al asesor.", requiredAction: "handoff",
  }).issues, []);
});

test("local fake OpenAI draft is rejected for unsupported commercial content", () => {
  const result = validateDraftSafety("Claro que la tenemos por $999 y ya estás aprobado: https://fake.example", {
    knownFacts: {},
    ruleResponse: "Podemos ayudarte.",
  });
  assert.equal(result.accepted, false);
  assert.deepEqual(result.issues, ["invented_url", "approval_promise", "unsupported_inventory_claim", "unsupported_numeric_value"]);
});

test("model timeout/failure is represented in shadow and the rule remains available", async () => {
  const records: ConversationAiShadowRecord[] = [];
  const model: ConversationalModelPort = {
    extractionModel: "fake-extraction",
    draftingModel: "fake-drafting",
    extract: async () => { throw new Error("simulated API unavailable"); },
  };
  const service = new ConversationAiService(model, { save: async (record) => { records.push(record); } });
  const result = await service.process({
    tenantId: "tenant-1",
    contactId: "contact-1",
    latestMessage: "hola",
    transcript: [],
    channel: "WhatsApp",
    language: "es",
    dealerName: "Dealer 1",
    priorFacts: {},
    missingObjectives: [],
    ruleTurn: (facts) => ({ facts, leadLevel: "C", response: "Respuesta de regla", nextStep: "ask", contactCaptured: false, hardRuleFailure: false }),
  });
  assert.equal(result.ruleResult.response, "Respuesta de regla");
  assert.equal(result.extractionSucceeded, false);
  assert.deepEqual(result.extractionIssues, ["extraction_call_failed"]);
  assert.deepEqual(records[0]?.safetyIssues, ["extraction_call_failed"]);
});
