import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { Pool } from "pg";
import { createPostgresPool } from "@/features/ghl-oauth/infrastructure/persistence/postgres/pool";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import type { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import { PostgresSofiaStateRepository } from "@/modules/control/infrastructure/persistence/postgres/postgres-sofia-state.repository";
import { SofiaConversationEngine } from "@/modules/decisions/domain/sofia-conversation";
import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import { PostgresHydrationRepository } from "@/modules/memory/infrastructure/persistence/postgres/postgres-hydration.repository";
import { LocalPolicyPackProvider } from "@/modules/memory/infrastructure/policies/local-policy-pack.provider";
import type { InboundMessage } from "@/modules/webhooks/domain/ghl-webhook-event";

const DATABASE_URL = process.env.LOCAL_WHATSAPP_DATABASE_URL;
const TENANT_ID = "00000000-0000-0000-0000-000000000901";
const LOCATION_ID = "local-country-club-location-001";
const CONTACT_ONE_UUID = "00000000-0000-0000-0000-000000000902";
const CONVERSATION_ONE_UUID = "00000000-0000-0000-0000-000000000903";
const CONTACT_TWO_UUID = "00000000-0000-0000-0000-000000000904";
const CONVERSATION_TWO_UUID = "00000000-0000-0000-0000-000000000905";
const CONTACT_THREE_UUID = "00000000-0000-0000-0000-000000000906";
const CONVERSATION_THREE_UUID = "00000000-0000-0000-0000-000000000907";
const CONTACT_FOUR_UUID = "00000000-0000-0000-0000-000000000908";
const CONVERSATION_FOUR_UUID = "00000000-0000-0000-0000-000000000909";
const CONTACT_FIVE_UUID = "00000000-0000-0000-0000-000000000910";
const CONVERSATION_FIVE_UUID = "00000000-0000-0000-0000-000000000911";
const CONTACT_SIX_UUID = "00000000-0000-0000-0000-000000000912";
const CONVERSATION_SIX_UUID = "00000000-0000-0000-0000-000000000913";
const CONTACT_SEVEN_UUID = "00000000-0000-0000-0000-000000000914";
const CONVERSATION_SEVEN_UUID = "00000000-0000-0000-0000-000000000915";
const CONTACT_EIGHT_UUID = "00000000-0000-0000-0000-000000000916";
const CONVERSATION_EIGHT_UUID = "00000000-0000-0000-0000-000000000917";
const CONTACT_ONE_ID = "ghl-contact-country-club-local-001";
const CONTACT_TWO_ID = "ghl-contact-country-club-local-002";
const CONTACT_THREE_ID = "ghl-contact-country-club-local-003";
const CONTACT_FOUR_ID = "ghl-contact-country-club-local-004";
const CONTACT_FIVE_ID = "ghl-contact-country-club-local-005";
const CONTACT_SIX_ID = "ghl-contact-country-club-local-006";
const CONTACT_SEVEN_ID = "ghl-contact-country-club-local-007";
const CONTACT_EIGHT_ID = "ghl-contact-country-club-local-008";
const CONVERSATION_ONE_ID = "ghl-conversation-country-club-local-001";
const CONVERSATION_TWO_ID = "ghl-conversation-country-club-local-002";
const CONVERSATION_THREE_ID = "ghl-conversation-country-club-local-003";
const CONVERSATION_FOUR_ID = "ghl-conversation-country-club-local-004";
const CONVERSATION_FIVE_ID = "ghl-conversation-country-club-local-005";
const CONVERSATION_SIX_ID = "ghl-conversation-country-club-local-006";
const CONVERSATION_SEVEN_ID = "ghl-conversation-country-club-local-007";
const CONVERSATION_EIGHT_ID = "ghl-conversation-country-club-local-008";

type CapturedOutbound = {
  tenantId: string;
  contactId: string;
  channel: string;
  content: string;
};

test(
  "LOCAL E2E WhatsApp: simula inbound GHL, hidrata Postgres, conversa y persiste Sofía",
  { skip: !DATABASE_URL },
  async () => {
    const pool = createPostgresPool(DATABASE_URL as string, false);
    const outbound: CapturedOutbound[] = [];
    try {
      await seedLocalCountryClub(pool);
      const hydrator = new ConversationHydrator(
        new PostgresHydrationRepository(pool),
        new LocalPolicyPackProvider(),
      );
      const fakeLocalOutbound = {
        sendSofiaResponse: async (input: CapturedOutbound) => {
          outbound.push(input);
          return { providerMessageId: `local-provider-message-${outbound.length}` };
        },
      } as unknown as QualificationFlowService;
      const orchestrator = new HydratingInboundConversationOrchestrator(
        hydrator,
        fakeLocalOutbound,
        { engine: new SofiaConversationEngine(), repository: new PostgresSofiaStateRepository(pool), dealerName: "Country Club Cars Inc." },
        undefined,
        false,
        { info: () => undefined, error: (message) => { throw new Error(message); } },
      );

      const spanishResponses = await runCustomerConversation(pool, orchestrator, {
        contactId: CONTACT_ONE_ID,
        conversationId: CONVERSATION_ONE_ID,
        conversationUuid: CONVERSATION_ONE_UUID,
        phone: "+13015550101",
        language: "es",
        messages: [
          "Hola, buenas tardes. Estoy buscando una Tacoma usada. ¿Qué requisitos piden? Mi crédito no es muy bueno.",
          "Me llamo Juan, mucho gusto.",
          "Pues cuento con como mil dólares para el enganche, no sé si alcance.",
          "No tengo carro para dar de parte de pago, pero sí trabajo por mi cuenta. ¿Puedo aplicar así?",
          "Nunca he financiado, sería mi primera vez. ¿Cuánto sería el pago mensual?",
          "La verdad solo estoy mirando por ahora, todavía no tengo fecha.",
          "Tal vez este mes si encuentro algo que me funcione.",
          "Sí, tengo estados de cuenta y talones de pago.",
        ],
      });

      assert.equal(spanishResponses.length, 8);
      assert.match(spanishResponses[0] ?? "", /requisitos|documentos|identificación|comprobante/i);
      assert.match(spanishResponses[0] ?? "", /2,?500/);
      assert.match(spanishResponses[2] ?? "", /mil|1,?000|2,?500|llegar/i);
      assert.match(spanishResponses[4] ?? "", /mensualidad|números exactos/i);
      assert.match(spanishResponses[5] ?? "", /semana|mes/i);
      assert.doesNotMatch(spanishResponses[7] ?? "", /teléfono|número/i);
      assertNoRepeatedResponseLines(spanishResponses);

      const englishResponses = await runCustomerConversation(pool, orchestrator, {
        contactId: CONTACT_TWO_ID,
        conversationId: CONVERSATION_TWO_ID,
        conversationUuid: CONVERSATION_TWO_UUID,
        phone: "+13015550102",
        language: "en",
        messages: [
          "Hi, I am interested in a Honda CR-V. Where are you located and what are your hours?",
          "My name is Maria.",
          "I can put $2,000 down. Do you have anything like that?",
          "Yes, I have a 2016 Nissan Sentra to trade, but I am still making payments.",
          "I have financed before, so this is not my first time.",
          "This week, if everything looks good.",
          "I have an employer letter and bank statements. What would the monthly payment be?",
        ],
      });

      assert.equal(englishResponses.length, 7);
      assert.match(englishResponses[0] ?? "", /8606 Wise Ave|hours/i);
      assert.match(englishResponses[1] ?? "", /May I have|down payment/i);
      assert.match(englishResponses[6] ?? "", /advisor|monthly|exact numbers/i);
      assertNoRepeatedResponseLines(englishResponses);

      const unknownModelResponses = await runCustomerConversation(pool, orchestrator, {
        contactId: CONTACT_THREE_ID,
        conversationId: CONVERSATION_THREE_ID,
        conversationUuid: CONVERSATION_THREE_UUID,
        phone: "+13015550103",
        language: "es",
        messages: [
          "Buenas, estoy mirando algo de Mazda pero todavía no sé si quiero carro o SUV. ¿Qué opciones manejan?",
          "Soy Carlos.",
          "Creo que una SUV para la familia. ¿Qué documentos tendría que llevar?",
          "Puedo dar 1k y no tengo carro para cambiar.",
          "Nunca he financiado, sería mi primera vez.",
          "Solo estoy mirando, todavía no tengo fecha.",
          "No, por ahora no estoy listo.",
        ],
      });
      assert.equal(unknownModelResponses.length, 7);
      assert.match(unknownModelResponses[0] ?? "", /qué vehículo|qué carro|SUV/i);
      assert.match(unknownModelResponses[2] ?? "", /identificación|comprobante/i);
      assert.doesNotMatch(unknownModelResponses[6] ?? "", /¿En cuánto tiempo|¿Le interesaría venir/i);
      assertNoRepeatedResponseLines(unknownModelResponses);

      const coSignerResponses = await runCustomerConversation(pool, orchestrator, {
        contactId: CONTACT_FOUR_ID,
        conversationId: CONVERSATION_FOUR_ID,
        conversationUuid: CONVERSATION_FOUR_UUID,
        phone: "+13015550104",
        language: "es",
        messages: [
          "Hola, necesito una Silverado. ¿Aceptan personas con poco crédito?",
          "Me llamo Luis.",
          "Tengo $2,500 para el enganche y mi hermano puede ser codeudor.",
          "No tengo carro para dar de parte de pago.",
          "Ya financié antes.",
          "Este mes.",
          "Todavía no tengo talones, pero sí tengo carta del empleador.",
        ],
      });
      assert.equal(coSignerResponses.length, 7);
      assert.match(coSignerResponses[0] ?? "", /2,?500|poco crédito|enganche/i);
      assert.match(coSignerResponses[2] ?? "", /parte de pago|carro/i);
      assert.match(coSignerResponses[6] ?? "", /asesor|información|gerente/i);
      assertNoRepeatedResponseLines(coSignerResponses);

      const typoResponses = await runCustomerConversation(pool, orchestrator, {
        contactId: CONTACT_FIVE_ID,
        conversationId: CONVERSATION_FIVE_ID,
        conversationUuid: CONVERSATION_FIVE_UUID,
        phone: "+13015550105",
        language: "es",
        messages: [
          "¡Olaa buenas! ando buscando una Rav4. Q requisitos piden...? tengo poko credito.",
          "Ana",
          "tengo mil dolares pal enganche, no tengo carro pa dar",
          "nunca e financiao y kiero saber la mensualida",
          "este mes si se puede",
          "si tengo estados de kuenta",
        ],
      });
      assert.equal(typoResponses.length, 6);
      assert.match(typoResponses[0] ?? "", /identificación|comprobante|requisitos/i);
      assert.match(typoResponses[2] ?? "", /2,?000|llegar|parte de pago/i);
      assert.match(typoResponses[3] ?? "", /mensualidad|números exactos|primera vez/i);
      assertNoRepeatedResponseLines(typoResponses);

      const terseResponses = await runBurstCustomerConversation(pool, orchestrator, {
        contactId: CONTACT_SIX_ID,
        conversationId: CONVERSATION_SIX_ID,
        conversationUuid: CONVERSATION_SIX_UUID,
        phone: "+13015550106",
        language: "es",
        messages: ["Hola", "Quiero", "un Crv", "2015"],
      });
      assert.equal(terseResponses.length, 1);
      assert.match(terseResponses[0] ?? "", /Country Club Cars|SUV|enganche|nombre/i);
      assert.doesNotMatch(terseResponses[0] ?? "", /Anoto \$2,015|enganche.*2,015/i);
      assertNoRepeatedResponseLines(terseResponses);

      const selfEmployedResponses = await runCustomerConversation(pool, orchestrator, {
        contactId: CONTACT_SEVEN_ID,
        conversationId: CONVERSATION_SEVEN_ID,
        conversationUuid: CONVERSATION_SEVEN_UUID,
        phone: "+13015550107",
        language: "es",
        messages: [
          "Buenas! Quiero una F-150, pero antes de seguir, ¿financian si uno trabaja por cuenta propia?",
          "Soy Roberto",
          "Cuento con $3,000 y no tengo carro de parte de pago.",
          "Ya he financiado antes.",
          "Estoy listo este mes. ¿Atienden los domingos?",
          "Tengo carta laboral.",
        ],
      });
      assert.equal(selfEmployedResponses.length, 6);
      assert.match(selfEmployedResponses[0] ?? "", /2,?500|F-150|enganche/i);
      assert.match(selfEmployedResponses[4] ?? "", /comprobante|talones|estados de cuenta/i);
      assert.match(selfEmployedResponses[5] ?? "", /asesor|información|gerente/i);
      assertNoRepeatedResponseLines(selfEmployedResponses);

      const familyTradeInResponses = await runCustomerConversation(pool, orchestrator, {
        contactId: CONTACT_EIGHT_ID,
        conversationId: CONVERSATION_EIGHT_ID,
        conversationUuid: CONVERSATION_EIGHT_UUID,
        phone: "+13015550108",
        language: "es",
        messages: [
          "Hola, ¿están abiertos hoy? ¡Necesito información!",
          "Me llamo Elena y quiero una Odyssey para la familia.",
          "Tengo dos mil de enganche y mi Jeep lo quiero dar de parte de pago, todavía lo debo. ¿Cuánto sería la mensualidad?",
          "Esta sería mi primera compra.",
          "Pronto, pero no sé el día.",
          "No tengo talones, solo efectivo.",
        ],
      });
      assert.equal(familyTradeInResponses.length, 6);
      assert.match(familyTradeInResponses[0] ?? "", /8606 Wise|horario|Estamos/i);
      assert.match(familyTradeInResponses[2] ?? "", /mensualidad|números exactos|parte de pago/i);
      assert.doesNotMatch(familyTradeInResponses[2] ?? "", /¿Con cuánto|¿Tiene un vehículo/i);
      assert.match(familyTradeInResponses[5] ?? "", /asesor|pendiente|información/i);
      assertNoRepeatedResponseLines(familyTradeInResponses);

      const stateRows = await pool.query<{
        ghl_contact_id: string;
        turn_count: number;
        lead_level: string;
        fields: Record<string, unknown>;
      }>(
        `SELECT contact.ghl_contact_id, state.turn_count, state.lead_level, state.fields
           FROM public.sofia_conversation_state AS state
           JOIN public.contacts AS contact ON contact.id = state.contact_id
          WHERE state.tenant_id = $1
          ORDER BY contact.ghl_contact_id`,
        [TENANT_ID],
      );
      assert.equal(stateRows.rowCount, 8);
      assert.equal(stateRows.rows[0]?.turn_count, 8);
      assert.equal(stateRows.rows[1]?.turn_count, 7);
      assert.equal(stateRows.rows[0]?.fields.contact_name, "Juan");
      assert.equal(stateRows.rows[1]?.fields.contact_name, "Maria");
      assert.equal(stateRows.rows[1]?.fields.handoff_completed, true);
      assert.equal(stateRows.rows[2]?.turn_count, 7);
      assert.equal(stateRows.rows[3]?.turn_count, 7);
      assert.equal(stateRows.rows[4]?.turn_count, 6);
      assert.equal(stateRows.rows[5]?.turn_count, 1);
      assert.equal(stateRows.rows[6]?.turn_count, 6);
      assert.equal(stateRows.rows[7]?.turn_count, 6);
      assert.ok(outbound.every((message) => message.channel === "WhatsApp"));
      assert.ok(outbound.every((message) => message.tenantId === TENANT_ID));
      assert.ok(outbound.every((message) => message.content.trim().length > 0));
      console.log(`LOCAL_WHATSAPP_SIMULATION ${JSON.stringify({ ids: { tenantId: TENANT_ID, locationId: LOCATION_ID, contacts: [CONTACT_ONE_ID, CONTACT_TWO_ID, CONTACT_THREE_ID, CONTACT_FOUR_ID, CONTACT_FIVE_ID, CONTACT_SIX_ID, CONTACT_SEVEN_ID, CONTACT_EIGHT_ID] }, conversations: [spanishResponses.length, englishResponses.length, unknownModelResponses.length, coSignerResponses.length, typoResponses.length, terseResponses.length, selfEmployedResponses.length, familyTradeInResponses.length], outboundCaptured: outbound.length, stateLevels: stateRows.rows.map((row) => row.lead_level) })}`);
    } finally {
      await pool.end();
    }
  },
);

function assertNoRepeatedResponseLines(responses: string[]): void {
  for (const response of responses) {
    const lines = response.split("\n").map((line) => line.trim()).filter(Boolean);
    assert.equal(new Set(lines).size, lines.length, `Respuesta repetida: ${response}`);
  }
  for (let index = 1; index < responses.length; index += 1) {
    assert.notEqual(responses[index], responses[index - 1]);
  }
}

async function runCustomerConversation(
  pool: Pool,
  orchestrator: HydratingInboundConversationOrchestrator,
  input: { contactId: string; conversationId: string; conversationUuid: string; phone: string; language: string; messages: string[] },
): Promise<string[]> {
  const responses: string[] = [];
  for (const [index, content] of input.messages.entries()) {
    const externalId = `ghl-wa-inbound-${input.contactId}-${String(index + 1).padStart(3, "0")}`;
    const message: InboundMessage & { receivedAt: string } = {
      externalId,
      providerMessageId: `ghl-provider-message-${externalId}`,
      contactId: input.contactId,
      conversationId: input.conversationId,
      phone: input.phone,
      channel: "WhatsApp",
      content,
      semanticHash: createHash("sha256").update(content, "utf8").digest("hex"),
      receivedAt: new Date(Date.UTC(2026, 7, 30, 15, index)).toISOString(),
    };
    await pool.query(
      `INSERT INTO public.messages (tenant_id, conversation_id, direction, sender_type, content, created_at)
       SELECT $1, conversation.id, 'inbound', 'client', $3, $4
         FROM public.conversations AS conversation
        WHERE conversation.id = $2::uuid`,
      [TENANT_ID, input.conversationUuid, content, message.receivedAt],
    );
    const localFlow = orchestrator as unknown as { process: (value: unknown) => Promise<void> };
    await localFlow.process({ tenantId: TENANT_ID, contactId: input.contactId, messages: [message], consolidatedText: content });
    const current = await latestLocalResponse(pool, input.contactId);
    if (!current) throw new Error(`No se generó respuesta local en turno ${index + 1}: ${content}`);
    responses.push(current);
    await pool.query(
      `INSERT INTO public.messages (tenant_id, conversation_id, direction, sender_type, content, created_at)
       SELECT $1, conversation.id, 'outbound', 'agent', $3, now()
         FROM public.conversations AS conversation
        WHERE conversation.id = $2::uuid`,
      [TENANT_ID, input.conversationUuid, current],
    );
  }
  return responses;
}

async function runBurstCustomerConversation(
  pool: Pool,
  orchestrator: HydratingInboundConversationOrchestrator,
  input: { contactId: string; conversationId: string; conversationUuid: string; phone: string; language: string; messages: string[] },
): Promise<string[]> {
  const messages = input.messages.map((content, index): InboundMessage & { receivedAt: string } => ({
    externalId: `ghl-wa-burst-${input.contactId}-${String(index + 1).padStart(3, "0")}`,
    providerMessageId: `ghl-provider-burst-message-${input.contactId}-${index + 1}`,
    contactId: input.contactId,
    conversationId: input.conversationId,
    phone: input.phone,
    channel: "WhatsApp",
    content,
    semanticHash: createHash("sha256").update(content, "utf8").digest("hex"),
    receivedAt: new Date(Date.UTC(2026, 7, 30, 17, index)).toISOString(),
  }));
  for (const message of messages) {
    await pool.query(
      `INSERT INTO public.messages (tenant_id, conversation_id, direction, sender_type, content, created_at)
       SELECT $1, conversation.id, 'inbound', 'client', $3, $4
         FROM public.conversations AS conversation
        WHERE conversation.id = $2::uuid`,
      [TENANT_ID, input.conversationUuid, message.content, message.receivedAt],
    );
  }
  const localFlow = orchestrator as unknown as { process: (value: unknown) => Promise<void> };
  await localFlow.process({
    tenantId: TENANT_ID,
    contactId: input.contactId,
    messages,
    consolidatedText: messages.map((message) => message.content).join("\n"),
  });
  const current = await latestLocalResponse(pool, input.contactId);
  if (!current) throw new Error(`No se generó respuesta local para el burst de ${input.contactId}`);
  await pool.query(
    `INSERT INTO public.messages (tenant_id, conversation_id, direction, sender_type, content, created_at)
     SELECT $1, conversation.id, 'outbound', 'agent', $3, now()
       FROM public.conversations AS conversation
      WHERE conversation.id = $2::uuid`,
    [TENANT_ID, input.conversationUuid, current],
  );
  return [current];
}

async function latestLocalResponse(pool: Pool, contactId: string): Promise<string | undefined> {
  const result = await pool.query<{ last_response: string | null }>(
    `SELECT state.last_response
       FROM public.sofia_conversation_state AS state
       JOIN public.contacts AS contact ON contact.id = state.contact_id
      WHERE state.tenant_id = $1 AND contact.ghl_contact_id = $2`,
    [TENANT_ID, contactId],
  );
  return result.rows[0]?.last_response ?? undefined;
}

async function seedLocalCountryClub(pool: Pool): Promise<void> {
  await pool.query("DELETE FROM public.tenants WHERE dealer_id = $1", [TENANT_ID]);
  await pool.query(
    `INSERT INTO public.tenants (dealer_id, ghl_location_id, timezone, policy_version, status, sofia_enabled, qualification_flow_enabled, qualification_signal_enabled)
     VALUES ($1, $2, 'America/Bogota', 'country_club_cars_v8', 'active', true, true, false)`,
    [TENANT_ID, LOCATION_ID],
  );
  const contacts = [
    [CONTACT_ONE_UUID, CONTACT_ONE_ID, "es"],
    [CONTACT_TWO_UUID, CONTACT_TWO_ID, "en"],
    [CONTACT_THREE_UUID, CONTACT_THREE_ID, "es"],
    [CONTACT_FOUR_UUID, CONTACT_FOUR_ID, "es"],
    [CONTACT_FIVE_UUID, CONTACT_FIVE_ID, "es"],
    [CONTACT_SIX_UUID, CONTACT_SIX_ID, "es"],
    [CONTACT_SEVEN_UUID, CONTACT_SEVEN_ID, "es"],
    [CONTACT_EIGHT_UUID, CONTACT_EIGHT_ID, "es"],
  ] as const;
  for (const [contactUuid, contactId, language] of contacts) {
    await pool.query(
      `INSERT INTO public.contacts (id, tenant_id, ghl_contact_id, preferred_language, consent_state)
       VALUES ($1::uuid, $2::uuid, $3::text, $4::text, 'granted')`,
      [contactUuid, TENANT_ID, contactId, language],
    );
  }
  const conversations = [
    [CONVERSATION_ONE_UUID, CONTACT_ONE_UUID],
    [CONVERSATION_TWO_UUID, CONTACT_TWO_UUID],
    [CONVERSATION_THREE_UUID, CONTACT_THREE_UUID],
    [CONVERSATION_FOUR_UUID, CONTACT_FOUR_UUID],
    [CONVERSATION_FIVE_UUID, CONTACT_FIVE_UUID],
    [CONVERSATION_SIX_UUID, CONTACT_SIX_UUID],
    [CONVERSATION_SEVEN_UUID, CONTACT_SEVEN_UUID],
    [CONVERSATION_EIGHT_UUID, CONTACT_EIGHT_UUID],
  ] as const;
  for (const [conversationUuid, contactUuid] of conversations) {
    await pool.query(
      `INSERT INTO public.conversations (id, tenant_id, contact_id, channel, state)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'whatsapp', 'open')`,
      [conversationUuid, TENANT_ID, contactUuid],
    );
  }
}
