import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient, QueryResultRow } from "pg";
import { QuestionLedgerService } from "@/modules/decisions/application/QuestionLedgerService";
import { SemanticRepetitionValidator } from "@/modules/control/application/SemanticRepetitionValidator";
import { OutboundMessageRejectedError, RegisteredOutboundMessageSender } from "@/modules/control/application/registered-outbound-message-sender";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const CONTACT_ID = "00000000-0000-0000-0000-000000000002";

class Ticket8FakeClient {
  readonly calls: string[] = [];
  objective = { objective_type: "down_payment", asked: true, answered: false, skipped: false };
  decisionLogCount = 0;
  recentMessages: Array<{ content: string }> = [];

  async query<T extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.calls.push(normalized);
    if (normalized.startsWith("SELECT set_config") || normalized === "BEGIN" || normalized === "COMMIT" || normalized === "ROLLBACK") {
      return { rows: [] as T[], rowCount: 0 };
    }
    if (normalized.includes("FROM public.objectives")) {
      return { rows: [this.objective] as unknown as T[], rowCount: 1 };
    }
    if (normalized.startsWith("INSERT INTO public.objectives")) {
      this.objective = {
        objective_type: String(values[2]),
        asked: Boolean(values[3]),
        answered: Boolean(values[4]),
        skipped: Boolean(values[5]),
      };
      return { rows: [] as T[], rowCount: 1 };
    }
    if (normalized.includes("FROM public.messages")) {
      return { rows: this.recentMessages as unknown as T[], rowCount: this.recentMessages.length };
    }
    if (normalized.startsWith("INSERT INTO public.decision_logs")) {
      this.decisionLogCount += 1;
      return { rows: [] as T[], rowCount: 1 };
    }
    throw new Error(`Unexpected SQL in Ticket 8 test: ${normalized}`);
  }

  release(): void {}
}

class Ticket8FakePool {
  readonly client = new Ticket8FakeClient();

  async connect(): Promise<PoolClient> {
    return this.client as unknown as PoolClient;
  }
}

test("Ticket 8 / Ledger AC-03 blocks ASK_OBJECTIVE after down_payment is answered", async () => {
  const pool = new Ticket8FakePool();
  const ledger = new QuestionLedgerService(pool as never);

  await ledger.updateObjectiveState(TENANT_ID, CONTACT_ID, "down_payment", {
    asked: true,
    answered: true,
  });
  const state = await ledger.checkObjectiveState(TENANT_ID, CONTACT_ID, "down_payment");
  const decision = ledger.guardAction(state, "ASK_OBJECTIVE");

  console.info(`[Ticket8] ledger objective=${state.objectiveType} answered=${state.answered} action=${decision.action}`);
  assert.equal(state.answered, true);
  assert.equal(decision.allowed, false);
  assert.equal(decision.action, "WAIT");
  assert.match(decision.reason, /already answered or skipped/);

  const setConfigIndex = pool.client.calls.findIndex((call) => call.startsWith("SELECT set_config"));
  const objectiveWriteIndex = pool.client.calls.findIndex((call) => call.startsWith("INSERT INTO public.objectives"));
  assert.ok(setConfigIndex >= 0);
  assert.ok(objectiveWriteIndex > setConfigIndex, "RLS tenant context must precede the objective write");
});

test("Ticket 8 / semantic filter rejects an almost identical recent follow-up and logs the veto", async () => {
  const pool = new Ticket8FakePool();
  pool.client.recentMessages = [{
    content: "Este será mi último seguimiento por ahora... si ya no le interesa, solo dígamelo",
  }];
  const validator = new SemanticRepetitionValidator(pool as never, { threshold: 0.8 });
  const result = await validator.validate({
    tenantId: TENANT_ID,
    contactId: CONTACT_ID,
    content: "Este será mi último seguimiento... si ya no le interesa, por favor dígamelo",
  });

  console.info(`[Ticket8] candidateHash=${result.candidateHash} similarity=${result.match?.similarity.toFixed(3)} action=${result.action}`);
  assert.equal(result.accepted, false);
  assert.equal(result.action, "WAIT");
  assert.ok((result.match?.similarity ?? 0) > 0.8);
  assert.equal(pool.client.decisionLogCount, 1);
  const setConfigIndex = pool.client.calls.findIndex((call) => call.startsWith("SELECT set_config"));
  const messageReadIndex = pool.client.calls.findIndex((call) => call.includes("FROM public.messages"));
  const decisionLogIndex = pool.client.calls.findIndex((call) => call.startsWith("INSERT INTO public.decision_logs"));
  assert.ok(setConfigIndex >= 0);
  assert.ok(messageReadIndex > setConfigIndex);
  assert.ok(decisionLogIndex > messageReadIndex);
});

test("Ticket 8 / rejected candidates do not reach the outbound provider", async () => {
  const providerCalls: string[] = [];
  const sender = new RegisteredOutboundMessageSender(
    {
      register: async () => ({ attemptId: "attempt", expiresAt: new Date() }),
      attachProviderMessageId: async () => undefined,
      markFailed: async () => undefined,
      wasIssuedBy1987: async () => false,
    },
    {
      send: async () => {
        providerCalls.push("provider.send");
        return { providerMessageId: "provider-message" };
      },
    },
    {
      validate: async () => ({
        accepted: false,
        action: "HANDOFF",
        candidateHash: "hash",
        threshold: 0.8,
        reason: "repeat",
      }),
    },
  );

  await assert.rejects(
    sender.send({ tenantId: TENANT_ID, contactId: CONTACT_ID, content: "repeat", semanticHash: "hash" }),
    (error: unknown) => error instanceof OutboundMessageRejectedError && error.action === "HANDOFF",
  );
  assert.deepEqual(providerCalls, []);
});
