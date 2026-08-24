import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient, QueryResultRow } from "pg";
import { QuestionLedgerService } from "@/modules/decisions/application/QuestionLedgerService";
import { PolicyEvaluationService } from "@/modules/decisions/application/policy-evaluation.service";
import { PolicyEngine } from "@/modules/decisions/application/policy-engine";
import { SemanticRepetitionValidator } from "@/modules/control/application/SemanticRepetitionValidator";
import { OutboundMessageRejectedError, RegisteredOutboundMessageSender } from "@/modules/control/application/registered-outbound-message-sender";
import { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import { createInboundConversationOrchestrator } from "@/modules/control/infrastructure/composition/inbound-conversation-orchestrator.composer";

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

test("Ticket 8 / integrated decision flow logs WAIT when ASK_OBJECTIVE is terminal", async () => {
  const pool = new Ticket8FakePool();
  pool.client.objective = { objective_type: "down_payment", asked: true, answered: true, skipped: false };
  const logged: Array<{ decision: { selectedAction: string | null; reason: string } }> = [];
  const service = new PolicyEvaluationService(
    {
      load: async () => ({
        tenant: {
          id: TENANT_ID,
          timezone: "America/Bogota",
          policyVersion: "ticket8_v1",
          status: "active",
          policies: {
            version: "ticket8_v1",
            downPayment: { min: null, max: null, currency: "USD" },
            quietHours: { enabled: false, start: null, end: null },
            humanHandoff: { enabled: true, triggers: [] },
          },
        },
        contact: { id: CONTACT_ID, ghlContactId: "ghl-contact-2", consentState: "unknown" },
        activeFacts: {},
      }),
    },
    new PolicyEngine(),
    {
      append: async (input) => {
        logged.push({ decision: { selectedAction: input.decision.selectedAction, reason: input.decision.reason } });
        return { rlsEnforced: true };
      },
    },
    new QuestionLedgerService(pool as never),
  );

  const decision = await service.evaluateForContact({
    tenantId: TENANT_ID,
    ghlContactId: CONTACT_ID,
    objectiveType: "down_payment",
    requestedAction: "ASK_OBJECTIVE",
    source: "qualification-flow",
    externalId: "ticket8-integrated-1",
  });

  assert.equal(decision.selectedAction, "WAIT");
  assert.equal(decision.allowedActions.includes("ASK_OBJECTIVE"), false);
  assert.match(decision.reason, /ASK_OBJECTIVE blocked/);
  assert.equal(logged.length, 1);
  assert.equal(logged[0]?.decision.selectedAction, "WAIT");
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
  const pool = new Ticket8FakePool();
  pool.client.recentMessages = [{
    content: "Este será mi último seguimiento por ahora... si ya no le interesa, solo dígamelo",
  }];
  const providerCalls: string[] = [];
  let registryCalls = 0;
  const sender = new RegisteredOutboundMessageSender(
    {
      register: async () => {
        registryCalls += 1;
        return { attemptId: "attempt", expiresAt: new Date() };
      },
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
    new SemanticRepetitionValidator(pool as never, { threshold: 0.8 }),
  );

  const qualificationFlow = new QualificationFlowService({
    evaluateForContact: async (input) => {
      assert.equal(input.source, "qualification-flow");
      return { selectedAction: "ASK_OBJECTIVE" } as never;
    },
  }, sender);
  const decision = await qualificationFlow.evaluateObjective({
    tenantId: TENANT_ID,
    contactId: CONTACT_ID,
    objectiveType: "down_payment",
    requestedAction: "ASK_OBJECTIVE",
  });
  assert.equal(decision.selectedAction, "ASK_OBJECTIVE");

  await assert.rejects(
    qualificationFlow.sendCandidate({
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      content: "Este será mi último seguimiento... si ya no le interesa, por favor dígamelo",
      semanticHash: "hash",
      externalId: "ticket8-integrated-2",
    }),
    (error: unknown) => error instanceof OutboundMessageRejectedError && error.action === "WAIT",
  );
  assert.deepEqual(providerCalls, []);
  assert.equal(registryCalls, 0);
  assert.equal(pool.client.decisionLogCount, 1);
});

test("Ticket 8 / enabled composition fails closed without QualificationFlowService", () => {
  assert.throws(
    () => createInboundConversationOrchestrator({
      hydrator: {} as never,
      qualificationFlowEnabled: true,
    }),
    /requires QualificationFlowService composition/,
  );

  const orchestrator = createInboundConversationOrchestrator({
    hydrator: {} as never,
    qualificationFlowEnabled: false,
  });
  assert.ok(orchestrator);
});

test("Ticket 8 / enabled composition passes QualificationFlowService to the orchestrator", async () => {
  const calls: string[] = [];
  const qualificationFlow = {
    evaluateObjective: async () => {
      calls.push("evaluate");
      return { selectedAction: "WAIT" };
    },
    sendCandidate: async () => {
      calls.push("send");
      return { providerMessageId: "provider-message" };
    },
  } as never;
  const orchestrator = createInboundConversationOrchestrator({
    hydrator: {
      hydrate: async () => ({ conversation: { state: "active" } }),
    } as never,
    qualificationFlowEnabled: true,
    qualificationFlow,
  });

  await orchestrator.process({
    tenantId: TENANT_ID,
    contactId: CONTACT_ID,
    messages: [],
    consolidatedText: "Necesito información",
    objectiveType: "down_payment",
    requestedAction: "ASK_OBJECTIVE",
  });

  assert.deepEqual(calls, ["evaluate"]);
});
