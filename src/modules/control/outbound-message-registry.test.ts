import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { PostgresOutboundMessageRegistry } from "@/modules/control/infrastructure/persistence/postgres/postgres-outbound-message-registry";
import { RegisteredOutboundMessageSender } from "@/modules/control/application/registered-outbound-message-sender";

class FakeClient {
  readonly calls: Array<{ sql: string; values?: unknown[] }> = [];
  released = false;
  resultRows: Array<Record<string, unknown>> = [];
  resultCount = 0;

  async query<T = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number }> {
    this.calls.push({ sql, values });
    if (sql.includes("SELECT 1")) return { rows: this.resultRows as T[], rowCount: this.resultCount };
    return { rows: [], rowCount: this.resultCount };
  }

  release(): void { this.released = true; }
}

function createPool(client: FakeClient): Pool {
  return { connect: async () => client } as unknown as Pool;
}

test("outbound registry sets tenant context before every query", async () => {
  const client = new FakeClient();
  const registry = new PostgresOutboundMessageRegistry(createPool(client));
  await registry.register({ tenantId: "tenant-a", contactId: "contact-a", semanticHash: "hash-a", content: "Hola" });
  client.resultCount = 1;
  client.resultRows = [{}];
  assert.equal(await registry.wasIssuedBy1987({ tenantId: "tenant-a", contactId: "contact-a", semanticHash: "hash-a" }), true);

  const setConfigIndexes = client.calls
    .map((call, index) => call.sql.includes("set_config('app.tenant_id'") ? index : -1)
    .filter((index) => index >= 0);
  const dataIndexes = client.calls
    .map((call, index) => call.sql.includes("outbound_message_registry") ? index : -1)
    .filter((index) => index >= 0);
  assert.equal(setConfigIndexes.length, 2);
  assert.ok(setConfigIndexes[0] < dataIndexes[0]);
  assert.ok(setConfigIndexes[1] < dataIndexes[1]);
  assert.equal(client.released, true);
});

test("registered sender reserves before provider and attaches provider id after success", async () => {
  const events: string[] = [];
  const registry = {
    register: async () => { events.push("register"); },
    attachProviderMessageId: async () => { events.push("attach"); },
    wasIssuedBy1987: async () => false,
  };
  const sender = new RegisteredOutboundMessageSender(registry, {
    send: async () => {
      events.push("provider");
      return { providerMessageId: "provider-1" };
    },
  });
  await sender.send({ tenantId: "tenant-a", contactId: "contact-a", semanticHash: "hash-a", content: "Hola" });
  assert.deepEqual(events, ["register", "provider", "attach"]);
});
