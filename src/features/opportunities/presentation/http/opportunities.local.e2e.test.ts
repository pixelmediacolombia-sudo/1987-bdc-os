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
import { ensureWebhookTables } from "@/modules/webhooks/infrastructure/persistence/postgres/webhooks.migration";
import { ensureOpportunitiesTable } from "@/features/opportunities/infrastructure/persistence/postgres/opportunities.migration";

const localE2E = process.env.OPPORTUNITIES_E2E === "1" && Boolean(process.env.DATABASE_URL);

test("local Docker opportunities persist changes and isolate two dealer sessions", { skip: !localE2E }, async () => {
  const ssl = ["1", "true", "yes"].includes((process.env.PGSSL ?? "").toLowerCase()) ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const apiPool = new Pool({
    connectionString: process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL,
    ssl,
    ...(process.env.RUNTIME_DATABASE_URL ? {} : { options: "-c role=bdc" }),
  });
  const migrationPool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL, ssl });
  try { await ensureWebhookTables(migrationPool); await ensureAdminAuditTable(migrationPool); await ensureConversationWorkflowColumns(migrationPool); await ensureOpportunitiesTable(migrationPool); await ensureTenantRowLevelSecurity(migrationPool); } finally { await migrationPool.end(); }
  const client = await pool.connect();
  const tenantIds = [randomUUID(), randomUUID()];
  const emails = tenantIds.map((_, index) => `fe04-opportunity-${index + 1}-${randomUUID()}@example.test`);
  const contactIds = tenantIds.map(() => randomUUID());
  const tokens = tenantIds.map(() => randomBytes(32).toString("base64url"));
  const hashes = tokens.map((token) => createHash("sha256").update(token).digest("hex"));
  const auditRefs = ["create-a", "create-b", "stage-a", "assign-a", "config-a", "followup-a", "archive-a", "restore-a"].map((label) => `fe04-${label}-${randomUUID()}`);
  let userIds: string[] = [];
  let server: ReturnType<express.Application["listen"]> | undefined;
  const app = express();
  app.use(express.json());
  app.use("/auth", createIdentityRouter(apiPool, { production: false }));
  const grantsToRevoke: Array<[string, string]> = [];
  let hadSchemaUsage = true;
  try {
  const requiredGrants: Array<[string, string]> = [
    ["app_users", "SELECT"], ["app_sessions", "SELECT"], ["app_sessions", "INSERT"], ["app_sessions", "DELETE"],
    ["tenants", "SELECT"], ["tenants", "INSERT"], ["tenants", "DELETE"],
    ["user_tenant_memberships", "SELECT"], ["user_tenant_memberships", "INSERT"], ["user_tenant_memberships", "DELETE"],
    ["contacts", "SELECT"], ["contacts", "INSERT"], ["conversations", "SELECT"], ["messages", "SELECT"],
    ["opportunities", "SELECT"], ["opportunities", "INSERT"], ["opportunities", "UPDATE"], ["opportunities", "DELETE"],
    ["opportunity_stages", "SELECT"], ["opportunity_stages", "INSERT"], ["opportunity_stages", "UPDATE"], ["opportunity_stages", "DELETE"],
    ["admin_audit_events", "SELECT"], ["admin_audit_events", "INSERT"],
  ];
  if (!hadSchemaUsage) await client.query("GRANT USAGE ON SCHEMA public TO bdc");
  for (const [table, privilege] of requiredGrants) {
    const hadGrant = (await client.query<{ allowed: boolean }>("SELECT has_table_privilege('bdc', $1, $2) AS allowed", [`public.${table}`, privilege])).rows[0]?.allowed ?? false;
    if (!hadGrant) {
      await client.query(`GRANT ${privilege} ON public.${table} TO bdc`);
      grantsToRevoke.push([table, privilege]);
    }
  }
  const request = (port: number, token: string, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { cookie: `bdc_os_session=${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers },
  });

    const users = await Promise.all(emails.map((email, index) => client.query<{ id: string }>(
      "INSERT INTO public.app_users (email, display_name, account_type, status) VALUES ($1, $2, 'user', 'active') RETURNING id::text AS id",
      [email, `FE04 Dealer ${index + 1}`],
    )));
    userIds = users.map((result) => result.rows[0]!.id);
    for (const [index, tenantId] of tenantIds.entries()) {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE bdc");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO public.tenants (dealer_id, dealer_name, timezone, policy_version, status, sofia_enabled, qualification_flow_enabled, qualification_signal_enabled)
         VALUES ($1, $2, 'America/Bogota', 'fe04-e2e', 'active', false, false, false)`,
        [tenantId, `FE04 E2E Dealer ${index + 1}`],
      );
      await client.query(`INSERT INTO public.contacts (id, tenant_id, provider_contact_id, display_name, phone, preferred_language, consent_state) VALUES ($1, $2, $3, $4, $5, 'es', 'unknown')`, [contactIds[index], tenantId, `manual:fe04-${contactIds[index]}`, `FE04 E2E Contact ${index + 1}`, `+1 555 01${String(index + 1).padStart(2, '0')}`]);
      await client.query("INSERT INTO public.user_tenant_memberships (user_id, tenant_id) VALUES ($1, $2)", [userIds[index], tenantId]);
      await client.query("COMMIT");
      await client.query("INSERT INTO public.app_sessions (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '10 minutes')", [userIds[index], hashes[index]]);
    }

    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const port = address.port;
    const headers = tenantIds.map((_, index) => ({ cookie: `bdc_os_session=${tokens[index]}` }));

    for (const index of [0, 1]) {
      const membershipResponse = await request(port, tokens[index]!, "/auth/contacts/dealers");
      assert.equal(membershipResponse.status, 200);
      const membership = await membershipResponse.json() as { dealers: Array<{ id: string }> };
      assert.deepEqual(membership.dealers.map(({ id }) => id), [tenantIds[index]]);
    }

    const createdIds: string[] = [];
    for (const index of [0, 1]) {
      const createResponse = await request(port, tokens[index]!, "/auth/opportunities", {
        method: "POST",
        headers: { "x-correlation-id": auditRefs[index]! },
        body: JSON.stringify({ dealerId: tenantIds[index], title: `FE04 E2E Synthetic Opportunity ${index + 1}`, contactId: contactIds[index], contactName: `FE04 Synthetic Buyer ${index + 1}`, contactPhone: "+1 555 0104", amountCents: index === 0 ? 4250000 : 9900000, stage: "new", nextAction: index === 0 ? "Confirmar prueba de manejo" : null, nextActionAt: index === 0 ? "2026-11-28" : null }),
      });
      assert.equal(createResponse.status, 201);
      const created = await createResponse.json() as { opportunity: { id: string; dealerId: string; contactId: string; stage: string; amountCents: string; nextAction: string | null; nextActionAt: string | null } };
      assert.equal(created.opportunity.dealerId, tenantIds[index]);
      assert.equal(created.opportunity.contactId, contactIds[index]);
      assert.equal(created.opportunity.stage, "new");
      if (index === 0) { assert.equal(created.opportunity.nextAction, "Confirmar prueba de manejo"); assert.equal(created.opportunity.nextActionAt, "2026-11-28"); }
      createdIds[index] = created.opportunity.id;
    }

    const crossDealerContact = await request(port, tokens[1]!, "/auth/opportunities", {
      method: "POST", body: JSON.stringify({ dealerId: tenantIds[1], title: "FE04 Cross Dealer Contact Attempt", contactId: contactIds[0], contactName: "FE04 E2E Contact 1", amountCents: 1000 }),
    });
    assert.equal(crossDealerContact.status, 400, "a dealer cannot link another dealer's contact");

    for (const index of [0, 1]) {

      const listResponse = await request(port, tokens[index]!, `/auth/opportunities?dealerId=${tenantIds[index]}`);
      assert.equal(listResponse.status, 200);
      const list = await listResponse.json() as { opportunities: Array<{ id: string; dealerId: string; contactId: string; nextAction: string | null; archivedAt: string | null }> };
      assert.deepEqual(list.opportunities.map(({ id, dealerId, contactId }) => [id, dealerId, contactId]), [[createdIds[index], tenantIds[index], contactIds[index]]]);
      const otherTenantRead = await request(port, tokens[index]!, `/auth/opportunities?dealerId=${tenantIds[1 - index]}`);
      assert.equal(otherTenantRead.status, 403);
      const otherDashboard = await request(port, tokens[index]!, `/auth/dashboard?dealerId=${tenantIds[1 - index]}`);
      assert.equal(otherDashboard.status, 403);
    }

    const crossAssignResponse = await request(port, tokens[0]!, `/auth/opportunities/${createdIds[0]}?dealerId=${tenantIds[0]}`, {
      method: "PATCH", body: JSON.stringify({ assignedUserId: userIds[1] }),
    });
    assert.equal(crossAssignResponse.status, 400, "a dealer cannot assign work to another dealer's user");

    const stageResponse = await request(port, tokens[0]!, `/auth/opportunities/${createdIds[0]}?dealerId=${tenantIds[0]}`, {
      method: "PATCH", headers: { "x-correlation-id": auditRefs[2]! }, body: JSON.stringify({ stage: "working" }),
    });
    assert.equal(stageResponse.status, 200);
    const stageBody = await stageResponse.json() as { opportunity: { stage: string; assignedUserId: string } };
    assert.equal(stageBody.opportunity.stage, "working");
    assert.equal(stageBody.opportunity.assignedUserId, userIds[0]);

    const followupResponse = await request(port, tokens[0]!, `/auth/opportunities/${createdIds[0]}?dealerId=${tenantIds[0]}`, { method: "PATCH", headers: { "x-correlation-id": auditRefs[5]! }, body: JSON.stringify({ nextAction: "Enviar cotización", nextActionAt: "2026-11-29" }) });
    assert.equal(followupResponse.status, 200);
    const followup = await followupResponse.json() as { opportunity: { nextAction: string; nextActionAt: string } };
    assert.deepEqual([followup.opportunity.nextAction, followup.opportunity.nextActionAt], ["Enviar cotización", "2026-11-29"]);
    const archiveResponse = await request(port, tokens[0]!, `/auth/opportunities/${createdIds[0]}?dealerId=${tenantIds[0]}`, { method: "PATCH", headers: { "x-correlation-id": auditRefs[6]! }, body: JSON.stringify({ archived: true }) });
    assert.equal(archiveResponse.status, 200);
    const hiddenArchived = await request(port, tokens[0]!, `/auth/opportunities?dealerId=${tenantIds[0]}`);
    assert.equal((await hiddenArchived.json() as { opportunities: unknown[] }).opportunities.length, 0);
    const shownArchived = await request(port, tokens[0]!, `/auth/opportunities?dealerId=${tenantIds[0]}&includeArchived=true`);
    const archivedList = await shownArchived.json() as { opportunities: Array<{ archivedAt: string | null }> };
    assert.ok(archivedList.opportunities[0]?.archivedAt);
    const restoreResponse = await request(port, tokens[0]!, `/auth/opportunities/${createdIds[0]}?dealerId=${tenantIds[0]}`, { method: "PATCH", headers: { "x-correlation-id": auditRefs[7]! }, body: JSON.stringify({ archived: false }) });
    assert.equal(restoreResponse.status, 200);

    const assignResponse = await request(port, tokens[0]!, `/auth/opportunities/${createdIds[0]}?dealerId=${tenantIds[0]}`, {
      method: "PATCH", headers: { "x-correlation-id": auditRefs[3]! }, body: JSON.stringify({ assignedUserId: userIds[0] }),
    });
    assert.equal(assignResponse.status, 200);
    const activityResponse = await request(port, tokens[0]!, `/auth/opportunities/${createdIds[0]}/activity?dealerId=${tenantIds[0]}`);
    assert.equal(activityResponse.status, 200);
    const activity = await activityResponse.json() as { activity: Array<{ action: string; summary: string }> };
    assert.deepEqual(activity.activity.map(({ action }) => action).sort(), ["opportunity.assigned", "opportunity.created", "opportunity.stage_changed", "opportunity.next_action_updated", "opportunity.archived", "opportunity.restored"].sort());

    const dashboardResponse = await request(port, tokens[0]!, `/auth/dashboard?dealerId=${tenantIds[0]}`);
    assert.equal(dashboardResponse.status, 200);
    const dashboard = await dashboardResponse.json() as { metrics: { activeOpportunities: number; pipelineValueCents: string }; activities: Array<{ summary: string }> };
    assert.equal(dashboard.metrics.activeOpportunities, 1);
    assert.equal(dashboard.metrics.pipelineValueCents, "4250000");
    assert.ok(dashboard.activities.some(({ summary }) => summary.includes("FE04 E2E Synthetic Opportunity 1")));
    const secondDashboardResponse = await request(port, tokens[1]!, `/auth/dashboard?dealerId=${tenantIds[1]}`);
    const secondDashboard = await secondDashboardResponse.json() as { metrics: { activeOpportunities: number; pipelineValueCents: string }; activities: Array<{ summary: string }> };
    assert.equal(secondDashboard.metrics.activeOpportunities, 1);
    assert.equal(secondDashboard.metrics.pipelineValueCents, "9900000");
    assert.ok(!secondDashboard.activities.some(({ summary }) => summary.includes("FE04 E2E Synthetic Opportunity 1")));

    const crossTenantHistory = await request(port, tokens[1]!, `/auth/opportunities/${createdIds[0]}/activity?dealerId=${tenantIds[1]}`);
    assert.equal(crossTenantHistory.status, 404, "history for another dealer is hidden");
  } catch (error) {
    console.error(error);
    throw error;
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
    await client.query("DELETE FROM public.admin_audit_events WHERE reference_id = ANY($1::text[])", [auditRefs]).catch(() => undefined);
    await client.query("DELETE FROM public.app_sessions WHERE token_hash = ANY($1::text[])", [hashes]).catch(() => undefined);
    if (tenantIds.length) await client.query("DELETE FROM public.tenants WHERE dealer_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    if (userIds.length) await client.query("DELETE FROM public.app_users WHERE id = ANY($1::uuid[])", [userIds]).catch(() => undefined);
    for (const [table, privilege] of grantsToRevoke) await client.query(`REVOKE ${privilege} ON public.${table} FROM bdc`).catch(() => undefined);
    if (!hadSchemaUsage) await client.query("REVOKE USAGE ON SCHEMA public FROM bdc").catch(() => undefined);
    client.release();
    await apiPool.end();
    await pool.end();
  }
});