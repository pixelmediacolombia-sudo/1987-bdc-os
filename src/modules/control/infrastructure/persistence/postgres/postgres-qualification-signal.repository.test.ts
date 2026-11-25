import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { PostgresQualificationSignalRepository } from "@/modules/control/infrastructure/persistence/postgres/postgres-qualification-signal.repository";

test("an environment credential cannot bypass a disabled tenant CAPI flag", async () => {
  const statements: string[] = [];
  const client = {
    query: async (sql: string) => {
      statements.push(sql);
      if (sql.includes("FROM public.capi_events AS e")) {
        return {
          rows: [{
            id: "event-id",
            event_id: "event-1",
            event_name: "LeadSubmitted",
            payload_sent: { data: [] },
            meta_dataset_id: null,
            encrypted_meta_access_token: null,
            meta_test_event_code: null,
            meta_capi_enabled: false,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const repository = new PostgresQualificationSignalRepository(pool, [
    { tenantId: "tenant-a", datasetId: "synthetic-dataset", accessToken: "synthetic-token" },
  ]);

  const event = await repository.claimNextCapiEvent("tenant-a");

  assert.equal(event, undefined);
  assert.ok(statements.includes("COMMIT"));
  assert.equal(statements.some((sql) => sql.startsWith("UPDATE public.capi_events")), false);
});
