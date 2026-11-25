import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { Pool } from "pg";
import test from "node:test";
import { createIdentityRouter } from "./identity.routes";

test("local Docker Admin directory and tenant data respect forced RLS", {
  skip: process.env.ADMIN_RLS_E2E !== "1" || !process.env.DATABASE_URL,
}, async (context) => {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: ["1", "true", "yes"].includes((process.env.PGSSL ?? "").toLowerCase()) ? { rejectUnauthorized: false } : undefined,
  });
  const apiPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: ["1", "true", "yes"].includes((process.env.PGSSL ?? "").toLowerCase()) ? { rejectUnauthorized: false } : undefined,
    options: "-c role=bdc",
  });
  const client = await pool.connect();
  const tenantIds: string[] = [randomUUID(), randomUUID()];
  const contactProviderId = `rls-e2e-${randomUUID()}`;
  const contactId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const sessionToken = randomBytes(32).toString("base64url");
  const sessionHash = createHash("sha256").update(sessionToken).digest("hex");
  let adminId: string | undefined;
  let server: ReturnType<typeof app.listen> | undefined;
  const app = express();
  const previousGrants = {
    schema: false,
    appUsers: false,
    contacts: { select: false, insert: false, update: false, delete: false },
    conversations: { select: false, insert: false, update: false, delete: false },
    messages: { select: false, insert: false, update: false, delete: false },
    appSessions: { select: false, insert: false, delete: false },
    tenants: { select: false, insert: false, delete: false },
    memberships: false,
    invitations: false,
  };
  app.use("/auth", createIdentityRouter(apiPool, { production: false }));
  try {
    const role = await client.query<{ rolbypassrls: boolean }>(
      "SELECT rolbypassrls FROM pg_roles WHERE rolname = 'bdc'",
    );
    const rls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.tenants'::regclass",
    );
    const contactsRls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.contacts'::regclass",
    );
    const conversationsRls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.conversations'::regclass",
    );
    const messagesRls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.messages'::regclass",
    );
    assert.equal(role.rows[0]?.rolbypassrls, false, "local test role must not bypass RLS");
    assert.equal(rls.rows[0]?.relrowsecurity, true);
    assert.equal(rls.rows[0]?.relforcerowsecurity, true);
    assert.equal(contactsRls.rows[0]?.relrowsecurity, true);
    assert.equal(contactsRls.rows[0]?.relforcerowsecurity, true);
    assert.equal(conversationsRls.rows[0]?.relrowsecurity, true);
    assert.equal(conversationsRls.rows[0]?.relforcerowsecurity, true);
    assert.equal(messagesRls.rows[0]?.relrowsecurity, true);
    assert.equal(messagesRls.rows[0]?.relforcerowsecurity, true);

    previousGrants.schema = (await client.query<{ allowed: boolean }>("SELECT has_schema_privilege('bdc', 'public', 'USAGE') AS allowed")).rows[0]?.allowed ?? false;
    previousGrants.appUsers = (await client.query<{ allowed: boolean }>("SELECT has_table_privilege('bdc', 'public.app_users', 'SELECT') AS allowed")).rows[0]?.allowed ?? false;
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
      previousGrants.contacts[privilege.toLowerCase() as "select" | "insert" | "update" | "delete"] =
        (await client.query<{ allowed: boolean }>("SELECT has_table_privilege('bdc', 'public.contacts', $1) AS allowed", [privilege])).rows[0]?.allowed ?? false;
      previousGrants.conversations[privilege.toLowerCase() as "select" | "insert" | "update" | "delete"] =
        (await client.query<{ allowed: boolean }>("SELECT has_table_privilege('bdc', 'public.conversations', $1) AS allowed", [privilege])).rows[0]?.allowed ?? false;
      previousGrants.messages[privilege.toLowerCase() as "select" | "insert" | "update" | "delete"] =
        (await client.query<{ allowed: boolean }>("SELECT has_table_privilege('bdc', 'public.messages', $1) AS allowed", [privilege])).rows[0]?.allowed ?? false;
    }
    for (const privilege of ["SELECT", "INSERT", "DELETE"] as const) {
      previousGrants.appSessions[privilege.toLowerCase() as "select" | "insert" | "delete"] =
        (await client.query<{ allowed: boolean }>("SELECT has_table_privilege('bdc', 'public.app_sessions', $1) AS allowed", [privilege])).rows[0]?.allowed ?? false;
      previousGrants.tenants[privilege.toLowerCase() as "select" | "insert" | "delete"] =
        (await client.query<{ allowed: boolean }>("SELECT has_table_privilege('bdc', 'public.tenants', $1) AS allowed", [privilege])).rows[0]?.allowed ?? false;
    }
    previousGrants.memberships = (await client.query<{ allowed: boolean }>("SELECT has_table_privilege('bdc', 'public.user_tenant_memberships', 'SELECT') AS allowed")).rows[0]?.allowed ?? false;
    previousGrants.invitations = (await client.query<{ allowed: boolean }>("SELECT has_table_privilege('bdc', 'public.dealer_invitations', 'SELECT') AS allowed")).rows[0]?.allowed ?? false;

    await client.query("GRANT USAGE ON SCHEMA public TO bdc");
    await client.query("GRANT SELECT ON public.app_users TO bdc");
    await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO bdc");
    await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations, public.messages TO bdc");
    await client.query("GRANT SELECT, INSERT, DELETE ON public.app_sessions TO bdc");
    await client.query("GRANT SELECT, INSERT, DELETE ON public.tenants TO bdc");
    await client.query("GRANT SELECT ON public.user_tenant_memberships, public.dealer_invitations TO bdc");

    const admin = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM public.app_users WHERE account_type = 'admin' AND status = 'active' LIMIT 1",
    );
    if (!admin.rows[0]) { context.skip("Local database has no active platform admin."); return; }
    adminId = admin.rows[0].id;
    await client.query(
      "INSERT INTO public.app_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '5 minutes')",
      [adminId, sessionHash],
    );

    for (const [index, tenantId] of tenantIds.entries()) {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE bdc");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO public.tenants
           (dealer_id, dealer_name, timezone, policy_version, status,
            sofia_enabled, qualification_flow_enabled, qualification_signal_enabled)
         VALUES ($1, $2, 'America/Bogota', 'rls-e2e', 'active', false, false, false)`,
        [tenantId, `RLS E2E Dealer ${index + 1}`],
      );
      if (index === 0) {
        await client.query(
          `INSERT INTO public.contacts (id, tenant_id, provider_contact_id, preferred_language, consent_state)
           VALUES ($1, $2, $3, 'unknown', 'unknown')`,
          [contactId, tenantId, contactProviderId],
        );
        await client.query(
          `INSERT INTO public.conversations (id, tenant_id, contact_id, channel)
           VALUES ($1, $2, $3, 'messenger')`,
          [conversationId, tenantId, contactId],
        );
        await client.query(
          `INSERT INTO public.messages (id, tenant_id, conversation_id, direction, sender_type, content)
           VALUES ($1, $2, $3, 'inbound', 'client', 'synthetic RLS message')`,
          [messageId, tenantId, conversationId],
        );
      }
      await client.query("COMMIT");
    }

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE bdc");
    const unscoped = await client.query("SELECT dealer_id FROM public.tenants WHERE dealer_id = ANY($1::uuid[])", [tenantIds]);
    assert.equal(unscoped.rowCount, 0, "unscoped tenant reads must remain filtered");
    await client.query("COMMIT");
    for (const [index, tenantId] of tenantIds.entries()) {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE bdc");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const visible = await client.query<{ dealer_id: string }>("SELECT dealer_id::text FROM public.tenants WHERE dealer_id = ANY($1::uuid[])", [tenantIds]);
      assert.deepEqual(visible.rows.map(({ dealer_id }) => dealer_id), [tenantId], `tenant ${index + 1} must not see the other tenant`);
      await client.query("COMMIT");
    }

    await client.query("BEGIN");
    await client.query("SET LOCAL ROLE bdc");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantIds[1]]);
    const crossTenantContact = await client.query(
      "SELECT id FROM public.contacts WHERE tenant_id = $1 AND provider_contact_id = $2",
      [tenantIds[0], contactProviderId],
    );
    assert.equal(crossTenantContact.rowCount, 0, "a tenant must not read another tenant's contacts");
    const crossTenantUpdate = await client.query(
      "UPDATE public.contacts SET display_name = 'cross-tenant-attempt' WHERE tenant_id = $1 AND provider_contact_id = $2 RETURNING id",
      [tenantIds[0], contactProviderId],
    );
    assert.equal(crossTenantUpdate.rowCount, 0, "a tenant must not update another tenant's contacts");
    await client.query("SAVEPOINT cross_tenant_contact_insert");
    await assert.rejects(
      client.query(
        `INSERT INTO public.contacts (tenant_id, provider_contact_id, preferred_language, consent_state)
         VALUES ($1, $2, 'unknown', 'unknown')`,
        [tenantIds[0], `cross-${randomUUID()}`],
      ),
      { code: "42501" },
      "a tenant must not insert a contact for another tenant",
    );
    await client.query("ROLLBACK TO SAVEPOINT cross_tenant_contact_insert");
    for (const [table, rowId] of [["conversations", conversationId], ["messages", messageId]] as const) {
      const crossTenantRead = await client.query(`SELECT id FROM public.${table} WHERE id = $1`, [rowId]);
      assert.equal(crossTenantRead.rowCount, 0, `a tenant must not read another tenant's ${table}`);
      const crossTenantUpdate = await client.query(
        `UPDATE public.${table} SET tenant_id = $1 WHERE id = $2 RETURNING id`,
        [tenantIds[1], rowId],
      );
      assert.equal(crossTenantUpdate.rowCount, 0, `a tenant must not update another tenant's ${table}`);
      await client.query(`SAVEPOINT cross_tenant_${table}_insert`);
      const insertQuery = table === "conversations"
        ? client.query(
            "INSERT INTO public.conversations (tenant_id, contact_id, channel) VALUES ($1, $2, 'messenger')",
            [tenantIds[0], contactId],
          )
        : client.query(
            "INSERT INTO public.messages (tenant_id, conversation_id, direction, sender_type, content) VALUES ($1, $2, 'inbound', 'client', 'cross-tenant attempt')",
            [tenantIds[0], conversationId],
          );
      await assert.rejects(insertQuery, { code: "42501" }, `a tenant must not insert another tenant's ${table}`);
      await client.query(`ROLLBACK TO SAVEPOINT cross_tenant_${table}_insert`);
    }
    await client.query("ROLLBACK");

    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/auth/admin/dealers`, {
      headers: { cookie: `bdc_os_session=${sessionToken}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json() as { dealers: Array<{ id: string; name: string }> };
    assert.deepEqual(body.dealers.filter(({ id }) => tenantIds.includes(id)).map(({ id, name }) => [id, name]).sort(), [
      [tenantIds[0], "RLS E2E Dealer 1"], [tenantIds[1], "RLS E2E Dealer 2"],
    ].sort());
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("DELETE FROM public.app_sessions WHERE token_hash = $1", [sessionHash]).catch(() => undefined);
    for (const tenantId of tenantIds) {
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        await client.query("DELETE FROM public.tenants WHERE dealer_id = $1", [tenantId]);
        await client.query("COMMIT");
      } catch {
        await client.query("ROLLBACK").catch(() => undefined);
      }
    }
    await apiPool.end();
    if (!previousGrants.appUsers) await client.query("REVOKE SELECT ON public.app_users FROM bdc").catch(() => undefined);
    for (const privilege of ["select", "insert", "update", "delete"] as const) {
      if (!previousGrants.contacts[privilege]) await client.query(`REVOKE ${privilege.toUpperCase()} ON public.contacts FROM bdc`).catch(() => undefined);
      if (!previousGrants.conversations[privilege]) await client.query(`REVOKE ${privilege.toUpperCase()} ON public.conversations FROM bdc`).catch(() => undefined);
      if (!previousGrants.messages[privilege]) await client.query(`REVOKE ${privilege.toUpperCase()} ON public.messages FROM bdc`).catch(() => undefined);
    }
    for (const privilege of ["select", "insert", "delete"] as const) {
      if (!previousGrants.appSessions[privilege]) await client.query(`REVOKE ${privilege.toUpperCase()} ON public.app_sessions FROM bdc`).catch(() => undefined);
      if (!previousGrants.tenants[privilege]) await client.query(`REVOKE ${privilege.toUpperCase()} ON public.tenants FROM bdc`).catch(() => undefined);
    }
    if (!previousGrants.memberships) await client.query("REVOKE SELECT ON public.user_tenant_memberships FROM bdc").catch(() => undefined);
    if (!previousGrants.invitations) await client.query("REVOKE SELECT ON public.dealer_invitations FROM bdc").catch(() => undefined);
    if (!previousGrants.schema) await client.query("REVOKE USAGE ON SCHEMA public FROM bdc").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
