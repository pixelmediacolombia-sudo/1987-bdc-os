import assert from "node:assert/strict";
import { test } from "node:test";
import { SofiaConversationEngine, type SofiaFacts } from "@/modules/decisions/domain/sofia-conversation";
import { LocalPolicyPackProvider } from "@/modules/memory/infrastructure/policies/local-policy-pack.provider";

const policyPromise = new LocalPolicyPackProvider().load("country_club_cars_v8");

async function run(message: string, priorFacts: SofiaFacts = {}, options: { turnCount?: number; language?: string; pendingQuestion?: "has_trade_in" | "trade_in_financed" | "has_income_proof" | "first_time_buyer" | "purchase_timeline"; isFirstTurn?: boolean; isAdvertisementMetadata?: boolean; mediaContext?: SofiaFacts extends never ? never : Parameters<SofiaConversationEngine["processTurn"]>[0]["mediaContext"] } = {}) {
  const policy = await policyPromise;
  assert.ok(policy.sofia);
  return new SofiaConversationEngine(policy.sofia).processTurn({
    dealerName: "Country Club Cars Inc.",
    latestMessage: message,
    priorFacts,
    turnCount: options.turnCount ?? 2,
    language: options.language ?? "es",
    contactChannel: "WhatsApp",
    pendingQuestion: options.pendingQuestion,
    isFirstTurn: options.isFirstTurn,
    isAdvertisementMetadata: options.isAdvertisementMetadata,
    mediaContext: options.mediaContext,
  });
}

function caseTest(id: string, check: () => Promise<void>): void {
  test(`PDF matrix ${id}`, check);
}

const withVehicle = { contact_name: "Juan", vehicle_category: "sedan" };

caseTest("A-01", async () => assert.equal((await run("1k", withVehicle)).facts.down_payment_declared, 1000));
caseTest("A-02", async () => assert.equal((await run("mil", withVehicle)).facts.down_payment_declared, 1000));
caseTest("A-03", async () => assert.equal((await run("$1,000", withVehicle)).facts.down_payment_declared, 1000));
caseTest("A-04", async () => assert.equal((await run("mil quinientos", withVehicle)).facts.down_payment_declared, 1500));
caseTest("A-05", async () => assert.equal((await run("como 1500 más o menos", withVehicle)).facts.down_payment_declared, 1500));
caseTest("A-06", async () => assert.equal((await run("unos dos mil pesitos", withVehicle)).facts.down_payment_declared, 2000));
caseTest("A-07", async () => assert.equal((await run("2.5k", withVehicle)).facts.down_payment_declared, 2500));
caseTest("A-08", async () => { const result = await run("entre mil y dos mil", withVehicle); assert.equal(result.facts.down_payment_declared, undefined); assert.match(result.response ?? "", /enganche/i); });
caseTest("A-09", async () => { const result = await run("no sé todavía", withVehicle); assert.equal(result.facts.down_payment_declared, undefined); assert.match(result.response ?? "", /enganche|trade|parte de pago/i); });
caseTest("A-10", async () => { const result = await run("lo que sea necesario", withVehicle); assert.equal(result.facts.down_payment_declared, undefined); assert.match(result.response ?? "", /enganche|mínimo|trade|parte de pago/i); });
caseTest("A-11", async () => { const result = await run("2015", { ...withVehicle, vehicle_model_interest: "CR-V" }); assert.equal(result.facts.vehicle_year, 2015); assert.equal(result.facts.down_payment_declared, undefined); });
caseTest("A-12", async () => { const result = await run("$200 Seguro", {}, { isAdvertisementMetadata: true, isFirstTurn: true }); assert.equal(result.response, undefined); assert.equal(result.facts.down_payment_declared, undefined); });

