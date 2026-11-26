import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { Pool } from "pg";
import test from "node:test";
import { ensureAdminAuditTable } from "@/features/identity/infrastructure/persistence/postgres/admin-audit.migration";
import { ensureTenantRowLevelSecurity } from "@/features/identity/infrastructure/persistence/postgres/tenant-rls.migration";
import { createIdentityRouter } from "@/features/identity/presentation/http/identity.routes";
import { ensureAutomationWorkflows } from "@/modules/automations/infrastructure/persistence/postgres/automation-workflows.migration";
import { ensureAutomationEventOutbox } from "@/modules/automations/infrastructure/persistence/postgres/automation-event-outbox.migration";
import { ensureRuntimeRolePrivileges } from "@/infrastructure/database/runtime-role.migration";

const enabled = process.env.AUTOMATION_WORKFLOWS_E2E === "1" && Boolean(process.env.DATABASE_URL);
test("local automation workflow drafts persist revisions and remain dealer-scoped", { skip: !enabled }, async () => {
  const ssl = ["1", "true", "yes"].includes((process.env.PGSSL ?? "").toLowerCase()) ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const apiPool = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL, ssl, ...(process.env.RUNTIME_DATABASE_URL ? {} : { options: "-c role=bdc" }) });
  const migrationPool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL, ssl });
  await ensureAdminAuditTable(migrationPool); await ensureAutomationEventOutbox(migrationPool); await ensureAutomationWorkflows(migrationPool); await ensureTenantRowLevelSecurity(migrationPool); await ensureRuntimeRolePrivileges(migrationPool); await migrationPool.end();
  const fixture = await pool.connect();
  const tenantIds = [randomUUID(), randomUUID()]; const userIds: string[] = [];
  const tokens = tenantIds.map(() => randomBytes(32).toString("base64url")); const hashes = tokens.map((token) => createHash("sha256").update(token).digest("hex"));
  const app = express(); app.use(express.json()); app.use("/auth", createIdentityRouter(apiPool, { production: false }));
  let server: ReturnType<typeof app.listen> | undefined;
  const request = (port: number, token: string, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { cookie: `bdc_os_session=${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  try {
    const users = await Promise.all(tenantIds.map((_, i) => fixture.query<{ id: string }>("INSERT INTO public.app_users (email,display_name,account_type,status) VALUES ($1,$2,'user','active') RETURNING id::text AS id", [`crm05d-${randomUUID()}@example.test`, `CRM05D Dealer ${i + 1}`])));
    userIds.push(...users.map((result) => result.rows[0]!.id));
    for (const [i, tenantId] of tenantIds.entries()) {
      await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await fixture.query("INSERT INTO public.tenants (dealer_id,dealer_name,timezone,policy_version,status,sofia_enabled,qualification_flow_enabled,qualification_signal_enabled) VALUES ($1,$2,'America/New_York','crm05d-e2e','active',false,false,false)", [tenantId, `CRM05D E2E Dealer ${i + 1}`]);
      await fixture.query("INSERT INTO public.user_tenant_memberships (user_id,tenant_id) VALUES ($1,$2)", [userIds[i], tenantId]); await fixture.query("COMMIT");
      await fixture.query("INSERT INTO public.app_sessions (user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '15 minutes')", [userIds[i], hashes[i]]);
    }
    server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
    const create = await request(port, tokens[0]!, "/auth/automation/workflows", { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], name: "New message follow-up" }) }); assert.equal(create.status, 201);
    const created = await create.json() as { workflow: { id: string; draft: { revision: number; definition: { name: string }; }; published: unknown }; validationIssues: Array<{ code: string }> };
    assert.equal(created.workflow.draft.revision, 1); assert.equal(created.workflow.published, null); assert.ok(created.validationIssues.some((issue) => issue.code === "missing_trigger"));
    const draft = { schemaVersion: 1, name: "New message follow-up", nodes: [], edges: [] };
    const saved = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, { method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: draft.name, definition: draft, expectedRevision: 1 }) }); assert.equal(saved.status, 200);
    const savedBody = await saved.json() as { workflow: { draft: { revision: number } }; validationIssues: Array<{ code: string }> };
    assert.equal(savedBody.workflow.draft.revision, 2); assert.ok(savedBody.validationIssues.some((issue) => issue.code === "missing_trigger"));
    const conflict = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, { method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: draft.name, definition: draft, expectedRevision: 1 }) }); assert.equal(conflict.status, 409);
    const crossTenant = await request(port, tokens[1]!, `/auth/automation/workflows/${created.workflow.id}?dealerId=${tenantIds[0]}`); assert.equal(crossTenant.status, 403);
    const list = await request(port, tokens[0]!, `/auth/automation/workflows?dealerId=${tenantIds[0]}`); assert.equal(list.status, 200);
    const listBody = await list.json() as { workflows: Array<{ id: string; draftRevision: number; publishedRevision: number | null }> };
    assert.deepEqual(listBody.workflows.map((item) => [item.id, item.draftRevision, item.publishedRevision]), [[created.workflow.id, 2, null]]);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
    await fixture.query("DELETE FROM public.app_sessions WHERE token_hash = ANY($1::text[])", [hashes]).catch(() => undefined);
    await fixture.query("DELETE FROM public.tenants WHERE dealer_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    if (userIds.length) await fixture.query("DELETE FROM public.app_users WHERE id = ANY($1::uuid[])", [userIds]).catch(() => undefined);
    fixture.release(); await apiPool.end(); await pool.end();
  }
});
