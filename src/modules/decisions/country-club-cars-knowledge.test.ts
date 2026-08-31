import assert from "node:assert/strict";
import { test } from "node:test";
import { SofiaConversationEngine, classifyLead } from "@/modules/decisions/domain/sofia-conversation";
import { LocalPolicyPackProvider } from "@/modules/memory/infrastructure/policies/local-policy-pack.provider";

async function countryClubEngine(): Promise<SofiaConversationEngine> {
  const policy = await new LocalPolicyPackProvider().load("country_club_cars_v8");
  assert.ok(policy.sofia);
  return new SofiaConversationEngine(policy.sofia);
}

test("Country Club policy loads the Spanish source as the business authority", async () => {
  const policy = await new LocalPolicyPackProvider().load("country_club_cars_v8");
  assert.equal(policy.version, "country_club_cars_v8");
  assert.equal(policy.sofia?.knowledge?.dealer.name, "Country Club Cars Inc.");
  assert.equal(policy.sofia?.knowledge?.dealer.address, "8606 Wise Ave, Baltimore, MD 21222");
  assert.equal(policy.sofia?.downPaymentRanges["work truck"]?.min, 2500);
  assert.equal(policy.sofia?.knowledge?.modelCategories.tacoma, "work truck");
  assert.doesNotMatch(policy.sofia?.knowledge?.requirements.es ?? "", /referencias/i);
});

test("Country Club greeting anchors the category and asks for the name formally", async () => {
  const engine = await countryClubEngine();
  const result = engine.processTurn({
    dealerName: "ignored fallback",
    latestMessage: "Estoy buscando una Tacoma",
    priorFacts: {},
    turnCount: 1,
    isFirstTurn: true,
    contactChannel: "WhatsApp",
    language: "es",
  });

  assert.equal(result.facts.vehicle_category, "work truck");
  assert.match(result.response ?? "", /Country Club Cars Inc\./);
  assert.match(result.response ?? "", /\$2,500/);
  assert.match(result.response ?? "", /¿Con quién tengo el gusto\?/);
  assert.doesNotMatch(result.response ?? "", /te llamas|¿cómo/);
});

test("Country Club normalizes 1k, does not reopen the down-payment box, and moves to trade-in", async () => {
  const engine = await countryClubEngine();
  const result = engine.processTurn({
    dealerName: "Country Club Cars Inc.",
    latestMessage: "1k",
    priorFacts: { contact_name: "Juan", vehicle_category: "work truck", down_payment_declared: undefined },
    turnCount: 2,
    contactChannel: "WhatsApp",
    language: "es",
  });

  assert.equal(result.facts.down_payment_declared, 1000);
  assert.doesNotMatch(result.response ?? "", /¿Con cuánto contaría para el enganche\?/i);
  assert.match(result.response ?? "", /parte de pago/);
});

test("Country Club answers requirements before asking the next missing box", async () => {
  const engine = await countryClubEngine();
  const result = engine.processTurn({
    dealerName: "Country Club Cars Inc.",
    latestMessage: "¿Qué requisitos necesito para comprar?",
    priorFacts: { contact_name: "Juan", vehicle_category: "sedan" },
    turnCount: 2,
    contactChannel: "WhatsApp",
    language: "es",
  });

  assert.match(result.response ?? "", /identificación|comprobante de ingresos/i);
  assert.match(result.response ?? "", /¿Con cuánto contaría para el enganche\?/i);
  assert.equal((result.response?.match(/\?/g) ?? []).length, 1);
});

test("Country Club asks for a phone only on Messenger and skips it on WhatsApp", async () => {
  const engine = await countryClubEngine();
  const facts = {
    contact_name: "Juan",
    vehicle_category: "sedan",
    down_payment_declared: 1500,
    has_trade_in: false,
    first_time_buyer: true,
    purchase_timeline: "this_week" as const,
    has_income_proof: true,
  };
  const messenger = engine.processTurn({ dealerName: "Country Club Cars Inc.", latestMessage: "Gracias", priorFacts: facts, turnCount: 8, contactChannel: "Messenger", language: "es" });
  const whatsapp = engine.processTurn({ dealerName: "Country Club Cars Inc.", latestMessage: "Gracias", priorFacts: facts, turnCount: 8, contactChannel: "WhatsApp", language: "es" });
  assert.match(messenger.response ?? "", /número de teléfono/i);
  assert.doesNotMatch(whatsapp.response ?? "", /número de teléfono/i);
});