caseTest("B-01", async () => { const result = await run("Busco una Tacoma", { contact_name: "Ana" }, { isFirstTurn: true, turnCount: 1 }); assert.equal(result.facts.vehicle_model_interest, "Tacoma"); assert.equal(result.facts.vehicle_category, "work truck"); assert.match(result.response ?? "", /2,?500/); });
caseTest("B-02", async () => { const result = await run("un Crv", {}); assert.equal(result.facts.vehicle_category, "suv"); });
caseTest("B-03", async () => { const result = await run("una Odyssey para la familia", {}); assert.equal(result.facts.vehicle_category, "van"); });
caseTest("B-04", async () => { const result = await run("quiero un Camry", {}); assert.equal(result.facts.vehicle_category, "sedan"); });
caseTest("B-05", async () => { const result = await run("una Toyota", { contact_name: "Ana" }); assert.equal(result.facts.vehicle_category, undefined); assert.match(result.response ?? "", /sedán|SUV|troca|vehículo/i); });
caseTest("B-06", async () => { const result = await run("algo de Mazda, no sé si carro o SUV", { contact_name: "Ana" }); assert.equal(result.facts.vehicle_category, undefined); assert.match(result.response ?? "", /sedán|SUV|troca/i); });
caseTest("B-07", async () => { const result = await run("un carrito barato", {}); assert.equal(result.facts.vehicle_category, "sedan"); });
caseTest("B-08", async () => { const result = await run("una troca", { contact_name: "Ana" }, { isFirstTurn: true, turnCount: 1 }); assert.equal(result.facts.vehicle_category, "work truck"); assert.match(result.response ?? "", /2,?500/); });
caseTest("B-09", async () => { const result = await run("un modelo que no existe en la tabla", { contact_name: "Ana" }); assert.equal(result.facts.vehicle_category, undefined); assert.match(result.response ?? "", /categoría|sedán|SUV|troca/i); });

caseTest("C-01", async () => { const result = await run("Soy Ana, busco un Camry y tengo $2,000", {}, { isFirstTurn: true, turnCount: 1 }); assert.equal(result.facts.contact_name, "Ana"); assert.equal(result.facts.vehicle_model_interest, "Camry"); assert.equal(result.facts.vehicle_category, "sedan"); assert.equal(result.facts.down_payment_declared, 2000); });
caseTest("C-02", async () => { const result = await run("Tengo 1k y un Civic para dar", withVehicle); assert.equal(result.facts.down_payment_declared, 1000); assert.equal(result.facts.has_trade_in, true); });
caseTest("C-03", async () => { const result = await run("Ya financié antes y tengo talones", {}); assert.equal(result.facts.first_time_buyer, false); assert.equal(result.facts.has_income_proof, true); });
caseTest("C-04", async () => { let facts: SofiaFacts = {}; for (const [index, message] of ["Hola", "Quiero", "un Crv", "2015"].entries()) { const result = await run(message, facts, { turnCount: index + 1, isFirstTurn: index === 0 }); facts = result.facts; } assert.equal(facts.vehicle_model_interest, "Crv"); assert.equal(facts.vehicle_year, 2015); });

caseTest("D-01", async () => assert.equal((await run("no tengo carro para dar", withVehicle)).facts.has_trade_in, false));
caseTest("D-02", async () => assert.equal((await run("nunca he financiado", withVehicle)).facts.first_time_buyer, true));
caseTest("D-03", async () => assert.equal((await run("no", withVehicle, { pendingQuestion: "has_trade_in" })).facts.has_trade_in, false));
caseTest("D-04", async () => assert.equal((await run("no", withVehicle)).facts.has_trade_in, undefined));
caseTest("D-05", async () => assert.equal((await run("sí", withVehicle, { pendingQuestion: "has_income_proof" })).facts.has_income_proof, true));
caseTest("D-06", async () => assert.equal((await run("todavía lo debo", { ...withVehicle, has_trade_in: true })).facts.trade_in_financed, true));

caseTest("E-01", async () => { const result = await run("¿Qué requisitos piden?", withVehicle); assert.match(result.response ?? "", /identificación|comprobante/i); });
caseTest("E-02", async () => { const result = await run("¿Cuánto sería la mensualidad?", withVehicle); assert.match(result.response ?? "", /mensualidad|números exactos/i); assert.doesNotMatch(result.response ?? "", /\$\d/); });
caseTest("E-03", async () => assert.match((await run("¿Dónde están?", withVehicle)).response ?? "", /8606 Wise Ave/i));
caseTest("E-04", async () => assert.match((await run("¿Abren domingo?", withVehicle)).response ?? "", /domingo cerrado/i));
caseTest("E-05", async () => { const result = await run("Tengo 1k, ¿qué documentos necesito?", withVehicle); assert.equal(result.facts.down_payment_declared, 1000); assert.match(result.response ?? "", /identificación|comprobante/i); });
caseTest("E-06", async () => assert.match((await run("¿Y si no tengo licencia?", withVehicle)).response ?? "", /ITIN/i));
caseTest("E-07", async () => { const result = await run("hace mucho calor hoy", withVehicle); assert.equal(result.facts.down_payment_declared, undefined); assert.match(result.response ?? "", /enganche|parte de pago/i); });

