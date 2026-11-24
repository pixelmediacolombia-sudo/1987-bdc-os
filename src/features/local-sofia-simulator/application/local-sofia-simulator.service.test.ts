import assert from "node:assert/strict";
import test from "node:test";
import { LocalSofiaSimulatorService } from "@/features/local-sofia-simulator/application/local-sofia-simulator.service";
import type { ConversationalModelPort } from "@/modules/control/application/conversation-ai-model-contract";

class FakeModel implements ConversationalModelPort {
  readonly extractionModel = "fake-extraction";
  readonly draftingModel = "unused-drafting";
  readonly calls: string[] = [];

  async extract(input: Parameters<ConversationalModelPort["extract"]>[0]) {
    this.calls.push(input.latestMessage);
    const facts = input.latestMessage.toLowerCase().includes("suv")
      ? { vehicle_category: "suv", vehicle_model_interest: "RAV4" }
      : input.latestMessage.includes("1500") ? { down_payment_declared: 1500 } : {};
    return { value: { facts, intent: "vehicle_inquiry", missingFields: ["purchase_timeline"] } };
  }
}

test("local Sofia simulator keeps a synthetic multi-turn conversation on the backend pipeline", async () => {
  const model = new FakeModel();
  const simulator = new LocalSofiaSimulatorService(model);
  const first = await simulator.turn("Busco una SUV Toyota RAV4.");
  const second = await simulator.turn("Tengo 1500 para el enganche.", first.conversationId);

  assert.equal(model.calls.length, 2);
  assert.deepEqual(first.openai.modelFacts, { vehicle_category: "suv", vehicle_model_interest: "RAV4" });
  assert.equal(second.openai.modelFacts.down_payment_declared, 1500);
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(second.messages.filter((message) => message.direction === "inbound").length, 2);
  assert.equal(second.messages.filter((message) => message.direction === "outbound").length, 2);
  assert.ok(second.sofia.response.length > 0);
  assert.equal(second.openai.responseSource, "deterministic_rule");
  assert.equal(second.openai.status, "ok");
});

test("local Sofia simulator rejects an expired conversation and resets synthetic state", async () => {
  const simulator = new LocalSofiaSimulatorService(new FakeModel());
  const first = await simulator.turn("Hola, busco un carro.");
  simulator.reset(first.conversationId);
  await assert.rejects(() => simulator.turn("Tengo 1500.", first.conversationId), /expiró o no existe/);
  await assert.rejects(() => simulator.turn("", undefined), /Escribe un mensaje/);
});