test("Country Club supports the English response layer without changing the rules", async () => {
  const engine = await countryClubEngine();
  const result = engine.processTurn({
    dealerName: "Country Club Cars Inc.",
    latestMessage: "What do I need to buy a vehicle?",
    priorFacts: { contact_name: "Juan", vehicle_category: "suv" },
    turnCount: 2,
    contactChannel: "Messenger",
    language: "en",
  });
  assert.match(result.response ?? "", /ID|proof of income/i);
  assert.match(result.response ?? "", /down payment/i);
  assert.equal((result.response?.match(/\?/g) ?? []).length, 1);
});

test("Country Club classification follows A/B/C and does not ask employment length", async () => {
  const policy = await new LocalPolicyPackProvider().load("country_club_cars_v8");
  assert.ok(policy.sofia);
  const a = classifyLead({ contact_name: "Juan", contact_channel: "whatsapp", vehicle_category: "suv", down_payment_declared: 2000, has_income_proof: true, purchase_timeline: "this_month" }, policy.sofia);
  const b = classifyLead({ contact_name: "Juan", contact_channel: "whatsapp", vehicle_category: "suv", down_payment_declared: 1000, has_trade_in: true }, policy.sofia);
  const c = classifyLead({ contact_name: "Juan", contact_channel: "whatsapp", vehicle_category: "suv", down_payment_declared: 1000, purchase_timeline: "none" }, policy.sofia);
  assert.equal(a, "A");
  assert.equal(b, "B");
  assert.equal(c, "C");

  const engine = new SofiaConversationEngine(policy.sofia);
  const result = engine.processTurn({
    dealerName: "Country Club Cars Inc.",
    latestMessage: "Esta semana",
    priorFacts: { contact_name: "Juan", vehicle_category: "suv", down_payment_declared: 2000, has_trade_in: false, first_time_buyer: true },
    turnCount: 5,
    contactChannel: "WhatsApp",
    language: "es",
  });
  assert.match(result.response ?? "", /comprobante|talones|estados de cuenta/i);
  assert.doesNotMatch(result.response ?? "", /antigüedad|cuánto tiempo lleva trabajando/i);
});

test("Country Club applies the purchase-intent filter and closes when the customer declines", async () => {
  const engine = await countryClubEngine();
  const filter = engine.processTurn({
    dealerName: "Country Club Cars Inc.",
    latestMessage: "Solo estoy mirando, todavía no tengo fecha.",
    priorFacts: { contact_name: "Laura", vehicle_category: "suv", down_payment_declared: 2000, has_trade_in: false, first_time_buyer: true },
    turnCount: 6,
    contactChannel: "WhatsApp",
    language: "es",
  });
  assert.equal(filter.facts.purchase_timeline, "none");
  assert.match(filter.response ?? "", /esta semana|este mes/i);

  const close = engine.processTurn({
    dealerName: "Country Club Cars Inc.",
    latestMessage: "No, por ahora no estoy listo.",
    priorFacts: { ...filter.facts, purchase_timeline: "none" },
    turnCount: 7,
    contactChannel: "WhatsApp",
    language: "es",
  });
  assert.equal(close.leadLevel, "C");
  assert.match(close.response ?? "", /Cualquier cosa aquí estamos/i);
  assert.equal(close.nextStep, "follow_up");
});

test("Country Club handles a photo without commenting on price, condition or availability", async () => {
  const engine = await countryClubEngine();
  const result = engine.processTurn({
    dealerName: "Country Club Cars Inc.",
    latestMessage: "Le mando la foto de mi carro.",
    priorFacts: { contact_name: "Laura", vehicle_category: "suv", down_payment_declared: 2000, has_trade_in: false, first_time_buyer: true },
    turnCount: 3,
    contactChannel: "WhatsApp",
    language: "es",
    mediaContext: { imageClassifications: ["vehicle_photo"], imageVehicleCategories: ["suv"] },
  });
  assert.match(result.response ?? "", /asesor para que la revise/i);
  assert.match(result.response ?? "", /¿En cuánto tiempo/i);
  assert.doesNotMatch(result.response ?? "", /precio|estado|año|disponib/i);
  assert.equal(result.facts.has_trade_in, false);
});
