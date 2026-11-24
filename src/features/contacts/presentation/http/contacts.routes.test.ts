import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import type { Pool } from "pg";
import { createContactsRouter } from "@/features/contacts/presentation/http/contacts.routes";

const dealerId = "11111111-1111-4111-8111-111111111111";
const otherDealerId = "22222222-2222-4222-8222-222222222222";
const contactId = "33333333-3333-4333-8333-333333333333";
const user = { id: "44444444-4444-4444-8444-444444444444", email: "dealer@example.test", display_name: "Dealer", account_type: "user" };

function fakePool(options: { accountType?: "admin" | "user"; member?: boolean; contact?: boolean; duplicate?: boolean } = {}) {
  const trace: string[] = [];
  let displayName = "Ana Prueba";
  const connection = {
    query: async (sql: string, values?: unknown[]) => {
      trace.push(sql);
      if (sql.startsWith("SELECT set_config")) return { rows: [{ set_config: dealerId }], rowCount: 1 };
      if (sql.includes("FROM public.tenants")) return { rows: [{ id: dealerId, name: null }], rowCount: 1 };
      if (sql.includes("FROM public.contacts") && sql.includes("SELECT id::text AS id")) return options.duplicate
        ? { rows: [{ id: contactId }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
      if (sql.includes("COUNT(*)::int AS total")) return { rows: [{ total: 1 }], rowCount: 1 };
      if (sql.includes("COUNT(DISTINCT cv.id)")) return { rows: [{
        id: contactId, dealerId, providerContactId: "manual:contact-1", displayName, source: "manual", phone: "+15550101000", email: null,
        preferredLanguage: "en", consentState: "unknown", createdAt: "2026-11-24T10:00:00.000Z",
        updatedAt: "2026-11-24T10:00:00.000Z", conversationCount: 1, lastActivity: "2026-11-24T10:00:00.000Z",
        channels: ["messenger"],
      }], rowCount: 1 };
      if (sql.includes("FROM public.contacts AS c WHERE c.id =")) return options.contact === false
        ? { rows: [], rowCount: 0 }
        : { rows: [{
          id: contactId, dealerId, providerContactId: "manual:contact-1", displayName, source: "manual", phone: "+15550101000", email: null,
          preferredLanguage: "en", consentState: "unknown", createdAt: "2026-11-24T10:00:00.000Z",
          updatedAt: "2026-11-24T10:00:00.000Z",
        }], rowCount: 1 };
      if (sql.includes("FROM (SELECT * FROM public.conversations")) return { rows: [{
        conversationId: "55555555-5555-4555-8555-555555555555", channel: "messenger", owner: null, state: "open",
        lastActivity: "2026-11-24T10:00:00.000Z", messageId: "66666666-6666-4666-8666-666666666666",
        direction: "inbound", senderType: "contact", content: "Mensaje de prueba", createdAt: "2026-11-24T10:00:00.000Z",
      }], rowCount: 1 };
      if (sql.includes("INSERT INTO public.contacts")) return { rows: [{
        id: contactId, dealerId, providerContactId: "manual:contact-1", displayName: "Ana Prueba", source: "manual",
        phone: "+15550101000", email: "ana@example.test", preferredLanguage: "es", consentState: "unknown",
        createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T10:00:00.000Z",
      }], rowCount: 1 };
      if (sql.includes("UPDATE public.contacts AS c SET")) return { rows: [{
        id: contactId, dealerId, providerContactId: "manual:contact-1", displayName: (displayName = String(values?.[2] ?? displayName)), source: "manual",
        phone: "+15550101000", email: null, preferredLanguage: "es", consentState: "unknown",
        createdAt: "2026-11-24T10:00:00.000Z", updatedAt: "2026-11-24T11:00:00.000Z",
      }], rowCount: 1 };
      if (sql.includes("INSERT INTO public.admin_audit_events")) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    release: () => undefined,
  };
  const pool = {
    query: async (sql: string) => {
      trace.push(sql);
      if (sql.includes("FROM public.app_sessions AS s")) return { rows: [{ ...user, account_type: options.accountType ?? "user" }], rowCount: 1 };
      if (sql.includes("FROM public.user_tenant_memberships WHERE user_id = $1 AND tenant_id")) return options.member === false ? { rows: [], rowCount: 0 } : { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (sql.includes("FROM public.user_tenant_memberships WHERE user_id")) return { rows: [{ tenant_id: dealerId }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
    connect: async () => connection,
    trace,
  };
  return pool as unknown as Pool & { trace: string[] };
}

async function send(path: string, pool = fakePool()) {
    const app = express();
    app.use(express.json());
  app.use("/auth", createContactsRouter(pool));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const bound = server.address();
  if (!bound || typeof bound === "string") throw new Error("Test server did not bind");
  try {
    const response = await fetch("http://127.0.0.1:" + bound.port + "/auth" + path, { headers: { cookie: "bdc_os_session=local-session" } });
    const payload = await response.json() as Record<string, any>;
    return { response, payload, pool };
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

test("dealer contacts require a dealer account", async () => {
  const result = await send("/contacts?dealerId=" + dealerId, fakePool({ accountType: "admin" }));
  assert.equal(result.response.status, 403);
});

test("dealer contact list checks membership and scopes reads to the selected tenant", async () => {
  const denied = await send("/contacts?dealerId=" + otherDealerId, fakePool({ member: false }));
  assert.equal(denied.response.status, 403);
  const allowed = await send("/contacts?dealerId=" + dealerId + "&search=1555");
  assert.equal(allowed.response.status, 200);
  assert.equal(allowed.payload.contacts[0].phone, "+15550101000");
  assert.equal(allowed.payload.total, 1);
  assert.ok(allowed.pool.trace.some((sql) => sql.includes("set_config('app.tenant_id'")));
});

test("contact detail exposes the selected dealer conversation history", async () => {
  const result = await send("/contacts/" + contactId + "?dealerId=" + dealerId);
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.contact.conversations[0].messages[0].content, "Mensaje de prueba");
});

test("contact detail returns not found when the contact is not in that dealer", async () => {
  const result = await send("/contacts/" + contactId + "?dealerId=" + dealerId, fakePool({ contact: false }));
  assert.equal(result.response.status, 404);
});

test("dealer user can create a manual contact and the change is audited", async () => {
  const pool = fakePool();
  const app = express();
  app.use(express.json());
  app.use("/auth", createContactsRouter(pool));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/auth/contacts`, {
      method: "POST", headers: { cookie: "bdc_os_session=local-session", "content-type": "application/json" },
      body: JSON.stringify({ dealerId, displayName: "Ana Prueba", phone: "+15550101000", email: "ANA@example.test", preferredLanguage: "es" }),
    });
    const payload = await response.json() as { contact: { source: string; displayName: string }; error?: string };
    assert.equal(response.status, 201, payload.error ?? "Contact creation failed");
    assert.equal(payload.contact.source, "manual");
    assert.equal(payload.contact.displayName, "Ana Prueba");
    assert.ok(pool.trace.some((sql) => sql.includes("INSERT INTO public.admin_audit_events")));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("manual contact creation rejects existing phone/email instead of merging identities", async () => {
  const pool = fakePool({ duplicate: true });
  const app = express();
  app.use(express.json());
  app.use("/auth", createContactsRouter(pool));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/auth/contacts`, {
      method: "POST", headers: { cookie: "bdc_os_session=local-session", "content-type": "application/json" },
      body: JSON.stringify({ dealerId, displayName: "Ana Prueba", phone: "+15550101000" }),
    });
    assert.equal(response.status, 409);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("dealer user can update contact fields and writes an audit event without exposing consent edits", async () => {
  const pool = fakePool();
  const app = express();
  app.use(express.json());
  app.use("/auth", createContactsRouter(pool));
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind");
  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/auth/contacts/${contactId}?dealerId=${dealerId}`, {
      method: "PATCH", headers: { cookie: "bdc_os_session=local-session", "content-type": "application/json" },
      body: JSON.stringify({ displayName: "Ana Editada", preferredLanguage: "es", consentState: "granted" }),
    });
    const payload = await response.json() as { contact: { displayName: string; consentState: string }; error?: string };
    assert.equal(response.status, 200, payload.error ?? "Contact update failed");
    assert.equal(payload.contact.displayName, "Ana Editada");
    assert.equal(payload.contact.consentState, "unknown");
    assert.ok(pool.trace.some((sql) => sql.includes("UPDATE public.contacts AS c SET")));
    assert.ok(pool.trace.some((sql) => sql.includes("INSERT INTO public.admin_audit_events")));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
