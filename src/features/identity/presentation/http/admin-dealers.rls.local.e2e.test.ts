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
    connectionString: process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl: ["1", "true", "yes"].includes((process.env.PGSSL ?? "").toLowerCase()) ? { rejectUnauthorized: false } : undefined,
    ...(process.env.RUNTIME_DATABASE_URL ? {} : { options: "-c role=bdc" }),
  });
  const client = await pool.connect();
  const tenantIds: string[] = [randomUUID(), randomUUID()];
  const contactProviderId = `rls-e2e-${randomUUID()}`;
  const contactId = randomUUID();
  const conversationId = randomUUID();
  const messageId = randomUUID();
  const memberEmail = `rls-member-${randomUUID()}@example.test`;
  const invitationEmail = `rls-invite-${randomUUID()}@example.test`;
  const invitationToken = randomBytes(32).toString("base64url");
  const invitationTokenHash = createHash("sha256").update(invitationToken).digest("hex");
  const sessionToken = randomBytes(32).toString("base64url");
  const sessionHash = createHash("sha256").update(sessionToken).digest("hex");
  const memberSessionToken = randomBytes(32).toString("base64url");
  const memberSessionHash = createHash("sha256").update(memberSessionToken).digest("hex");
  const contactCreateAuditId = `rls-contact-create-${randomUUID()}`;
  const contactUpdateAuditId = `rls-contact-update-${randomUUID()}`;
  const invitationAcceptAuditId = `rls-invitation-accept-${randomUUID()}`;
  let adminId: string | undefined;
  let memberId: string | undefined;
  let server: ReturnType<typeof app.listen> | undefined;
  const app = express();
  app.use(express.json());
  const previousGrants = {
    schema: false,
    appUsers: false,
    contacts: { select: false, insert: false, update: false, delete: false },
    conversations: { select: false, insert: false, update: false, delete: false },
    messages: { select: false, insert: false, update: false, delete: false },
    appSessions: { select: false, insert: false, delete: false },
    tenants: { select: false, insert: false, delete: false },
    memberships: { select: false, insert: false, update: false, delete: false },
    invitations: { select: false, insert: false, update: false, delete: false },
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
    const membershipsRls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.user_tenant_memberships'::regclass",
    );
    const invitationsRls = await client.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.dealer_invitations'::regclass",
    );
    assert.equal(role.rows[0]?.rolbypassrls, false, "local test role must not bypass RLS");
    const runtimeIdentity = await apiPool.query<{ current_user: string; rolbypassrls: boolean }>(
      "SELECT current_user, (SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user) AS rolbypassrls",
    );
    assert.equal(runtimeIdentity.rows[0]?.current_user, "bdc");
    assert.equal(runtimeIdentity.rows[0]?.rolbypassrls, false, "normal runtime connection must not bypass RLS");
    assert.equal(rls.rows[0]?.relrowsecurity, true);
    assert.equal(rls.rows[0]?.relforcerowsecurity, true);
    assert.equal(contactsRls.rows[0]?.relrowsecurity, true);
    assert.equal(contactsRls.rows[0]?.relforcerowsecurity, true);
    assert.equal(conversationsRls.rows[0]?.relrowsecurity, true);
    assert.equal(conversationsRls.rows[0]?.relforcerowsecurity, true);
    assert.equal(messagesRls.rows[0]?.relrowsecurity, true);
    assert.equal(messagesRls.rows[0]?.relforcerowsecurity, true);
    assert.equal(membershipsRls.rows[0]?.relrowsecurity, true);
    assert.equal(membershipsRls.rows[0]?.relforcerowsecurity, true);
    assert.equal(invitationsRls.rows[0]?.relrowsecurity, true);
    assert.equal(invitationsRls.rows[0]?.relforcerowsecurity, true);
    const routingAccess = await client.query<{
      meta_table: boolean; processing_table: boolean; legacy_location_table: boolean;
      meta_resolver: boolean; route_listing: boolean;
    }>(`SELECT has_table_privilege('bdc', 'public.meta_messaging_routes', 'SELECT') AS meta_table,
               has_table_privilege('bdc', 'public.tenant_processing_routes', 'SELECT') AS processing_table,
               has_table_privilege('bdc', 'public.tenant_location_routes', 'SELECT') AS legacy_location_table,
               has_function_privilege('bdc', 'public.resolve_meta_tenant_id(text)', 'EXECUTE') AS meta_resolver,
               has_function_privilege('bdc', 'public.list_tenant_route_ids()', 'EXECUTE') AS route_listing`);
    assert.equal(routingAccess.rows[0]?.meta_table, false, "Meta route mapping must not be directly readable by bdc");
    assert.equal(routingAccess.rows[0]?.processing_table, false, "processing route IDs must be read through the definer function");
    assert.equal(routingAccess.rows[0]?.legacy_location_table, false, "legacy location routing must not be directly readable by bdc");
    assert.equal(routingAccess.rows[0]?.meta_resolver, true);
    assert.equal(routingAccess.rows[0]?.route_listing, true);

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
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"] as const) {
      previousGrants.memberships[privilege.toLowerCase() as "select" | "insert" | "update" | "delete"] =
        (await client.query<{ allowed: boolean }>("SELECT has_table_privilege('bdc', 'public.user_tenant_memberships', $1) AS allowed", [privilege])).rows[0]?.allowed ?? false;
      previousGrants.invitations[privilege.toLowerCase() as "select" | "insert" | "update" | "delete"] =
        (await client.query<{ allowed: boolean }>("SELECT has_table_privilege('bdc', 'public.dealer_invitations', $1) AS allowed", [privilege])).rows[0]?.allowed ?? false;
    }

    await client.query("GRANT USAGE ON SCHEMA public TO bdc");
    await client.query("GRANT SELECT ON public.app_users TO bdc");
    await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO bdc");
    await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations, public.messages TO bdc");
    await client.query("GRANT SELECT, INSERT, DELETE ON public.app_sessions TO bdc");
    await client.query("GRANT SELECT, INSERT, DELETE ON public.tenants TO bdc");
    await client.query("GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_tenant_memberships, public.dealer_invitations TO bdc");

    const admin = await client.query<{ id: string }>(
      "SELECT id::text AS id FROM public.app_users WHERE account_type = 'admin' AND status = 'active' LIMIT 1",
    );
    if (!admin.rows[0]) { context.skip("Local database has no active platform admin."); return; }
    adminId = admin.rows[0].id;
    const member = await client.query<{ id: string }>(
      "INSERT INTO public.app_users (email, display_name, password_hash, account_type, status) VALUES ($1, 'Synthetic RLS Member', 'unused-local-hash', 'user', 'active') RETURNING id::text AS id",
      [memberEmail],
    );
    memberId = member.rows[0]?.id;
    assert.ok(memberId, "synthetic local member account must be created");
    await client.query(
      "INSERT INTO public.app_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '5 minutes')",
      [adminId, sessionHash],
    );
    await client.query(
      "INSERT INTO public.app_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '5 minutes')",
      [memberId, memberSessionHash],
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
        await client.query(
          "INSERT INTO public.user_tenant_memberships (user_id, tenant_id) VALUES ($1, $2)",
          [memberId, tenantId],
        );
        await client.query(
          `INSERT INTO public.dealer_invitations
             (tenant_id, email, display_name, token_hash, invited_by, expires_at)
           VALUES ($1, $2, 'Synthetic RLS Invite', $3, $4, now() + interval '1 hour')`,
          [tenantId, invitationEmail, invitationTokenHash, adminId],
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
    const hiddenMembership = await client.query(
      "SELECT user_id FROM public.user_tenant_memberships WHERE user_id = $1 AND tenant_id = $2",
      [memberId, tenantIds[0]],
    );
    assert.equal(hiddenMembership.rowCount, 0, "another tenant must not read the member mapping without a user context");
    await client.query("SELECT set_config('app.user_id', $1, true)", [memberId]);
    const ownMembership = await client.query(
      "SELECT user_id FROM public.user_tenant_memberships WHERE user_id = $1 AND tenant_id = $2",
      [memberId, tenantIds[0]],
    );
    assert.equal(ownMembership.rowCount, 1, "a user may read their own dealer memberships");
    await client.query("SELECT set_config('app.user_id', $1, true)", [adminId]);
    const hiddenInvitation = await client.query("SELECT id FROM public.dealer_invitations WHERE token_hash = $1", [invitationTokenHash]);
    assert.equal(hiddenInvitation.rowCount, 0, "a tenant must not read another tenant's invitation without token context");
    await client.query("SELECT set_config('app.invitation_token_hash', $1, true)", [invitationTokenHash]);
    const tokenInvitation = await client.query("SELECT id FROM public.dealer_invitations WHERE token_hash = $1", [invitationTokenHash]);
    assert.equal(tokenInvitation.rowCount, 1, "an invitation token may resolve its own invitation");
    await client.query("SAVEPOINT cross_tenant_invitation_update");
    await assert.rejects(
      client.query("UPDATE public.dealer_invitations SET revoked_at = now() WHERE token_hash = $1 RETURNING id", [invitationTokenHash]),
      { code: "42501" },
      "token-only context may lock an invitation but must not update it outside its tenant",
    );
    await client.query("ROLLBACK TO SAVEPOINT cross_tenant_invitation_update");
    await client.query("SAVEPOINT cross_tenant_invitation_insert");
    await assert.rejects(
      client.query(
        `INSERT INTO public.dealer_invitations
           (tenant_id, email, display_name, token_hash, invited_by, expires_at)
         VALUES ($1, 'blocked@example.test', 'Blocked', $2, $3, now() + interval '1 hour')`,
        [tenantIds[0], createHash("sha256").update(randomBytes(32)).digest("hex"), adminId],
      ),
      { code: "42501" },
      "a tenant must not insert another tenant's invitation",
    );
    await client.query("ROLLBACK TO SAVEPOINT cross_tenant_invitation_insert");
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const adminMembership = await client.query(
      "SELECT user_id FROM public.user_tenant_memberships WHERE user_id = $1 AND tenant_id = $2",
      [memberId, tenantIds[0]],
    );
    assert.equal(adminMembership.rowCount, 1, "platform admin context may read all dealer memberships");
    const adminInvitation = await client.query("SELECT id FROM public.dealer_invitations WHERE token_hash = $1", [invitationTokenHash]);
    assert.equal(adminInvitation.rowCount, 1, "platform admin context may read all invitations");
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
    const usersResponse = await fetch(`http://127.0.0.1:${address.port}/auth/admin/users`, {
      headers: { cookie: `bdc_os_session=${sessionToken}` },
    });
    assert.equal(usersResponse.status, 200);
    const usersBody = await usersResponse.json() as { entries: Array<{ email: string; record_type: string }> };
    assert.ok(usersBody.entries.some(({ email, record_type }) => email === memberEmail && record_type === "user"));
    assert.ok(usersBody.entries.some(({ email, record_type }) => email === invitationEmail && record_type === "invitation"));

    const runtimeInvitationClient = await apiPool.connect();
    try {
      await runtimeInvitationClient.query("BEGIN");
      await runtimeInvitationClient.query("SELECT set_config('app.invitation_token_hash', $1, true)", [invitationTokenHash]);
      const runtimeInvitation = await runtimeInvitationClient.query(
        "SELECT id FROM public.dealer_invitations WHERE token_hash = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() FOR UPDATE",
        [invitationTokenHash],
      );
      assert.equal(runtimeInvitation.rowCount, 1, "the real runtime login may lock an invitation by its exact token hash");
      await runtimeInvitationClient.query("ROLLBACK");
    } finally {
      runtimeInvitationClient.release();
    }

    const invitationPageResponse = await fetch(
      `http://127.0.0.1:${address.port}/auth/invitations/accept?token=${encodeURIComponent(invitationToken)}`,
    );
    assert.equal(invitationPageResponse.status, 200);
    const invitationAcceptResponse = await fetch(`http://127.0.0.1:${address.port}/auth/invitations/accept`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-correlation-id": invitationAcceptAuditId },
      body: JSON.stringify({ token: invitationToken, password: "synthetic-local-password-123" }),
    });
    const invitationAcceptBody = await invitationAcceptResponse.json() as Record<string, unknown>;
    assert.equal(invitationAcceptResponse.status, 200, JSON.stringify(invitationAcceptBody));
    assert.deepEqual(invitationAcceptBody, {
      activated: true, existingAccount: false, dealerName: "RLS E2E Dealer 1",
    });

    const memberHeaders = { cookie: `bdc_os_session=${memberSessionToken}` };
    const memberDealersResponse = await fetch(`http://127.0.0.1:${address.port}/auth/contacts/dealers`, { headers: memberHeaders });
    assert.equal(memberDealersResponse.status, 200);
    const memberDealers = await memberDealersResponse.json() as { dealers: Array<{ id: string; name: string }> };
    assert.deepEqual(memberDealers.dealers.filter(({ id }) => tenantIds.includes(id)), [
      { id: tenantIds[0], name: "RLS E2E Dealer 1" },
    ]);

    const contactListResponse = await fetch(`http://127.0.0.1:${address.port}/auth/contacts?dealerId=${tenantIds[0]}`, { headers: memberHeaders });
    assert.equal(contactListResponse.status, 200);
    const contactList = await contactListResponse.json() as { contacts: Array<{ id: string; source: string; conversationCount: number }>; total: number };
    assert.equal(contactList.total, 1);
    assert.equal(contactList.contacts[0]?.id, contactId);
    assert.equal(contactList.contacts[0]?.source, "meta");
    assert.equal(contactList.contacts[0]?.conversationCount, 1);

    const contactDetailResponse = await fetch(`http://127.0.0.1:${address.port}/auth/contacts/${contactId}?dealerId=${tenantIds[0]}`, { headers: memberHeaders });
    assert.equal(contactDetailResponse.status, 200);
    const contactDetail = await contactDetailResponse.json() as { contact: { conversations: Array<{ messages: Array<{ content: string }> }>; activities: Array<{ action: string }> } };
    assert.equal(contactDetail.contact.conversations[0]?.messages[0]?.content, "synthetic RLS message");
    assert.deepEqual(contactDetail.contact.activities, []);

    const crossTenantContactResponse = await fetch(`http://127.0.0.1:${address.port}/auth/contacts?dealerId=${tenantIds[1]}`, { headers: memberHeaders });
    assert.equal(crossTenantContactResponse.status, 403);

    const createContactResponse = await fetch(`http://127.0.0.1:${address.port}/auth/contacts`, {
      method: "POST", headers: { ...memberHeaders, "content-type": "application/json", "x-correlation-id": contactCreateAuditId },
      body: JSON.stringify({ dealerId: tenantIds[0], displayName: "Synthetic Runtime Contact", phone: "+15550109876" }),
    });
    assert.equal(createContactResponse.status, 201);
    const createdContact = await createContactResponse.json() as { contact: { id: string; source: string; consentState: string } };
    assert.equal(createdContact.contact.source, "manual");
    assert.equal(createdContact.contact.consentState, "unknown");

    const duplicateContactResponse = await fetch(`http://127.0.0.1:${address.port}/auth/contacts`, {
      method: "POST", headers: { ...memberHeaders, "content-type": "application/json" },
      body: JSON.stringify({ dealerId: tenantIds[0], displayName: "Duplicate Synthetic Contact", phone: "+1 (555) 010-9876" }),
    });
    assert.equal(duplicateContactResponse.status, 409);

    const updateContactResponse = await fetch(`http://127.0.0.1:${address.port}/auth/contacts/${createdContact.contact.id}?dealerId=${tenantIds[0]}`, {
      method: "PATCH", headers: { ...memberHeaders, "content-type": "application/json", "x-correlation-id": contactUpdateAuditId },
      body: JSON.stringify({ displayName: "Updated Synthetic Runtime Contact", consentState: "granted" }),
    });
    assert.equal(updateContactResponse.status, 200);
    const updatedContact = await updateContactResponse.json() as { contact: { displayName: string; consentState: string } };
    assert.equal(updatedContact.contact.displayName, "Updated Synthetic Runtime Contact");
    assert.equal(updatedContact.contact.consentState, "unknown");

    const persistedContactDetailResponse = await fetch(`http://127.0.0.1:${address.port}/auth/contacts/${createdContact.contact.id}?dealerId=${tenantIds[0]}`, { headers: memberHeaders });
    assert.equal(persistedContactDetailResponse.status, 200);
    const persistedContactDetail = await persistedContactDetailResponse.json() as { contact: { activities: Array<{ action: string; actorName: string; summary: string }> } };
    assert.deepEqual(persistedContactDetail.contact.activities.map((item) => item.action).sort(), ["contact.created", "contact.updated"]);
    assert.ok(persistedContactDetail.contact.activities.every((item) => item.actorName === "Synthetic RLS Member"));
    assert.ok(persistedContactDetail.contact.activities.every((item) => !item.summary.includes(createdContact.contact.id)));
  } finally {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
    await client.query("ROLLBACK").catch(() => undefined);
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query(
        "DELETE FROM public.admin_audit_events WHERE reference_id = ANY($1::text[])",
        [[contactCreateAuditId, contactUpdateAuditId, invitationAcceptAuditId]],
      );
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
    }
    await client.query("DELETE FROM public.app_sessions WHERE token_hash = $1", [sessionHash]).catch(() => undefined);
    await client.query("DELETE FROM public.app_sessions WHERE token_hash = $1", [memberSessionHash]).catch(() => undefined);
    if (memberId) await client.query("DELETE FROM public.app_users WHERE id = $1", [memberId]).catch(() => undefined);
    await client.query("DELETE FROM public.app_users WHERE email = $1", [invitationEmail]).catch(() => undefined);
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
    for (const privilege of ["select", "insert", "update", "delete"] as const) {
      if (!previousGrants.memberships[privilege]) await client.query(`REVOKE ${privilege.toUpperCase()} ON public.user_tenant_memberships FROM bdc`).catch(() => undefined);
      if (!previousGrants.invitations[privilege]) await client.query(`REVOKE ${privilege.toUpperCase()} ON public.dealer_invitations FROM bdc`).catch(() => undefined);
    }
    if (!previousGrants.schema) await client.query("REVOKE USAGE ON SCHEMA public FROM bdc").catch(() => undefined);
    client.release();
    await pool.end();
  }
});
