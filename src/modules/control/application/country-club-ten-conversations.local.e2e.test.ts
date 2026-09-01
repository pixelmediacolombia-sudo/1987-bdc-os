import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { createPostgresPool } from "@/features/ghl-oauth/infrastructure/persistence/postgres/pool";
import { ensureCountryClubPolicy } from "@/modules/control/infrastructure/persistence/postgres/country-club-policy.migration";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import type { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import { PostgresSofiaStateRepository } from "@/modules/control/infrastructure/persistence/postgres/postgres-sofia-state.repository";
import { SofiaConversationEngine } from "@/modules/decisions/domain/sofia-conversation";
import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import { PostgresHydrationRepository } from "@/modules/memory/infrastructure/persistence/postgres/postgres-hydration.repository";
import { LocalPolicyPackProvider } from "@/modules/memory/infrastructure/policies/local-policy-pack.provider";

const DATABASE_URL = process.env.LOCAL_WHATSAPP_DATABASE_URL;
const TENANT_ID = "00000000-0000-0000-0000-000000001001";
const LOCATION_ID = "local-country-club-ten-location";

const scenarios = [
  { id: "01-normal", language: "es", messages: ["Me llamo Ana, busco un Camry y tengo $2,000"] },
  { id: "02-requirements", language: "es", messages: ["Soy Luis", "¿Qué requisitos piden?"] },
  { id: "03-location", language: "es", messages: ["Soy Marta", "¿Dónde están?"] },
  { id: "04-low-down-payment", language: "es", messages: ["Soy Carlos, busco una Tacoma", "Tengo $1,000"] },
  { id: "05-no-trade", language: "es", messages: ["Soy Elena, busco una SUV", "Tengo $2,000", "no tengo carro para dar"] },
  { id: "06-typos", language: "es", messages: ["Olaa, kiero una SUV", "tengo mil dolares pal enganche"] },
  { id: "07-english", language: "en", messages: ["Hi, I’m looking for a CR-V", "What do I need to buy a vehicle?"] },
  { id: "08-fragmented", language: "es", messages: ["Hola", "Busco", "Una SUV"] },
  { id: "09-not-ready", language: "es", messages: ["Soy Rosa", "solo estoy mirando", "No, por ahora no estoy listo"] },
  { id: "10-qualified-handoff", language: "es", messages: ["Soy Pedro, busco un Camry", "$2,000", "no tengo carro", "nunca he financiado", "esta semana", "sí tengo talones"] },
] as const;

test("LOCAL DB E2E: 10 conversaciones Country Club cubren respuestas y persistencia", { skip: !DATABASE_URL }, async () => {
  const pool = createPostgresPool(DATABASE_URL as string, false);
  const outbound: Array<{ scenario: string; content: string }> = [];
  try {
    await seed(pool);
    assert.equal(await ensureCountryClubPolicy(pool, LOCATION_ID), true);
    const policyRow = await pool.query<{ policy_version: string }>("SELECT policy_version FROM public.tenants WHERE dealer_id = $1", [TENANT_ID]);
    assert.equal(policyRow.rows[0]?.policy_version, "country_club_cars_v8");

    const hydrator = new ConversationHydrator(new PostgresHydrationRepository(pool), new LocalPolicyPackProvider());
    const fakeOutbound = {
      sendSofiaResponse: async (input: { contactId: string; content: string }) => {
        outbound.push({ scenario: input.contactId, content: input.content });
        return { providerMessageId: `local-ten-provider-${outbound.length}` };
      },
    } as unknown as QualificationFlowService;
    const orchestrator = new HydratingInboundConversationOrchestrator(
      hydrator,
      fakeOutbound,
      { engine: new SofiaConversationEngine(), repository: new PostgresSofiaStateRepository(pool), dealerName: "Country Club Cars Inc." },
      undefined,
      false,
      { info: () => undefined, error: (message) => { throw new Error(message); } },
    );

    const outcomes: Array<{ id: string; responses: number; lastResponse?: string; leadLevel?: string }> = [];
    for (const [index, scenario] of scenarios.entries()) {
      const contactUuid = `00000000-0000-0000-0000-0000000010${String(index + 1).padStart(2, "0")}`;
      const contactId = `local-ten-${scenario.id}`;
      let before = outbound.length;
      for (const [turn, message] of scenario.messages.entries()) {
        await orchestrator.process({
          tenantId: TENANT_ID,
          contactId,
          consolidatedText: message,
          messages: [{ externalId: `${scenario.id}-${turn + 1}`, contactId, channel: "whatsapp", content: message, semanticHash: `${scenario.id}-${turn + 1}`, receivedAt: new Date().toISOString() }],
        });
      }
      const state = await pool.query<{ turn_count: number; lead_level: string; last_response: string | null }>(
        `SELECT turn_count, lead_level, last_response FROM public.sofia_conversation_state
          WHERE tenant_id = $1 AND contact_id = $2::uuid`,
        [TENANT_ID, contactUuid],
      );
      const saved = state.rows[0];
      assert.ok(saved, `missing persisted state for ${scenario.id}`);
      assert.equal(saved.turn_count, scenario.messages.length);
      assert.ok(saved.last_response);
      outcomes.push({ id: scenario.id, responses: outbound.length - before, lastResponse: saved.last_response ?? undefined, leadLevel: saved.lead_level });
    }

    assert.equal(outcomes.length, 10);
    assert.ok(outcomes.every((outcome) => outcome.responses >= 1));
    assert.ok(outcomes.some((outcome) => /8606 Wise Ave/.test(outcome.lastResponse ?? "")));
    assert.ok(outcomes.some((outcome) => /ITIN|identificación|comprobante/i.test(outcome.lastResponse ?? "")));
    assert.ok(outcomes.some((outcome) => /2,?500|llegar/i.test(outcome.lastResponse ?? "")));
    assert.ok(outcomes.some((outcome) => outcome.leadLevel === "A"));
    assert.equal(new Set(outbound.map((message) => message.content)).size > 1, true);
    console.log(`LOCAL_DB_10_CONVERSATIONS ${JSON.stringify({ policyVersion: policyRow.rows[0]?.policy_version, conversations: outcomes.map(({ id, responses, leadLevel }) => ({ id, responses, leadLevel })), outbound: outbound.length })}`);
  } finally {
    await pool.query("DELETE FROM public.tenants WHERE dealer_id = $1", [TENANT_ID]).catch(() => undefined);
    await pool.end();
  }
});

async function seed(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM public.tenants WHERE dealer_id = $1", [TENANT_ID]);
  await pool.query(
    `INSERT INTO public.tenants (dealer_id, ghl_location_id, timezone, policy_version, status, sofia_enabled, qualification_flow_enabled, qualification_signal_enabled)
     VALUES ($1::uuid, $2, 'America/Bogota', 'default_v1', 'active', true, true, false)`,
    [TENANT_ID, LOCATION_ID],
  );
  for (const [index, scenario] of scenarios.entries()) {
    const contactUuid = `00000000-0000-0000-0000-0000000010${String(index + 1).padStart(2, "0")}`;
    const conversationUuid = `00000000-0000-0000-0000-0000000020${String(index + 1).padStart(2, "0")}`;
    const contactId = `local-ten-${scenario.id}`;
    await pool.query(
      `INSERT INTO public.contacts (id, tenant_id, ghl_contact_id, preferred_language, consent_state)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'granted')`,
      [contactUuid, TENANT_ID, contactId, scenario.language],
    );
    await pool.query(
      `INSERT INTO public.conversations (id, tenant_id, contact_id, ghl_conversation_id, channel, state)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'WhatsApp', 'open')`,
      [conversationUuid, TENANT_ID, contactUuid, `local-ten-conversation-${scenario.id}`],
    );
  }
}
