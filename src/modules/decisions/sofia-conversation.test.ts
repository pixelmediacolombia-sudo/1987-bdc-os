import assert from "node:assert/strict";
import { test } from "node:test";
import { SofiaConversationEngine, classifyLead } from "@/modules/decisions/domain/sofia-conversation";

test("Sofia keeps a lead at B until both hard rules are verified", () => {
  assert.equal(classifyLead({ contact_value: "15715550134", vehicle_category: "suv", down_payment_declared: 2500 }), "B");
  assert.equal(classifyLead({ contact_value: "15715550134", vehicle_category: "suv", down_payment_declared: 2500, employment_months: 6, has_income_proof: true }), "A");
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
    latestMessage: "Quiero una SUV y tengo 2500",
    priorFacts: {},
    turnCount: 3,
  });
  assert.equal(result.nextStep, "ask");
  assert.match(result.response ?? "", /número de teléfono/i);
  assert.equal(result.leadLevel, "C");
});

test("Sofia opens with dealer identity and reacts before asking", () => {
  const result = new SofiaConversationEngine().processTurn({
    dealerName: "Koons Automotive of Culpeper",
    latestMessage: "Hola, busco una SUV.",
    priorFacts: {},
    turnCount: 1,
    isFirstTurn: true,
  });
  assert.equal(result.response, "Hola! Te saluda Sofía de Koons Automotive of Culpeper\nCon gusto te ayudo. ¿Es para ti o para la familia?");
});

test("Sofia evidences the one-step down-payment push for 1000 and 1500", () => {
  const engine = new SofiaConversationEngine();
  const from1000 = engine.processTurn({ dealerName: "Koons", latestMessage: "Tengo 1000", priorFacts: { vehicle_category: "suv", vehicle_use: "solo" }, turnCount: 2 });
  assert.match(from1000.response ?? "", /1,500/);
  assert.equal(from1000.facts.down_payment_push_target, 1500);
  const from1500 = engine.processTurn({ dealerName: "Koons", latestMessage: "Tengo 1500", priorFacts: { vehicle_category: "suv", vehicle_use: "solo" }, turnCount: 2 });
  assert.match(from1500.response ?? "", /2,000/);
  assert.equal(from1500.facts.down_payment_push_target, 2000);
});

test("Sofia persists the required enrichment facts and only reaches A after hard rules", () => {
  const result = new SofiaConversationEngine().processTurn({
    dealerName: "Koons",
    latestMessage: "Tengo un Honda 2020 pagado, ya financie antes, llevo 2 años y tengo estados de cuenta.",
    priorFacts: {
      vehicle_category: "suv",
      vehicle_use: "familia",
      down_payment_declared: 2500,
      has_trade_in: true,
      contact_value: "15715550134",
    },
    turnCount: 6,
  });
  assert.equal(result.facts.trade_in_financed, false);
  assert.equal(result.facts.first_time_buyer, false);
  assert.equal(result.facts.employment_months, 24);
  assert.equal(result.facts.has_income_proof, true);
  assert.equal(result.leadLevel, "A");
});

test("Sofia does not confuse family use or a phone area code with qualification facts", () => {
  const engine = new SofiaConversationEngine();
  const family = engine.processTurn({
    dealerName: "Koons",
    latestMessage: "Es para mi familia.",
    priorFacts: { vehicle_category: "suv" },
    turnCount: 2,
  });
  assert.equal(family.facts.vehicle_use, "familia");

  const phone = engine.processTurn({
    dealerName: "Koons",
    latestMessage: "No tengo trade y mi número es 571-555-0134.",
    priorFacts: { vehicle_category: "suv", vehicle_use: "familia", down_payment_declared: 1500 },
    turnCount: 4,
  });
  assert.equal(phone.facts.down_payment_declared, 1500);
  assert.equal(phone.facts.contact_value, "5715550134");
});
