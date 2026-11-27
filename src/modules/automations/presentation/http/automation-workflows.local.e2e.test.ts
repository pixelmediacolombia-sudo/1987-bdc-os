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
import { ensureAutomationEngine } from "@/modules/automations/infrastructure/persistence/postgres/automation-engine.migration";
import { ensureRuntimeRolePrivileges } from "@/infrastructure/database/runtime-role.migration";
import { AutomationEngineWorker } from "@/modules/automations/application/automation-engine.worker";
import { ensureOpportunitiesTable } from "@/features/opportunities/infrastructure/persistence/postgres/opportunities.migration";

const enabled = process.env.AUTOMATION_WORKFLOWS_E2E === "1" && Boolean(process.env.DATABASE_URL);
test("local automation workflow drafts persist revisions and remain dealer-scoped", { skip: !enabled }, async () => {
  const ssl = ["1", "true", "yes"].includes((process.env.PGSSL ?? "").toLowerCase()) ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const apiPool = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL, ssl, ...(process.env.RUNTIME_DATABASE_URL ? {} : { options: "-c role=bdc" }) });
  const migrationPool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL, ssl });
  await ensureAdminAuditTable(migrationPool); await ensureOpportunitiesTable(migrationPool); await ensureAutomationWorkflows(migrationPool); await ensureAutomationEventOutbox(migrationPool); await ensureAutomationEngine(migrationPool); await ensureTenantRowLevelSecurity(migrationPool); await ensureRuntimeRolePrivileges(migrationPool); await migrationPool.end();
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

    const triggerId = randomUUID(); const actionId = randomUUID(); const endId = randomUUID(); const opportunityId = randomUUID();
    const executableDefinition = { schemaVersion: 1, name: "Oportunidad nueva a en proceso", nodes: [
      { id: triggerId, type: "trigger.event", position: { x: 0, y: 0 }, config: { eventType: "opportunity.created" } },
      { id: actionId, type: "opportunity.update_stage", position: { x: 300, y: 0 }, config: { stage: "working" } },
      { id: endId, type: "flow.end", position: { x: 600, y: 0 }, config: { outcome: "complete" } },
    ], edges: [
      { id: randomUUID(), source: triggerId, sourcePort: "next", target: actionId, targetPort: "in" },
      { id: randomUUID(), source: actionId, sourcePort: "next", target: endId, targetPort: "in" },
    ] };
    const savedExecutable = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, { method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: executableDefinition.name, definition: executableDefinition, expectedRevision: 2 }) });
    assert.equal(savedExecutable.status, 200);
    const publish = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: 3 }) });
    assert.equal(publish.status, 200);
    const publishBody = await publish.json() as { workflow: { draft: { revision: number }; published: { revision: number; definition: { name: string } } } };
    assert.equal(publishBody.workflow.published.revision, 3); assert.equal(publishBody.workflow.published.definition.name, executableDefinition.name);
    const crossTenantPublish = await request(port, tokens[1]!, `/auth/automation/workflows/${created.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: 3 }) });
    assert.equal(crossTenantPublish.status, 403);

    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query("INSERT INTO public.opportunities (id,tenant_id,title,contact_name,amount_cents,stage) VALUES ($1::uuid,$2::uuid,'CRM-05 local workflow','Lead sintético',125000,'new')", [opportunityId, tenantIds[0]]);
    await fixture.query("COMMIT");
    const worker = new AutomationEngineWorker(apiPool, 20); await worker.start();
    let execution: { status: string; step_status: string | null } | undefined;
    try {
      for (let attempt = 0; attempt < 80; attempt++) {
        execution = (await fixture.query<{ status: string; step_status: string | null }>(
          `SELECT r.status,s.status AS step_status FROM public.automation_runs r
             JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
             LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.node_id=$3::uuid
            WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$4::uuid ORDER BY r.generation DESC LIMIT 1`,
          [tenantIds[0], created.workflow.id, actionId, opportunityId],
        )).rows[0];
        if (execution?.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally { await worker.stop(); }
    assert.deepEqual(execution, { status: "succeeded", step_status: "succeeded" });
    const opportunity = await fixture.query<{ stage: string }>("SELECT stage FROM public.opportunities WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], opportunityId]);
    assert.equal(opportunity.rows[0]?.stage, "working");

    const controlTriggerId = randomUUID(); const controlEndId = randomUUID(); const eventId = randomUUID(); const runId = randomUUID();
    const snapshot = { schemaVersion: 1, name: "Run controls E2E", nodes: [
      { id: controlTriggerId, type: "trigger.event", position: { x: 0, y: 0 }, config: { eventType: "message.received" } },
      { id: controlEndId, type: "flow.end", position: { x: 300, y: 0 }, config: { outcome: "complete" } },
    ], edges: [{ id: randomUUID(), source: controlTriggerId, sourcePort: "next", target: controlEndId, targetPort: "in" }] };
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query(
      `INSERT INTO public.automation_event_outbox (id,tenant_id,event_type,origin,actor_type,entity_type,entity_id,payload)
       VALUES ($1::uuid,$2::uuid,'message.received','system','contact','message',$3::uuid,'{}'::jsonb)`, [eventId, tenantIds[0], randomUUID()],
    );
    await fixture.query(
      `INSERT INTO public.automation_runs (id,tenant_id,workflow_id,event_id,generation,workflow_revision,event_type,event_snapshot,workflow_snapshot,current_node_id,status,attempts)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,1,1,'message.received',$5::jsonb,$6::jsonb,$7::uuid,'dead_letter',5)`,
      [runId, tenantIds[0], created.workflow.id, eventId, JSON.stringify({ schemaVersion: 1, eventId, tenantId: tenantIds[0], type: "message.received", occurredAt: new Date().toISOString(), origin: "system", actor: { type: "contact" }, entity: { type: "message", id: randomUUID() }, payload: {} }), JSON.stringify(snapshot), controlTriggerId],
    );
    await fixture.query("COMMIT");

    const runsResponse = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/runs?dealerId=${tenantIds[0]}`); assert.equal(runsResponse.status, 200);
    const runsBody = await runsResponse.json() as { runs: Array<{ id: string; status: string }> }; assert.equal(runsBody.runs[0]?.status, "dead_letter");
    const crossTenantRuns = await request(port, tokens[1]!, `/auth/automation/workflows/${created.workflow.id}/runs?dealerId=${tenantIds[0]}`); assert.equal(crossTenantRuns.status, 403);
    const retry = await request(port, tokens[0]!, `/auth/automation/runs/${runId}/retry`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0] }) }); assert.equal(retry.status, 200);
    assert.equal(((await retry.json()) as { run: { status: string } }).run.status, "queued");
    const requestKey = randomUUID();
    const replay = await request(port, tokens[0]!, `/auth/automation/runs/${runId}/replay`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], requestKey }) }); assert.equal(replay.status, 201);
    const replayBody = await replay.json() as { run: { id: string; generation: number; status: string } }; assert.equal(replayBody.run.generation, 2); assert.equal(replayBody.run.status, "queued");
    const replayDuplicate = await request(port, tokens[0]!, `/auth/automation/runs/${runId}/replay`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], requestKey }) }); assert.equal(replayDuplicate.status, 201);
    assert.equal(((await replayDuplicate.json()) as { run: { id: string } }).run.id, replayBody.run.id);
    const cancel = await request(port, tokens[0]!, `/auth/automation/runs/${replayBody.run.id}/cancel`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0] }) }); assert.equal(cancel.status, 200);
    assert.equal(((await cancel.json()) as { run: { status: string } }).run.status, "cancelled");
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
    await fixture.query("DELETE FROM public.app_sessions WHERE token_hash = ANY($1::text[])", [hashes]).catch(() => undefined);
    await fixture.query("DELETE FROM public.tenants WHERE dealer_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    if (userIds.length) await fixture.query("DELETE FROM public.app_users WHERE id = ANY($1::uuid[])", [userIds]).catch(() => undefined);
    fixture.release(); await apiPool.end(); await pool.end();
  }
});
