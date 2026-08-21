import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient, QueryResultRow } from "pg";
import { PostgresDecisionLogRepository } from "@/modules/decisions/infrastructure/persistence/postgres/postgres-decision-log.repository";

class FakeClient {
  readonly calls: string[] = [];

  async query<T extends QueryResultRow>(sql: string): Promise<{ rows: T[]; rowCount: number }> {
    const normalized = sql.replace(/\s+/g, " ").trim();
    this.calls.push(normalized);
    return { rows: [] as T[], rowCount: 1 };
  }

  release(): void {}
}

class FakePool {
  readonly client = new FakeClient();

  async connect(): Promise<PoolClient> {
    return this.client as unknown as PoolClient;
  }
}

test("decision log repository sets tenant context before inserting under RLS", async () => {
  const pool = new FakePool();
  const repository = new PostgresDecisionLogRepository(pool as never);
  await repository.append({
    tenantId: "00000000-0000-0000-0000-000000000001",
    contactId: "00000000-0000-0000-0000-000000000002",
    inputVersion: "test_v1",
    decision: {
      allowedActions: ["STOP"],
      selectedAction: "STOP",
      reason: "test",
      localTimestamp: "2026-08-21T03:00:00-04:00",
      replyBlocked: true,
      gate: "COMPLIANCE",
    },
    modelTrace: { llmInvoked: false },
  });

  const setConfigIndex = pool.client.calls.findIndex((call) => call.startsWith("SELECT set_config"));
  const insertIndex = pool.client.calls.findIndex((call) => call.startsWith("INSERT INTO public.decision_logs"));
  assert.ok(setConfigIndex >= 0);
  assert.ok(insertIndex > setConfigIndex);
});
