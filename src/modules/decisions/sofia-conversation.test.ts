import assert from "node:assert/strict";
import { test } from "node:test";
import { SofiaConversationEngine, classifyLead } from "@/modules/decisions/domain/sofia-conversation";

test("Sofia classifies a contact with sufficient down payment as A", () => {
  assert.equal(classifyLead({ contact_value: "15715550134", vehicle_category: "suv", down_payment_declared: 2500 }), "A");
});

test("Sofia classifies a declared but insufficient down payment as B", () => {
  assert.equal(classifyLead({ contact_value: "15715550134", vehicle_category: "suv", down_payment_declared: 1000 }), "B");
});

test("Sofia excludes a known hard-rule failure from the salesperson flow", () => {
  assert.equal(classifyLead({ contact_value: "15715550134", down_payment_declared: 2500, employment_months: 3 }), "C");
});

test("Sofia asks for contact after the third turn and does not invent approval", () => {
  const result = new SofiaConversationEngine().processTurn({
    dealerName: "Koons Automotive of Culpeper",
    latestMessage: "Quiero una SUV y tengo 1000",
    priorFacts: {},
    turnCount: 3,
  });
  assert.equal(result.nextStep, "ask");
  assert.match(result.response ?? "", /número de teléfono/i);
  assert.equal(result.leadLevel, "C");
});
