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
const TENANT_ID = "00000000-0000-0000-0000-000000001003";
const LOCATION_ID = "local-country-club-down-payment-location";
const CONTACT_UUID = "00000000-0000-0000-0000-000000001201";
const CONVERSATION_UUID = "00000000-0000-0000-0000-000000002201";
const CONTACT_ID = "local-down-payment-contact";
const messages = [
  "Quiero financiar un auto",
  "Con Andrés mucho gusto",
  "Una troca barata",
  "Con 1500",
];

test("LOCAL DB E2E: reconoce Con 1500 como down payment y no repite el enganche", { skip: !DATABASE_URL }, async () => {
  const pool = createPostgresPool(DATABASE_URL as string, false);
  const outbound: string[] = [];
  try {
    await seed(pool);
    assert.equal(await ensureCountryClubPolicy(pool, LOCATION_ID), true);
    const hydrator = new ConversationHydrator(new PostgresHydrationRepository(pool), new LocalPolicyPackProvider());
    const fakeOutbound = {
      sendSofiaResponse: async (input: { content: string }) => {
        outbound.push(input.content);
        return { providerMessageId: "local-down-payment-" + outbound.length };
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
        messages: [{ externalId: "down-payment-" + (index + 1), contactId: CONTACT_ID, channel: "whatsapp", content: message, semanticHash: "down-payment-" + (index + 1), receivedAt: new Date().toISOString() }],
      });
    }

    assert.equal(outbound.length, messages.length);
    assert.match(outbound[1] ?? "", /Mucho gusto, Andrés\./i);
    assert.doesNotMatch(outbound[1] ?? "", /Andrés mucho gusto/i);
    assert.match(outbound[2] ?? "", /enganche/i);
    assert.doesNotMatch(outbound[3] ?? "", /¿Con cuánto.*enganche/i);

    const state = await pool.query<{ fields: Record<string, unknown>; last_response: string }>(
      "SELECT fields, last_response FROM public.sofia_conversation_state WHERE tenant_id = $1::uuid AND contact_id = $2::uuid",
      [TENANT_ID, CONTACT_UUID],
    );
    assert.equal(state.rows[0]?.fields.contact_name, "Andrés");
    assert.equal(state.rows[0]?.fields.vehicle_category, "work truck");
    assert.equal(state.rows[0]?.fields.down_payment_declared, 1500);
    assert.equal(state.rows[0]?.last_response, outbound[3]);
    console.log("LOCAL_DOWN_PAYMENT " + JSON.stringify({ policyVersion: "country_club_cars_v8", turns: messages.length, downPayment: state.rows[0]?.fields.down_payment_declared, outbound: outbound.length }));
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
    [CONVERSATION_UUID, TENANT_ID, CONTACT_UUID, "local-down-payment-conversation"],
  );
}