caseTest("F-01", async () => assert.equal((await run("esta semana", withVehicle)).facts.purchase_timeline, "this_week"));
caseTest("F-02", async () => assert.equal((await run("este mes", withVehicle)).facts.purchase_timeline, "this_month"));
caseTest("F-03", async () => { const result = await run("solo estoy mirando", withVehicle); assert.equal(result.facts.purchase_timeline, "none"); assert.match(result.response ?? "", /esta semana|este mes/i); });
caseTest("F-04", async () => { const result = await run("no estoy listo todavía", withVehicle); assert.equal(result.facts.purchase_timeline, "none"); assert.equal(result.leadLevel, "C"); assert.equal(result.nextStep, "follow_up"); });
caseTest("F-05", async () => { const result = await run("pronto pero no sé el día", withVehicle); assert.equal(result.facts.purchase_timeline, "none"); assert.match(result.response ?? "", /esta semana|este mes/i); });

caseTest("G-01", async () => assert.match((await run("Olaa, q requisitos piden, tengo poko credito", withVehicle)).response ?? "", /identificación|comprobante/i));
caseTest("G-02", async () => assert.equal((await run("tengo mil dolares pal enganche", withVehicle)).facts.down_payment_declared, 1000));
caseTest("G-03", async () => assert.equal((await run("nunca e financiao", withVehicle)).facts.first_time_buyer, true));
caseTest("G-04", async () => { const result = await run("Hi, I’m looking for a CR-V", {}, { language: "en" }); assert.equal(result.facts.vehicle_model_interest, "CR-V"); assert.match(result.response ?? "", /Hi|What|May I/i); });
caseTest("G-05", async () => assert.equal((await run("tengo mil dolares para el enganche", withVehicle)).facts.down_payment_declared, 1000));
caseTest("G-06", async () => { const result = await run("", withVehicle, { mediaContext: { audioTranscriptionFailed: true } }); assert.equal(result.facts.down_payment_declared, undefined); assert.match(result.response ?? "", /escuch|repite/i); });
caseTest("G-07", async () => { const result = await run("Foto de un vehículo", withVehicle, { mediaContext: { imageClassifications: ["vehicle_photo"] } }); assert.equal(result.facts.has_trade_in, undefined); assert.match(result.response ?? "", /asesor/i); });

caseTest("H-01", async () => { const result = await run("*Headline:* $200 Seguro", {}, { isAdvertisementMetadata: true }); assert.equal(result.response, undefined); });
caseTest("H-02", async () => { const first = await run("Hola, busco una Tacoma", {}, { isFirstTurn: true, turnCount: 1 }); const second = await run("Hola, busco una Tacoma", first.facts, { turnCount: 2 }); assert.ok(first.response); assert.ok(second.response); assert.notEqual(first.response, undefined); });
caseTest("H-03", async () => { const result = await run("Hola, busco una Tacoma. Tengo $2,500.", {}, { isFirstTurn: true, turnCount: 1 }); assert.ok(result.response); assert.equal(result.facts.down_payment_declared, 2500); });
caseTest("H-04", async () => { assert.equal((await run("", {}, { isFirstTurn: true })).response, undefined); assert.equal((await run("🚗", {}, { isFirstTurn: true })).response, undefined); });
caseTest("H-05", async () => { const button = "Quiero financiar un auto 🚗"; const result = await run(button, {}, { isFirstTurn: true, turnCount: 1 }); assert.doesNotMatch(result.response ?? "", /Quiero financiar un auto/); });

caseTest("I-01", async () => assert.doesNotMatch((await run("Gracias", { ...withVehicle, down_payment_declared: 1000 })).response ?? "", /¿Con cuánto.*enganche/i));
caseTest("I-02", async () => assert.doesNotMatch((await run("Juan", { vehicle_category: "sedan" })).response ?? "", /con quién|nombre/i));
caseTest("I-03", async () => { const result = await run("¿Qué requisitos piden?", { ...withVehicle, down_payment_declared: 1000 }); assert.equal(result.facts.down_payment_declared, 1000); assert.match(result.response ?? "", /identificación|comprobante/i); });
caseTest("I-04", async () => assert.equal((await run("mejor $2,000", { ...withVehicle, down_payment_declared: 1000 })).facts.down_payment_declared, 2000));
caseTest("I-05", async () => { let prior: SofiaFacts = { ...withVehicle }; const responses: string[] = []; for (const message of ["Tengo $2,000", "Tengo un Civic para dar", "Nunca he financiado"]) { const result = await run(message, prior); prior = result.facts; responses.push(result.response ?? ""); } assert.equal(new Set(responses).size, 3); });
