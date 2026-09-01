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
    if (sql.includes("RETURNING attempt_id")) {
      return {
        rows: [{ attemptId: "attempt-1", expiresAt: new Date(Date.now() + 300_000) }] as T[],
        rowCount: 1,
      };
    }
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
  const reservation = await registry.register({ tenantId: "tenant-a", contactId: "contact-a", semanticHash: "hash-a", content: "Hola" });
  assert.equal(reservation.attemptId, "attempt-1");
  assert.equal(client.calls.some((call) => call.sql.includes("ON CONFLICT (tenant_id, contact_id, semantic_hash)")), false);
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
    register: async () => { events.push("register"); return { attemptId: "attempt-1", expiresAt: new Date() }; },
    attachProviderMessageId: async (input: { attemptId: string }) => { events.push(`attach:${input.attemptId}`); },
    markFailed: async () => { events.push("failed"); },
    wasIssuedBy1987: async () => false,
  };
  const sender = new RegisteredOutboundMessageSender(registry, {
    send: async () => {
      events.push("provider");
      return { providerMessageId: "provider-1" };
    },
  });
  await sender.send({ tenantId: "tenant-a", contactId: "contact-a", semanticHash: "hash-a", content: "Hola" });
  assert.deepEqual(events, ["register", "provider", "attach:attempt-1"]);
});

test("registered sender marks a reservation failed when the provider fails", async () => {
  const events: string[] = [];
  const sender = new RegisteredOutboundMessageSender({
    register: async () => {
      events.push("register");
      return { attemptId: "attempt-failed", expiresAt: new Date() };
    },
    attachProviderMessageId: async () => { events.push("attach"); },
    markFailed: async (input: { attemptId: string }) => { events.push(`failed:${input.attemptId}`); },
    wasIssuedBy1987: async () => false,
  }, {
    send: async () => {
      events.push("provider");
      throw new Error("provider unavailable");
    },
  });

  await assert.rejects(
    sender.send({ tenantId: "tenant-a", contactId: "contact-a", semanticHash: "same-text", content: "Hola" }),
    /provider unavailable/,
  );
  assert.deepEqual(events, ["register", "provider", "failed:attempt-failed"]);
});

test("repeated text creates independent attempts and attaches each provider id", async () => {
  const registeredAttempts = ["attempt-1", "attempt-2"];
  const attached: string[] = [];
  let providerCall = 0;
  const sender = new RegisteredOutboundMessageSender({
    register: async () => ({ attemptId: registeredAttempts.shift() ?? "missing", expiresAt: new Date() }),
    attachProviderMessageId: async (input: { attemptId: string; providerMessageId: string }) => {
      attached.push(`${input.attemptId}:${input.providerMessageId}`);
    },
    markFailed: async () => undefined,
    wasIssuedBy1987: async () => false,
  }, {
    send: async () => {
      providerCall += 1;
      return { providerMessageId: `provider-${providerCall}` };
    },
  });

  const input = { tenantId: "tenant-a", contactId: "contact-a", semanticHash: "same-text", content: "Hola" };
  await sender.send(input);
  await sender.send(input);

  assert.deepEqual(attached, ["attempt-1:provider-1", "attempt-2:provider-2"]);
});

test("wasIssuedBy1987 prioritizes sent provider ids and only accepts live reservations by hash", async () => {
  const client = new FakeClient();
  client.resultCount = 1;
  client.resultRows = [{}];
  const registry = new PostgresOutboundMessageRegistry(createPool(client));

  assert.equal(await registry.wasIssuedBy1987({
    tenantId: "tenant-a",
    contactId: "contact-a",
    providerMessageId: "provider-1",
    semanticHash: "hash-a",
  }), true);

  const query = client.calls.find((call) => call.sql.includes("FROM public.outbound_message_registry") && call.sql.includes("SELECT 1"));
  assert.ok(query);
  assert.match(query.sql, /provider_message_id = \$3 AND status = 'sent'/);
  assert.match(query.sql, /semantic_hash = \$4 AND status = 'reserved' AND expires_at > now\(\)/);
  assert.deepEqual(query.values, ["tenant-a", "contact-a", "provider-1", "hash-a", null]);
});

test("wasIssuedBy1987 recognizes an active reservation by normalized content before provider id attachment", async () => {
  const client = new FakeClient();
  client.resultCount = 1;
  client.resultRows = [{}];
  const registry = new PostgresOutboundMessageRegistry(createPool(client));

  assert.equal(await registry.wasIssuedBy1987({
    tenantId: "tenant-a",
    contactId: "contact-a",
    semanticHash: "webhook-format-hash",
    content: "Perfecto, Andrés.\n¿Qué vehículo está buscando financiar?",
  }), true);

  const query = client.calls.find((call) => call.sql.includes("FROM public.outbound_message_registry") && call.sql.includes("SELECT 1"));
  assert.ok(query);
  assert.match(query.sql, /status = 'reserved'/);
  assert.match(query.sql, /regexp_replace\(btrim\(lower\(content\)\)/);
  assert.deepEqual(query.values, ["tenant-a", "contact-a", null, "webhook-format-hash", "Perfecto, Andrés.\n¿Qué vehículo está buscando financiar?"]);
});

test("provider association requires the active attempt and failed reservations become terminal", async () => {
  const client = new FakeClient();
  client.resultCount = 1;
  const registry = new PostgresOutboundMessageRegistry(createPool(client));

  await registry.attachProviderMessageId({
    tenantId: "tenant-a",
    attemptId: "attempt-1",
    providerMessageId: "provider-1",
  });
  await registry.markFailed({ tenantId: "tenant-a", attemptId: "attempt-2" });

  const attachQuery = client.calls.find((call) => call.sql.includes("SET provider_message_id"));
  const failureQuery = client.calls.find((call) => call.sql.includes("SET status = CASE"));
  assert.ok(attachQuery);
  assert.ok(failureQuery);
  assert.match(attachQuery.sql, /attempt_id = \$2/);
  assert.match(attachQuery.sql, /status = 'reserved'/);
  assert.match(attachQuery.sql, /expires_at > now\(\)/);
  assert.match(failureQuery.sql, /THEN 'expired' ELSE 'failed' END/);
  assert.deepEqual(attachQuery.values, ["tenant-a", "attempt-1", "provider-1"]);
  assert.deepEqual(failureQuery.values, ["tenant-a", "attempt-2"]);
});
