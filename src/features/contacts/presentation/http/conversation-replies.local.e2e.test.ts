import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { Pool } from "pg";
import test from "node:test";
import { createIdentityRouter } from "@/features/identity/presentation/http/identity.routes";
import { ensureTenantRowLevelSecurity } from "@/features/identity/infrastructure/persistence/postgres/tenant-rls.migration";
import { ensureAdminAuditTable } from "@/features/identity/infrastructure/persistence/postgres/admin-audit.migration";
import { ensureConversationWorkflowColumns } from "@/features/contacts/infrastructure/persistence/postgres/conversation-workflow.migration";
import { ensureConversationMessageDelivery } from "@/features/contacts/infrastructure/persistence/postgres/conversation-messages.migration";
import { ensureWebhookTables } from "@/modules/webhooks/infrastructure/persistence/postgres/webhooks.migration";
import { MetaGraphApiError } from "@/features/meta/infrastructure/meta-graph-api.client";

const localE2E = process.env.CRM_REPLIES_E2E === "1" && Boolean(process.env.DATABASE_URL);

test("CRM replies persist by dealer, identify the sender, and prevent duplicate delivery", { skip: !localE2E }, async () => {
  const ssl = ["1", "true", "yes"].includes((process.env.PGSSL ?? "").toLowerCase()) ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const apiPool = new Pool({
    connectionString: process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl,
    ...(process.env.RUNTIME_DATABASE_URL ? {} : { options: "-c role=bdc" }),
  });
  const migrationPool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL, ssl });
  try {
    await ensureWebhookTables(migrationPool);
    await ensureAdminAuditTable(migrationPool);
    await ensureConversationWorkflowColumns(migrationPool);
    await ensureConversationMessageDelivery(migrationPool);
    await ensureTenantRowLevelSecurity(migrationPool);
  } finally { await migrationPool.end(); }

  const fixture = await pool.connect();
  const tenantIds = [randomUUID(), randomUUID()];
  const userIds = [randomUUID(), randomUUID()];
  const contactIds = [randomUUID(), randomUUID()];
  const conversationIds = [randomUUID(), randomUUID()];
  const tokens = [randomBytes(32).toString("base64url"), randomBytes(32).toString("base64url")];
  const tokenHashes = tokens.map((token) => createHash("sha256").update(token).digest("hex"));
  const auditIds = [randomUUID(), randomUUID(), randomUUID()];
  const providerCalls: Array<{ tenantId: string; contactId: string; content: string; channel: string; clientMessageId: string }> = [];
  const failedOnce = new Set<string>();
  let server: ReturnType<express.Application["listen"]> | undefined;
  const app = express();
  app.use(express.json());
  app.use("/auth", createIdentityRouter(apiPool, {
    production: false,
    conversationReplySender: {
      async send(input) {
        providerCalls.push(input);
        if (input.content === "temporary rejection" && !failedOnce.has(input.clientMessageId)) {
          failedOnce.add(input.clientMessageId);
          throw new MetaGraphApiError("Synthetic provider rejection", 400);
        }
        if (input.content === "uncertain delivery") throw new MetaGraphApiError("Synthetic timeout after request");
        return { providerMessageId: `provider-${input.clientMessageId}` };
      },
    },
  }));
  const request = (port: number, index: number, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { cookie: `bdc_os_session=${tokens[index]}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });
  try {
    await fixture.query("INSERT INTO public.app_users (id, email, display_name, account_type, status) VALUES ($1, $2, $3, 'user', 'active'), ($4, $5, $6, 'user', 'active')", [
      userIds[0], `crm-reply-${randomUUID()}@example.test`, "Asesora CRM 1", userIds[1], `crm-reply-${randomUUID()}@example.test`, "Asesor CRM 2",
    ]);
    for (const [index, tenantId] of tenantIds.entries()) {
      await fixture.query("BEGIN");
      await fixture.query("SET LOCAL ROLE bdc");
      await fixture.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await fixture.query(
        `INSERT INTO public.tenants (dealer_id, dealer_name, timezone, policy_version, status, sofia_enabled, qualification_flow_enabled, qualification_signal_enabled)
         VALUES ($1, $2, 'America/Bogota', 'crm-replies-e2e', 'active', false, false, false)`,
        [tenantId, `CRM Reply Dealer ${index + 1}`],
      );
      await fixture.query(
        `INSERT INTO public.contacts (id, tenant_id, provider_contact_id, display_name, phone, preferred_language, consent_state)
         VALUES ($1, $2, $3, $4, $5, 'es', 'unknown')`,
        [contactIds[index], tenantId, `provider-contact-${contactIds[index]}`, `CRM Reply Contact ${index + 1}`, `+1 555 02${index}00`],
      );
      await fixture.query("INSERT INTO public.conversations (id, tenant_id, contact_id, provider_conversation_id, channel, state) VALUES ($1, $2, $3, $4, 'messenger', 'open')", [conversationIds[index], tenantId, contactIds[index], `provider-conversation-${conversationIds[index]}`]);
      await fixture.query("INSERT INTO public.user_tenant_memberships (user_id, tenant_id) VALUES ($1, $2)", [userIds[index], tenantId]);
      await fixture.query("COMMIT");
      await fixture.query("INSERT INTO public.app_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')", [userIds[index], tokenHashes[index]]);
    }

    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    const send = (dealerIndex: number, clientMessageId: string, content: string, conversationIndex = dealerIndex) => request(
      port,
      dealerIndex,
      `/auth/conversations/${conversationIds[conversationIndex]}/messages?dealerId=${tenantIds[dealerIndex]}`,
      { method: "POST", headers: { "x-correlation-id": auditIds[0] }, body: JSON.stringify({ clientMessageId, content }) },
    );

    const successKey = randomUUID();
    const success = await send(0, successKey, "Hola desde el equipo");
    assert.equal(success.status, 201);
    const successBody = await success.json() as { message: { status: string; senderUserId: string; senderName: string; content: string; externalId?: string }; replayed: boolean };
    assert.equal(successBody.message.status, "sent");
    assert.equal(successBody.message.senderUserId, userIds[0]);
    assert.equal(successBody.message.senderName, "Asesora CRM 1");
    assert.equal(successBody.message.content, "Hola desde el equipo");
    assert.equal(successBody.replayed, false);
    assert.deepEqual(providerCalls[0], {
      tenantId: tenantIds[0], contactId: `provider-contact-${contactIds[0]}`, content: "Hola desde el equipo", channel: "FB", clientMessageId: successKey,
    });

    const duplicate = await send(0, successKey, "Hola desde el equipo");
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json() as { replayed: boolean }).replayed, true);
    assert.equal(providerCalls.length, 1, "a replay does not contact the provider twice");
    const conflict = await send(0, successKey, "Contenido distinto");
    assert.equal(conflict.status, 409, "a reused idempotency key cannot change message content");

    const crossDealer = await send(1, randomUUID(), "Cross dealer attempt", 0);
    assert.equal(crossDealer.status, 404, "a conversation from another dealer is hidden");
    assert.equal(providerCalls.length, 1, "a cross-tenant attempt is never sent");

    const retryKey = randomUUID();
    const rejected = await send(0, retryKey, "temporary rejection");
    assert.equal(rejected.status, 502);
    assert.equal((await rejected.json() as { message: { status: string } }).message.status, "failed");
    const retried = await send(0, retryKey, "temporary rejection");
    assert.equal(retried.status, 201);
    assert.equal((await retried.json() as { message: { status: string } }).message.status, "sent");

    const uncertainKey = randomUUID();
    const uncertain = await send(0, uncertainKey, "uncertain delivery");
    assert.equal(uncertain.status, 502);
    assert.equal((await uncertain.json() as { message: { status: string } }).message.status, "uncertain");
    const callCountAfterUncertainty = providerCalls.length;
    const blockedRetry = await send(0, uncertainKey, "uncertain delivery");
    assert.equal(blockedRetry.status, 409);
    assert.equal(providerCalls.length, callCountAfterUncertainty, "an uncertain delivery is never resent automatically");

    const history = await request(port, 0, `/auth/contacts/${contactIds[0]}?dealerId=${tenantIds[0]}`);
    assert.equal(history.status, 200);
    const historyBody = await history.json() as { contact: { conversations: Array<{ messages: Array<{ content: string; senderName: string; status: string }> }> } };
    const persisted = historyBody.contact.conversations[0]?.messages.find((message) => message.content === "Hola desde el equipo");
    assert.equal(persisted?.senderName, "Asesora CRM 1");
    assert.equal(persisted?.status, "sent");
    const otherHistory = await request(port, 1, `/auth/contacts/${contactIds[0]}?dealerId=${tenantIds[1]}`);
    assert.equal(otherHistory.status, 404);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
    await fixture.query("DELETE FROM public.admin_audit_events WHERE reference_id = ANY($1::text[])", [auditIds]).catch(() => undefined);
    await fixture.query("DELETE FROM public.app_sessions WHERE token_hash = ANY($1::text[])", [tokenHashes]).catch(() => undefined);
    await fixture.query("DELETE FROM public.tenants WHERE dealer_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    await fixture.query("DELETE FROM public.app_users WHERE id = ANY($1::uuid[])", [userIds]).catch(() => undefined);
    fixture.release();
    await apiPool.end();
    await pool.end();
  }
});
