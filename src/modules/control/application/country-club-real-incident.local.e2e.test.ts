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
const TENANT_ID = "00000000-0000-0000-0000-000000001002";
const LOCATION_ID = "local-country-club-incident-location";
const CONTACT_UUID = "00000000-0000-0000-0000-000000001101";
const CONVERSATION_UUID = "00000000-0000-0000-0000-000000002101";
const CONTACT_ID = "local-real-incident-contact";
const messages = [
  "Quiero financiar un auto 🚘",
  "Con Andrés como está!",
  "Con Andrés",
  "Enganche de que?",
  "Si no te he dicho que auto es",
];

test("LOCAL DB E2E: reproduce la captura y no repite ni inventa categoría", { skip: !DATABASE_URL }, async () => {
  const pool = createPostgresPool(DATABASE_URL as string, false);
  const outbound: string[] = [];
  try {
    await seed(pool);
    assert.equal(await ensureCountryClubPolicy(pool, LOCATION_ID), true);
    const hydrator = new ConversationHydrator(new PostgresHydrationRepository(pool), new LocalPolicyPackProvider());
    const fakeOutbound = {
      sendSofiaResponse: async (input: { content: string }) => {
        outbound.push(input.content);
        return { providerMessageId: `local-incident-${outbound.length}` };
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

    for (const [index, message] of messages.entries()) {
      await orchestrator.process({
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        consolidatedText: message,
        messages: [{ externalId: `incident-${index + 1}`, contactId: CONTACT_ID, channel: "whatsapp", content: message, semanticHash: `incident-${index + 1}`, receivedAt: new Date().toISOString() }],
      });
    }

    assert.equal(outbound.length, messages.length);
    assert.doesNotMatch(outbound[0] ?? "", /\$1,?500|Quiero financiar un auto|sedan|sedán/i);
    assert.match(outbound[1] ?? "", /¿Qué vehículo está buscando financiar\?/i);
    assert.match(outbound[2] ?? "", /Andrés/i);
    assert.match(outbound[3] ?? "", /toda la razón|carro.*SUV.*troca/i);
    assert.notEqual(outbound[4], outbound[3]);
    assert.match(outbound[4] ?? "", /vehículo|carro|SUV|troca/i);

    const state = await pool.query<{ fields: Record<string, unknown>; last_response: string }>(
      "SELECT fields, last_response FROM public.sofia_conversation_state WHERE tenant_id = $1::uuid AND contact_id = $2::uuid",
      [TENANT_ID, CONTACT_UUID],
    );
    assert.equal(state.rows[0]?.fields.vehicle_category, undefined);
    assert.equal(state.rows[0]?.fields.vehicle_model_interest, undefined);
    assert.equal(state.rows[0]?.fields.contact_name, "Andrés");
    assert.equal(state.rows[0]?.last_response, outbound[4]);
    console.log(`LOCAL_REAL_INCIDENT ${JSON.stringify({ policyVersion: "country_club_cars_v8", turns: messages.length, outbound: outbound.length, categoryAfterCorrection: state.rows[0]?.fields.vehicle_category ?? null })}`);
  } finally {
    await pool.query("DELETE FROM public.tenants WHERE dealer_id = $1::uuid", [TENANT_ID]).catch(() => undefined);
    await pool.end();
  }
});

async function seed(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM public.tenants WHERE dealer_id = $1::uuid", [TENANT_ID]);
  await pool.query(
    `INSERT INTO public.tenants (dealer_id, ghl_location_id, timezone, policy_version, status, sofia_enabled, qualification_flow_enabled, qualification_signal_enabled)
     VALUES ($1::uuid, $2, 'America/Bogota', 'country_club_cars_v8', 'active', true, true, false)`,
    [TENANT_ID, LOCATION_ID],
  );
  await pool.query(
    `INSERT INTO public.contacts (id, tenant_id, ghl_contact_id, preferred_language, consent_state)
     VALUES ($1::uuid, $2::uuid, $3, 'es', 'granted')`,
    [CONTACT_UUID, TENANT_ID, CONTACT_ID],
  );
  await pool.query(
    `INSERT INTO public.conversations (id, tenant_id, contact_id, ghl_conversation_id, channel, state)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'WhatsApp', 'open')`,
    [CONVERSATION_UUID, TENANT_ID, CONTACT_UUID, "local-real-incident-conversation"],
  );
}
