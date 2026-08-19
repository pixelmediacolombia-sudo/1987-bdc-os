import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient, QueryResultRow } from "pg";
import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import type { HydrationRepositoryPort } from "@/modules/memory/application/ports/hydration-repository.port";
import { LocalPolicyPackProvider } from "@/modules/memory/infrastructure/policies/local-policy-pack.provider";
import { PostgresHydrationRepository } from "@/modules/memory/infrastructure/persistence/postgres/postgres-hydration.repository";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const GHL_CONTACT_ID = "ghl-contact-42";
const CONTACT_ID = "00000000-0000-0000-0000-000000000042";
const CONVERSATION_ID = "00000000-0000-0000-0000-000000000043";

type TraceEntry = { clientId: number; kind: "begin" | "set_config" | "select" | "commit" | "release" };

class FakeClient {
  constructor(private readonly clientId: number, private readonly trace: TraceEntry[]) {}

  async query<T extends QueryResultRow>(sql: string): Promise<{ rows: T[] }> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    if (normalized === "BEGIN") {
      this.trace.push({ clientId: this.clientId, kind: "begin" });
      return { rows: [] as T[] };
    }
    if (normalized.startsWith("SELECT set_config")) {
      this.trace.push({ clientId: this.clientId, kind: "set_config" });
      return { rows: [] as T[] };
    }
    if (normalized === "COMMIT") {
      this.trace.push({ clientId: this.clientId, kind: "commit" });
      return { rows: [] as T[] };
    }

    this.trace.push({ clientId: this.clientId, kind: "select" });
    if (normalized.includes("FROM public.tenants")) {
      return { rows: [{ id: TENANT_ID, timezone: "America/Bogota", policy_version: "default_v1", status: "active" }] as unknown as T[] };
    }
    if (normalized.includes("FROM public.contacts")) {
      return { rows: [{
        contact_id: CONTACT_ID,
        ghl_contact_id: GHL_CONTACT_ID,
        preferred_language: "es",
        consent_state: "unknown",
        conversation_id: CONVERSATION_ID,
        channel: "sms",
        state: "open",
      }] as unknown as T[] };
    }
    if (normalized.includes("FROM public.messages")) {
      return { rows: Array.from({ length: 12 }, (_, index) => ({
        direction: index % 2 === 0 ? "inbound" : "outbound",
        sender_type: index % 2 === 0 ? "client" : "agent",
        content: `message-${12 - index}`,
        created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, 12 - index)),
      })) as unknown as T[] };
    }
    if (normalized.includes("FROM public.facts")) {
      return { rows: [{ fact_key: "language", fact_value: "es" }, { fact_key: "budget", fact_value: "25000" }] as unknown as T[] };
    }
    if (normalized.includes("FROM public.objectives")) {
      return { rows: [{ objective_type: "down_payment", asked: true, answered: false, skipped: false }] as unknown as T[] };
    }
    throw new Error(`Unexpected fake SQL: ${normalized}`);
  }

  release(): void {
    this.trace.push({ clientId: this.clientId, kind: "release" });
  }
}

class FakePool {
  readonly trace: TraceEntry[] = [];
  private nextClientId = 1;

  async connect(): Promise<PoolClient> {
    return new FakeClient(this.nextClientId++, this.trace) as unknown as PoolClient;
  }
}

test("hidrata 12 mensajes cronológicos, hechos activos, ledger y política con RLS", async () => {
  const fakePool = new FakePool();
  const repository = new PostgresHydrationRepository(fakePool as never);
  const hydrator = new ConversationHydrator(repository, new LocalPolicyPackProvider(), 12);
  const context = await hydrator.hydrate(TENANT_ID, GHL_CONTACT_ID);

  assert.equal(context.transcript.length, 12);
  assert.equal(context.transcript[0]?.content, "message-1");
  assert.equal(context.transcript[11]?.content, "message-12");
  assert.deepEqual(context.activeFacts, { budget: "25000", language: "es" });
  assert.deepEqual(context.objectivesLedger, [{ objectiveType: "down_payment", asked: true, answered: false, skipped: false }]);
  assert.equal(context.tenant.policies.version, "default_v1");

  const clientIds = [...new Set(fakePool.trace.map((entry) => entry.clientId))];
  for (const clientId of clientIds) {
    const clientTrace = fakePool.trace.filter((entry) => entry.clientId === clientId);
    const setConfigIndex = clientTrace.findIndex((entry) => entry.kind === "set_config");
    const selectIndex = clientTrace.findIndex((entry) => entry.kind === "select");
    assert.ok(setConfigIndex >= 0, `RLS set_config missing on client ${clientId}`);
    assert.ok(selectIndex > setConfigIndex, `RLS set_config must precede SELECT on client ${clientId}`);
  }
});

test("rechaza límites de transcripción fuera del contrato 8..12", () => {
  const repository: HydrationRepositoryPort = {
    loadTenant: async () => ({ id: TENANT_ID, timezone: "America/Bogota", policyVersion: "default_v1", status: "active" }),
    loadContactConversation: async () => ({
      contact: { id: CONTACT_ID, ghlContactId: GHL_CONTACT_ID, preferredLanguage: "es", consentState: "unknown" },
      conversation: { id: CONVERSATION_ID, channel: "sms", state: "open" },
    }),
    loadRecentTranscript: async () => [],
    loadActiveFacts: async () => [],
    loadObjectives: async () => [],
  };
  const provider = { load: async () => ({
    version: "default_v1",
    downPayment: { min: null, max: null, currency: "USD" },
    quietHours: { enabled: false, start: null, end: null },
    humanHandoff: { enabled: true, triggers: [] },
  }) };

  assert.throws(() => new ConversationHydrator(repository, provider, 7), /between 8 and 12/);
  assert.throws(() => new ConversationHydrator(repository, provider, 13), /between 8 and 12/);
});
