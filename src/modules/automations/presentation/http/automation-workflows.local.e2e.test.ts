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
import { ensureWebhookTables } from "@/modules/webhooks/infrastructure/persistence/postgres/webhooks.migration";
import { ensureConversationWorkflowColumns } from "@/features/contacts/infrastructure/persistence/postgres/conversation-workflow.migration";
import { ensureAppointmentsTables } from "@/features/appointments/infrastructure/persistence/postgres/appointments.migration";

const enabled = process.env.AUTOMATION_WORKFLOWS_E2E === "1" && Boolean(process.env.DATABASE_URL);
test("local automation workflow drafts persist revisions and remain dealer-scoped", { skip: !enabled }, async () => {
  const ssl = ["1", "true", "yes"].includes((process.env.PGSSL ?? "").toLowerCase()) ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const apiPool = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL, ssl, ...(process.env.RUNTIME_DATABASE_URL ? {} : { options: "-c role=bdc" }) });
  const migrationPool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL, ssl });
  await ensureAdminAuditTable(migrationPool); await ensureWebhookTables(migrationPool); await ensureConversationWorkflowColumns(migrationPool); await ensureOpportunitiesTable(migrationPool); await ensureAppointmentsTables(migrationPool); await ensureAutomationWorkflows(migrationPool); await ensureAutomationEventOutbox(migrationPool); await ensureAutomationEngine(migrationPool); await ensureTenantRowLevelSecurity(migrationPool); await ensureRuntimeRolePrivileges(migrationPool); await migrationPool.end();
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

    const retryOpportunityId = randomUUID();
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query("INSERT INTO public.opportunities (id,tenant_id,title,contact_name,amount_cents,stage) VALUES ($1::uuid,$2::uuid,'CRM-05 transient retry','Lead retry',125000,'new')", [retryOpportunityId, tenantIds[0]]);
    await fixture.query("COMMIT");
    await fixture.query("CREATE SEQUENCE IF NOT EXISTS public.crm05f_retry_fault_seq");
    await fixture.query("GRANT USAGE, SELECT ON SEQUENCE public.crm05f_retry_fault_seq TO bdc");
    await fixture.query("CREATE OR REPLACE FUNCTION public.crm05f_retry_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id::text=TG_ARGV[0] AND current_setting('app.automation_origin',true)='system' AND nextval('public.crm05f_retry_fault_seq')=1 THEN RAISE EXCEPTION 'CRM-05-F transient test failure'; END IF; RETURN NEW; END $$");
    await fixture.query("DROP TRIGGER IF EXISTS crm05f_retry_fault ON public.opportunities");
    await fixture.query("CREATE TRIGGER crm05f_retry_fault BEFORE UPDATE ON public.opportunities FOR EACH ROW EXECUTE FUNCTION public.crm05f_retry_fault('" + retryOpportunityId + "')");
    await fixture.query("SELECT setval('public.crm05f_retry_fault_seq',1,false)");
    try {
      const transientWorker = new AutomationEngineWorker(apiPool, 20); await transientWorker.start();
      let transientRun: { id: string; status: string; step_status: string | null; step_attempts: number } | undefined;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          transientRun = (await fixture.query<{ id: string; status: string; step_status: string | null; step_attempts: number }>(
            "SELECT r.id::text AS id,r.status,s.status AS step_status,s.attempts AS step_attempts FROM public.automation_runs r JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.node_id=$3::uuid WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$4::uuid AND s.node_id=$3::uuid ORDER BY r.created_at DESC LIMIT 1",
            [tenantIds[0], created.workflow.id, actionId, retryOpportunityId],
          )).rows[0];
          if (transientRun?.step_status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally { await transientWorker.stop(); }
      assert.equal(transientRun?.step_status, "failed", "the first stage update fails transiently");
      assert.equal((await fixture.query<{ stage: string }>("SELECT stage FROM public.opportunities WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], retryOpportunityId])).rows[0]?.stage, "new");
      await fixture.query("UPDATE public.automation_runs SET status='failed',attempts=4,finished_at=now(),updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], transientRun!.id]);
      const transientRetry = await request(port, tokens[0]!, `/auth/automation/runs/${transientRun!.id}/retry`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0] }) });
      assert.equal(transientRetry.status, 200);
      const recoveryWorker = new AutomationEngineWorker(apiPool, 20); await recoveryWorker.start();
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          transientRun = (await fixture.query<{ id: string; status: string; step_status: string | null; step_attempts: number }>(
            "SELECT r.id::text AS id,r.status,s.status AS step_status,s.attempts AS step_attempts FROM public.automation_runs r JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.node_id=$3::uuid WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$4::uuid AND s.node_id=$3::uuid ORDER BY r.created_at DESC LIMIT 1",
            [tenantIds[0], created.workflow.id, actionId, retryOpportunityId],
          )).rows[0];
          if (transientRun?.status === "succeeded" && transientRun.step_attempts >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally { await recoveryWorker.stop(); }
      const transientDiagnostic = (await fixture.query("SELECT r.status,r.current_node_id::text,r.last_error,s.status AS step_status,s.attempts AS step_attempts,s.error_message FROM public.automation_runs r LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.node_id=$3::uuid WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid", [tenantIds[0], transientRun!.id, actionId])).rows[0];
      assert.equal(transientRun?.status, "succeeded", JSON.stringify({ transientRun, transientDiagnostic }));
      assert.equal(transientRun?.step_status, "succeeded");
      assert.ok((transientRun?.step_attempts ?? 0) >= 2);
      assert.equal((await fixture.query<{ stage: string }>("SELECT stage FROM public.opportunities WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], retryOpportunityId])).rows[0]?.stage, "working");
      const recoveredStageAudit = await fixture.query<{ total: number }>("SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action='opportunity.stage_changed_by_automation'", [tenantIds[0], retryOpportunityId]);
      assert.equal(recoveredStageAudit.rows[0]?.total, 1);
    } finally {
      await fixture.query("DROP TRIGGER IF EXISTS crm05f_retry_fault ON public.opportunities");
      await fixture.query("DROP FUNCTION IF EXISTS public.crm05f_retry_fault()");
      await fixture.query("DROP SEQUENCE IF EXISTS public.crm05f_retry_fault_seq");
    }
    const duplicateStageEventId = randomUUID();
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query(
      "INSERT INTO public.automation_event_outbox (id,tenant_id,event_type,origin,actor_type,actor_id,entity_type,entity_id,payload) VALUES ($1::uuid,$2::uuid,'opportunity.created','crm','user','crm05f-stage-idempotency-e2e','opportunity',$3::uuid,jsonb_build_object('stage','new'))",
      [duplicateStageEventId, tenantIds[0], opportunityId],
    );
    await fixture.query("COMMIT");
    const duplicateStageWorker = new AutomationEngineWorker(apiPool, 20); await duplicateStageWorker.start();
    let duplicateStageResults: { total: number; changed: number } | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        duplicateStageResults = (await fixture.query<{ total: number; changed: number }>(
          "SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE s.output_snapshot->>'changed'='true')::int AS changed FROM public.automation_runs r JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$3::uuid AND e.event_type='opportunity.created' AND s.node_id=$4::uuid AND s.status='succeeded'",
          [tenantIds[0], created.workflow.id, opportunityId, actionId],
        )).rows[0];
        if (duplicateStageResults?.total === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    } finally { await duplicateStageWorker.stop(); }
    assert.deepEqual(duplicateStageResults, { total: 2, changed: 1 }, "repeated stage actions change and audit the opportunity once");
    const stageAudit = await fixture.query<{ total: number }>("SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action='opportunity.stage_changed_by_automation'", [tenantIds[0], opportunityId]);
    assert.equal(stageAudit.rows[0]?.total, 1);
    const contactId = randomUUID(); const tagTriggerId = randomUUID(); const tagActionId = randomUUID(); const tagEndId = randomUUID();
    const tagDefinition = { schemaVersion: 1, name: "Contacto nuevo con etiqueta", nodes: [
      { id: tagTriggerId, type: "trigger.event", position: { x: 0, y: 0 }, config: { eventType: "contact.created" } },
      { id: tagActionId, type: "contact.manage_tag", position: { x: 300, y: 0 }, config: { action: "add", tag: "seguimiento" } },
      { id: tagEndId, type: "flow.end", position: { x: 600, y: 0 }, config: { outcome: "complete" } },
    ], edges: [
      { id: randomUUID(), source: tagTriggerId, sourcePort: "next", target: tagActionId, targetPort: "in" },
      { id: randomUUID(), source: tagActionId, sourcePort: "next", target: tagEndId, targetPort: "in" },
    ] };
    const saveTagDraft = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, { method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: tagDefinition.name, definition: tagDefinition, expectedRevision: 3 }) });
    assert.equal(saveTagDraft.status, 200);
    const publishTag = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: 4 }) });
    assert.equal(publishTag.status, 200);
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query("INSERT INTO public.contacts (id,tenant_id,provider_contact_id,display_name) VALUES ($1::uuid,$2::uuid,$3,'CRM-05 tag test')", [contactId, tenantIds[0], `manual:${randomUUID()}`]);
    await fixture.query("COMMIT");
    const tagWorker = new AutomationEngineWorker(apiPool, 20); await tagWorker.start();
    let tagExecution: { status: string; step_status: string | null } | undefined;
    try {
      for (let attempt = 0; attempt < 80; attempt++) {
        tagExecution = (await fixture.query<{ status: string; step_status: string | null }>(
          `SELECT r.status,s.status AS step_status FROM public.automation_runs r
             JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
             LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.node_id=$3::uuid
            WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$4::uuid ORDER BY r.generation DESC LIMIT 1`,
          [tenantIds[0], created.workflow.id, tagActionId, contactId],
        )).rows[0];
        if (tagExecution?.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally { await tagWorker.stop(); }
    assert.deepEqual(tagExecution, { status: "succeeded", step_status: "succeeded" });
    const taggedContact = await fixture.query<{ tags: string[] }>("SELECT tags FROM public.contacts WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], contactId]);
    assert.deepEqual(taggedContact.rows[0]?.tags, ["seguimiento"]);
    const duplicateTagEventId = randomUUID();
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query(
      "INSERT INTO public.automation_event_outbox (id,tenant_id,event_type,origin,actor_type,actor_id,entity_type,entity_id,payload) VALUES ($1::uuid,$2::uuid,'contact.created','crm','user','crm05f-tag-idempotency-e2e','contact',$3::uuid,jsonb_build_object('source','manual'))",
      [duplicateTagEventId, tenantIds[0], contactId],
    );
    await fixture.query("COMMIT");
    const duplicateTagWorker = new AutomationEngineWorker(apiPool, 20); await duplicateTagWorker.start();
    let duplicateTagResults: { total: number; changed: number } | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        duplicateTagResults = (await fixture.query<{ total: number; changed: number }>(
          "SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE s.output_snapshot->>'changed'='true')::int AS changed FROM public.automation_runs r JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$3::uuid AND e.event_type='contact.created' AND s.node_id=$4::uuid AND s.status='succeeded'",
          [tenantIds[0], created.workflow.id, contactId, tagActionId],
        )).rows[0];
        if (duplicateTagResults?.total === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 40));
      }
    } finally { await duplicateTagWorker.stop(); }
    assert.deepEqual(duplicateTagResults, { total: 2, changed: 1 }, "repeated tag actions change and audit the contact once");
    const tagAudit = await fixture.query<{ total: number }>("SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action='contact.tag_added_by_automation'", [tenantIds[0], contactId]);
    assert.equal(tagAudit.rows[0]?.total, 1);    const otherTenantContact = await fixture.query("SELECT 1 FROM public.contacts WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[1], contactId]);
    assert.equal(otherTenantContact.rowCount, 0);

    const removeDefinition = { ...tagDefinition, name: "Quitar etiqueta al editar contacto", nodes: tagDefinition.nodes.map((node) =>
      node.id === tagTriggerId ? { ...node, config: { eventType: "contact.updated" } }
        : node.id === tagActionId ? { ...node, config: { action: "remove", tag: "seguimiento" } } : node) };
    const saveRemoveDraft = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, { method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: removeDefinition.name, definition: removeDefinition, expectedRevision: 4 }) });
    assert.equal(saveRemoveDraft.status, 200);
    const publishRemove = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: 5 }) });
    assert.equal(publishRemove.status, 200);
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query("UPDATE public.contacts SET display_name='CRM-05 tag test updated' WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], contactId]);
    await fixture.query("COMMIT");
    const removeWorker = new AutomationEngineWorker(apiPool, 20); await removeWorker.start();
    let removeExecution: { status: string; step_status: string | null } | undefined;
    try {
      for (let attempt = 0; attempt < 80; attempt++) {
        removeExecution = (await fixture.query<{ status: string; step_status: string | null }>(
          `SELECT r.status,s.status AS step_status FROM public.automation_runs r
             JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
             LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.node_id=$3::uuid
            WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$4::uuid AND e.event_type='contact.updated' ORDER BY r.generation DESC LIMIT 1`,
          [tenantIds[0], created.workflow.id, tagActionId, contactId],
        )).rows[0];
        if (removeExecution?.status === "succeeded") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally { await removeWorker.stop(); }
    assert.deepEqual(removeExecution, { status: "succeeded", step_status: "succeeded" });
    const untaggedContact = await fixture.query<{ tags: string[] }>("SELECT tags FROM public.contacts WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], contactId]);
    assert.deepEqual(untaggedContact.rows[0]?.tags, []);

    const fieldTriggerId = randomUUID(); const fieldActionId = randomUUID(); const fieldEndId = randomUUID();
    const fieldDefinition = { schemaVersion: 1, name: "Definir idioma de contacto", nodes: [
      { id: fieldTriggerId, type: "trigger.event", position: { x: 0, y: 0 }, config: { eventType: "contact.updated" } },
      { id: fieldActionId, type: "contact.update_field", position: { x: 300, y: 0 }, config: { field: "preferredLanguage", value: "es" } },
      { id: fieldEndId, type: "flow.end", position: { x: 600, y: 0 }, config: { outcome: "complete" } },
    ], edges: [
      { id: randomUUID(), source: fieldTriggerId, sourcePort: "next", target: fieldActionId, targetPort: "in" },
      { id: randomUUID(), source: fieldActionId, sourcePort: "next", target: fieldEndId, targetPort: "in" },
    ] };
    const saveFieldDraft = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, { method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: fieldDefinition.name, definition: fieldDefinition, expectedRevision: 5 }) });
    assert.equal(saveFieldDraft.status, 200);
    const publishField = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: 6 }) });
    assert.equal(publishField.status, 200);
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query("UPDATE public.contacts SET preferred_language='en' WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], contactId]);
    await fixture.query("COMMIT");
    const fieldWorker = new AutomationEngineWorker(apiPool, 20); await fieldWorker.start();
    let fieldResults: { total: number; changed: number } | undefined;
    try {
      for (let attempt = 0; attempt < 80; attempt++) {
        fieldResults = (await fixture.query<{ total: number; changed: number }>(
          `SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE s.output_snapshot->>'changed'='true')::int AS changed
             FROM public.automation_runs r JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
             JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
            WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$3::uuid AND e.event_type='contact.updated'
              AND s.node_id=$4::uuid AND s.status='succeeded'`,
          [tenantIds[0], created.workflow.id, contactId, fieldActionId],
        )).rows[0];
        if (fieldResults?.total && fieldResults.changed === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally { await fieldWorker.stop(); }
    assert.deepEqual(fieldResults, { total: 1, changed: 1 });
    const replayEventId = randomUUID();
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query(
      `INSERT INTO public.automation_event_outbox (id,tenant_id,event_type,origin,actor_type,actor_id,entity_type,entity_id,payload)
       VALUES ($1::uuid,$2::uuid,'contact.updated','crm','user','crm05f-idempotency-e2e','contact',$3::uuid,'{\"changedFields\":[\"preferredLanguage\"]}'::jsonb)`,
      [replayEventId, tenantIds[0], contactId],
    );
    await fixture.query("COMMIT");
    const replayWorker = new AutomationEngineWorker(apiPool, 20); await replayWorker.start();
    try {
      for (let attempt = 0; attempt < 80; attempt++) {
        fieldResults = (await fixture.query<{ total: number; changed: number }>(
          `SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE s.output_snapshot->>'changed'='true')::int AS changed
             FROM public.automation_runs r JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
             JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
            WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$3::uuid AND e.event_type='contact.updated'
              AND s.node_id=$4::uuid AND s.status='succeeded'`,
          [tenantIds[0], created.workflow.id, contactId, fieldActionId],
        )).rows[0];
        if (fieldResults?.total === 2) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally { await replayWorker.stop(); }
    assert.deepEqual(fieldResults, { total: 2, changed: 1 });
    const updatedField = await fixture.query<{ preferred_language: string }>("SELECT preferred_language FROM public.contacts WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], contactId]);
    assert.equal(updatedField.rows[0]?.preferred_language, "es");
    const fieldAudit = await fixture.query<{ total: number }>("SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action='contact.field_updated_by_automation'", [tenantIds[0], contactId]);
    assert.equal(fieldAudit.rows[0]?.total, 1);

    const conversationId = randomUUID(); const assignTriggerId = randomUUID(); const assignActionId = randomUUID(); const assignEndId = randomUUID();
    const assignmentDefinition = { schemaVersion: 1, name: "Asignar conversación", nodes: [
      { id: assignTriggerId, type: "trigger.event", position: { x: 0, y: 0 }, config: { eventType: "conversation.assigned" } },
      { id: assignActionId, type: "conversation.assign", position: { x: 300, y: 0 }, config: { assignedUserId: userIds[0] } },
      { id: assignEndId, type: "flow.end", position: { x: 600, y: 0 }, config: { outcome: "complete" } },
    ], edges: [
      { id: randomUUID(), source: assignTriggerId, sourcePort: "next", target: assignActionId, targetPort: "in" },
      { id: randomUUID(), source: assignActionId, sourcePort: "next", target: assignEndId, targetPort: "in" },
    ] };
    const invalidAssignmentDefinition = { ...assignmentDefinition, nodes: assignmentDefinition.nodes.map((node) => node.id === assignActionId ? { ...node, config: { assignedUserId: userIds[1] } } : node) };
    const saveInvalidAssignmentDraft = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, { method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: invalidAssignmentDefinition.name, definition: invalidAssignmentDefinition, expectedRevision: 6 }) });
    assert.equal(saveInvalidAssignmentDraft.status, 200);
    const invalidAssignmentPublish = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: 7 }) });
    assert.equal(invalidAssignmentPublish.status, 400, "a user from another dealer cannot be assigned by a workflow");
    const saveAssignmentDraft = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, { method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: assignmentDefinition.name, definition: assignmentDefinition, expectedRevision: 7 }) });
    assert.equal(saveAssignmentDraft.status, 200);
    const publishAssignment = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: 8 }) });
    assert.equal(publishAssignment.status, 200);
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query("INSERT INTO public.conversations (id,tenant_id,contact_id,provider_conversation_id,channel,state) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'messenger','open')", [conversationId, tenantIds[0], contactId, `crm05f:${randomUUID()}`]);
    await fixture.query(
      `INSERT INTO public.automation_event_outbox (id,tenant_id,event_type,origin,actor_type,actor_id,entity_type,entity_id,payload)
       VALUES ($1::uuid,$2::uuid,'conversation.assigned','crm','user','crm05f-assign-e2e','conversation',$3::uuid,jsonb_build_object('contactId',$4::uuid,'previousAssigneeId',NULL,'assigneeId',NULL))`,
      [randomUUID(), tenantIds[0], conversationId, contactId],
    );
    await fixture.query("COMMIT");
    const assignmentWorker = new AutomationEngineWorker(apiPool, 20); await assignmentWorker.start();
    let assignmentResults: { total: number; changed: number } | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        assignmentResults = (await fixture.query<{ total: number; changed: number }>(
          `SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE s.output_snapshot->>'changed'='true')::int AS changed
             FROM public.automation_runs r JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
             JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
            WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$3::uuid
              AND e.event_type='conversation.assigned' AND s.node_id=$4::uuid AND s.status='succeeded'`,
          [tenantIds[0], created.workflow.id, conversationId, assignActionId],
        )).rows[0];
        if (assignmentResults?.total === 2 && assignmentResults.changed === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally { await assignmentWorker.stop(); }
    const assignmentDiagnostics = await fixture.query("SELECT r.status,r.last_error,e.status AS event_status,e.event_type,s.status AS step_status,s.error_message AS step_error FROM public.automation_runs r JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$3::uuid", [tenantIds[0], created.workflow.id, conversationId]);
    assert.deepEqual(assignmentResults, { total: 2, changed: 1 }, `the assignment event raised by the action is idempotent; runs=${JSON.stringify(assignmentDiagnostics.rows)}`);
    const assignedConversation = await fixture.query<{ assigned_user_id: string }>("SELECT assigned_user_id::text FROM public.conversations WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], conversationId]);
    assert.equal(assignedConversation.rows[0]?.assigned_user_id, userIds[0]);
    const assignmentAudit = await fixture.query<{ total: number }>("SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action='conversation.assigned_by_automation'", [tenantIds[0], conversationId]);
    assert.equal(assignmentAudit.rows[0]?.total, 1);

    const oppAssignTriggerId = randomUUID(); const oppAssignActionId = randomUUID(); const oppAssignEndId = randomUUID();
    const opportunityAssignment = { schemaVersion: 1, name: "Asignar oportunidad", nodes: [
      { id: oppAssignTriggerId, type: "trigger.event", position: { x: 0, y: 0 }, config: { eventType: "opportunity.assigned" } },
      { id: oppAssignActionId, type: "opportunity.assign", position: { x: 300, y: 0 }, config: { assignedUserId: userIds[0] } },
      { id: oppAssignEndId, type: "flow.end", position: { x: 600, y: 0 }, config: { outcome: "complete" } },
    ], edges: [
      { id: randomUUID(), source: oppAssignTriggerId, sourcePort: "next", target: oppAssignActionId, targetPort: "in" },
      { id: randomUUID(), source: oppAssignActionId, sourcePort: "next", target: oppAssignEndId, targetPort: "in" },
    ] };
    const invalidOpportunityAssignment = { ...opportunityAssignment, nodes: opportunityAssignment.nodes.map((node) => node.id === oppAssignActionId ? { ...node, config: { assignedUserId: userIds[1] } } : node) };
    const saveInvalidOpportunityAssignment = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, { method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: invalidOpportunityAssignment.name, definition: invalidOpportunityAssignment, expectedRevision: 8 }) });
    assert.equal(saveInvalidOpportunityAssignment.status, 200);
    const publishInvalidOpportunityAssignment = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: 9 }) });
    assert.equal(publishInvalidOpportunityAssignment.status, 400, "a user from another dealer cannot be assigned to an opportunity");
    const saveOpportunityAssignment = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, { method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: opportunityAssignment.name, definition: opportunityAssignment, expectedRevision: 9 }) });
    assert.equal(saveOpportunityAssignment.status, 200);
    const publishOpportunityAssignment = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: 10 }) });
    assert.equal(publishOpportunityAssignment.status, 200);
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query(
      `INSERT INTO public.automation_event_outbox (id,tenant_id,event_type,origin,actor_type,actor_id,entity_type,entity_id,payload)
       VALUES ($1::uuid,$2::uuid,'opportunity.assigned','crm','user','crm05f-opp-assign-e2e','opportunity',$3::uuid,jsonb_build_object('previousAssigneeId',NULL,'assigneeId',NULL))`,
      [randomUUID(), tenantIds[0], opportunityId],
    );
    await fixture.query("COMMIT");
    const opportunityAssignmentWorker = new AutomationEngineWorker(apiPool, 20); await opportunityAssignmentWorker.start();
    let opportunityAssignmentResults: { total: number; changed: number } | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        opportunityAssignmentResults = (await fixture.query<{ total: number; changed: number }>(
          `SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE s.output_snapshot->>'changed'='true')::int AS changed
             FROM public.automation_runs r JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
             JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
            WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$3::uuid
              AND e.event_type='opportunity.assigned' AND s.node_id=$4::uuid AND s.status='succeeded'`,
          [tenantIds[0], created.workflow.id, opportunityId, oppAssignActionId],
        )).rows[0];
        if (opportunityAssignmentResults?.total === 2 && opportunityAssignmentResults.changed === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally { await opportunityAssignmentWorker.stop(); }
    assert.deepEqual(opportunityAssignmentResults, { total: 2, changed: 1 }, "the opportunity assignment event raised by the action is idempotent");
    const assignedOpportunity = await fixture.query<{ assigned_user_id: string }>("SELECT assigned_user_id::text FROM public.opportunities WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], opportunityId]);
    assert.equal(assignedOpportunity.rows[0]?.assigned_user_id, userIds[0]);
    const opportunityAssignmentAudit = await fixture.query<{ total: number }>("SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action='opportunity.assigned_by_automation'", [tenantIds[0], opportunityId]);
    assert.equal(opportunityAssignmentAudit.rows[0]?.total, 1);

    const appointmentId = randomUUID(); const appointmentTriggerId = randomUUID(); const appointmentActionId = randomUUID(); const appointmentEndId = randomUUID();
    const appointmentDefinition = { schemaVersion: 1, name: "Confirmar cita", nodes: [
      { id: appointmentTriggerId, type: "trigger.event", position: { x: 0, y: 0 }, config: { eventType: "appointment.status_changed" } },
      { id: appointmentActionId, type: "appointment.update_status", position: { x: 300, y: 0 }, config: { status: "confirmed" } },
      { id: appointmentEndId, type: "flow.end", position: { x: 600, y: 0 }, config: { outcome: "complete" } },
    ], edges: [
      { id: randomUUID(), source: appointmentTriggerId, sourcePort: "next", target: appointmentActionId, targetPort: "in" },
      { id: randomUUID(), source: appointmentActionId, sourcePort: "next", target: appointmentEndId, targetPort: "in" },
    ] };
    const saveAppointmentDraft = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, { method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: appointmentDefinition.name, definition: appointmentDefinition, expectedRevision: 10 }) });
    assert.equal(saveAppointmentDraft.status, 200);
    const publishAppointment = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/publish`, { method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: 11 }) });
    assert.equal(publishAppointment.status, 200);
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query(
      "INSERT INTO public.appointments (id,tenant_id,contact_id,title,starts_at,ends_at,status) VALUES ($1::uuid,$2::uuid,$3::uuid,'CRM-05 appointment status E2E',now()+interval '1 hour',now()+interval '2 hours','scheduled')",
      [appointmentId, tenantIds[0], contactId],
    );
    await fixture.query(
      `INSERT INTO public.automation_event_outbox (id,tenant_id,event_type,origin,actor_type,actor_id,entity_type,entity_id,payload)
       VALUES ($1::uuid,$2::uuid,'appointment.status_changed','crm','user','crm05f-appointment-status-e2e','appointment',$3::uuid,jsonb_build_object('contactId',$4::uuid,'previousStatus','scheduled','status','confirmed'))`,
      [randomUUID(), tenantIds[0], appointmentId, contactId],
    );
    await fixture.query("COMMIT");
    const appointmentStatusWorker = new AutomationEngineWorker(apiPool, 20); await appointmentStatusWorker.start();
    let appointmentResults: { total: number; changed: number } | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        appointmentResults = (await fixture.query<{ total: number; changed: number }>(
          `SELECT COUNT(*)::int AS total,COUNT(*) FILTER (WHERE s.output_snapshot->>'changed'='true')::int AS changed
             FROM public.automation_runs r JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
             JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
            WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.entity_id=$3::uuid
              AND e.event_type='appointment.status_changed' AND s.node_id=$4::uuid AND s.status='succeeded'`,
          [tenantIds[0], created.workflow.id, appointmentId, appointmentActionId],
        )).rows[0];
        if (appointmentResults?.total === 2 && appointmentResults.changed === 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally { await appointmentStatusWorker.stop(); }
    assert.deepEqual(appointmentResults, { total: 2, changed: 1 }, "the status event raised by the action is idempotent");
    const updatedAppointment = await fixture.query<{ status: string }>("SELECT status FROM public.appointments WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], appointmentId]);
    assert.equal(updatedAppointment.rows[0]?.status, "confirmed");
    const appointmentAudit = await fixture.query<{ total: number }>("SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action='appointment.status_updated_by_automation'", [tenantIds[0], appointmentId]);
    assert.equal(appointmentAudit.rows[0]?.total, 1);

    const foreignAppointmentId = randomUUID(); const foreignAppointmentEventId = randomUUID();
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[1]]);
    await fixture.query(
      "INSERT INTO public.appointments (id,tenant_id,title,starts_at,ends_at,status) VALUES ($1::uuid,$2::uuid,'Foreign appointment isolation E2E',now()+interval '1 hour',now()+interval '2 hours','scheduled')",
      [foreignAppointmentId, tenantIds[1]],
    );
    await fixture.query("COMMIT");
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query(
      `INSERT INTO public.automation_event_outbox (id,tenant_id,event_type,origin,actor_type,actor_id,entity_type,entity_id,payload)
       VALUES ($1::uuid,$2::uuid,'appointment.status_changed','crm','user','crm05f-appointment-isolation-e2e','appointment',$3::uuid,jsonb_build_object('previousStatus','scheduled','status','confirmed'))`,
      [foreignAppointmentEventId, tenantIds[0], foreignAppointmentId],
    );
    await fixture.query("COMMIT");
    const appointmentIsolationWorker = new AutomationEngineWorker(apiPool, 20); await appointmentIsolationWorker.start();
    let foreignAppointmentRun: { status: string; step_status: string | null; attempts: number } | undefined;
    try {
      for (let attempt = 0; attempt < 100; attempt++) {
        foreignAppointmentRun = (await fixture.query<{ status: string; step_status: string | null; attempts: number }>(
          `SELECT r.status,s.status AS step_status,r.attempts
             FROM public.automation_runs r JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
             LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.node_id=$3::uuid
            WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.id=$4::uuid`,
          [tenantIds[0], created.workflow.id, appointmentActionId, foreignAppointmentEventId],
        )).rows[0];
        if (foreignAppointmentRun?.step_status === "failed") break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally { await appointmentIsolationWorker.stop(); }
    assert.equal(foreignAppointmentRun?.step_status, "failed", "the appointment action refuses a foreign-dealer appointment");
    assert.ok((foreignAppointmentRun?.attempts ?? 0) >= 1);
    const foreignAppointment = await fixture.query<{ status: string }>("SELECT status FROM public.appointments WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[1], foreignAppointmentId]);
    assert.equal(foreignAppointment.rows[0]?.status, "scheduled", "a workflow from another dealer cannot mutate the appointment");
    const foreignAppointmentAudit = await fixture.query<{ total: number }>("SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action='appointment.status_updated_by_automation'", [tenantIds[0], foreignAppointmentId]);
    assert.equal(foreignAppointmentAudit.rows[0]?.total, 0);

    const foreignContactId = randomUUID(); const foreignOpportunityId = randomUUID(); const foreignConversationId = randomUUID();
    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[1]]);
    await fixture.query(
      "INSERT INTO public.contacts (id,tenant_id,provider_contact_id,display_name) VALUES ($1::uuid,$2::uuid,$3,'CRM-05 foreign contact')",
      [foreignContactId, tenantIds[1], `manual:${randomUUID()}`],
    );
    await fixture.query(
      "INSERT INTO public.opportunities (id,tenant_id,title,contact_name,amount_cents,stage) VALUES ($1::uuid,$2::uuid,'CRM-05 foreign opportunity','Foreign contact',125000,'new')",
      [foreignOpportunityId, tenantIds[1]],
    );
    await fixture.query(
      "INSERT INTO public.conversations (id,tenant_id,contact_id,provider_conversation_id,channel,state) VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'messenger','open')",
      [foreignConversationId, tenantIds[1], foreignContactId, `crm05f:${randomUUID()}`],
    );
    await fixture.query("COMMIT");

    let workflowRevision = 11;
    async function assertForeignEntityActionRejected(input: {
      name: string;
      eventType: string;
      entityType: string;
      entityId: string;
      payload: Record<string, unknown>;
      actionType: string;
      config: Record<string, unknown>;
      verifyUnchanged: () => Promise<void>;
    }): Promise<void> {
      const triggerId = randomUUID(); const actionId = randomUUID(); const endId = randomUUID(); const foreignEventId = randomUUID();
      const definition = { schemaVersion: 1, name: input.name, nodes: [
        { id: triggerId, type: "trigger.event", position: { x: 0, y: 0 }, config: { eventType: input.eventType } },
        { id: actionId, type: input.actionType, position: { x: 300, y: 0 }, config: input.config },
        { id: endId, type: "flow.end", position: { x: 600, y: 0 }, config: { outcome: "complete" } },
      ], edges: [
        { id: randomUUID(), source: triggerId, sourcePort: "next", target: actionId, targetPort: "in" },
        { id: randomUUID(), source: actionId, sourcePort: "next", target: endId, targetPort: "in" },
      ] };
      const save = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/draft?dealerId=${tenantIds[0]}`, {
        method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: definition.name, definition, expectedRevision: workflowRevision }),
      });
      assert.equal(save.status, 200, `save ${input.name}`);
      workflowRevision += 1;
      const publish = await request(port, tokens[0]!, `/auth/automation/workflows/${created.workflow.id}/publish`, {
        method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: workflowRevision }),
      });
      assert.equal(publish.status, 200, `publish ${input.name}`);
      await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
      await fixture.query(
        `INSERT INTO public.automation_event_outbox (id,tenant_id,event_type,origin,actor_type,actor_id,entity_type,entity_id,payload)
         VALUES ($1::uuid,$2::uuid,$3,'crm','user','crm05f-foreign-action-e2e',$4,$5::uuid,$6::jsonb)`,
        [foreignEventId, tenantIds[0], input.eventType, input.entityType, input.entityId, JSON.stringify(input.payload)],
      );
      await fixture.query("COMMIT");
      const workerForAction = new AutomationEngineWorker(apiPool, 20); await workerForAction.start();
      let result: { run_id: string; status: string; step_status: string | null; attempts: number; step_attempts: number } | undefined;
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          result = (await fixture.query<{ run_id: string; status: string; step_status: string | null; attempts: number; step_attempts: number }>(
            `SELECT r.id::text AS run_id,r.status,s.status AS step_status,r.attempts,s.attempts AS step_attempts
               FROM public.automation_runs r JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
               LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.node_id=$3::uuid
              WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.id=$4::uuid`,
            [tenantIds[0], created.workflow.id, actionId, foreignEventId],
          )).rows[0];
          if (result?.step_status === "failed") break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally { await workerForAction.stop(); }
      assert.equal(result?.step_status, "failed", `${input.actionType} must reject a foreign ${input.entityType}`);
      assert.ok((result?.attempts ?? 0) >= 1);

      await fixture.query(
        "UPDATE public.automation_runs SET status='failed',attempts=4,finished_at=now(),updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid",
        [tenantIds[0], result!.run_id],
      );
      const retryResponse = await request(port, tokens[0]!, `/auth/automation/runs/${result!.run_id}/retry`, {
        method: "POST", body: JSON.stringify({ dealerId: tenantIds[0] }),
      });
      assert.equal(retryResponse.status, 200, `${input.actionType} supports retry after a failed action`);
      assert.equal(((await retryResponse.json()) as { run: { status: string } }).run.status, "queued");
      const retryWorker = new AutomationEngineWorker(apiPool, 20); await retryWorker.start();
      try {
        for (let attempt = 0; attempt < 100; attempt++) {
          result = (await fixture.query<{ run_id: string; status: string; step_status: string | null; attempts: number; step_attempts: number }>(
            `SELECT r.id::text AS run_id,r.status,s.status AS step_status,r.attempts,s.attempts AS step_attempts
               FROM public.automation_runs r JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id
               LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.node_id=$3::uuid
              WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.id=$4::uuid`,
            [tenantIds[0], created.workflow.id, actionId, foreignEventId],
          )).rows[0];
          if ((result?.step_attempts ?? 0) >= 2) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      } finally { await retryWorker.stop(); }
      assert.equal(result?.step_status, "failed", `${input.actionType} keeps rejecting the foreign ${input.entityType} after retry`);
      assert.ok((result?.step_attempts ?? 0) >= 2, `${input.actionType} records the retried step`);
      await input.verifyUnchanged();
      const actionAudit = await fixture.query<{ total: number }>(
        "SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action LIKE '%_by_automation'",
        [tenantIds[0], input.entityId],
      );
      assert.equal(actionAudit.rows[0]?.total, 0, `${input.actionType} must not audit changes to another dealer's entity, including after retry`);
    }
    const foreignContact = async () => fixture.query<{ display_name: string; tags: string[] }>(
      "SELECT display_name,tags FROM public.contacts WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[1], foreignContactId],
    );
    await assertForeignEntityActionRejected({
      name: "Foreign contact tag guard", eventType: "contact.updated", entityType: "contact", entityId: foreignContactId,
      payload: { changedFields: ["displayName"] }, actionType: "contact.manage_tag", config: { action: "add", tag: "unauthorized" },
      verifyUnchanged: async () => assert.deepEqual((await foreignContact()).rows[0], { display_name: "CRM-05 foreign contact", tags: [] }),
    });
    await assertForeignEntityActionRejected({
      name: "Foreign contact field guard", eventType: "contact.updated", entityType: "contact", entityId: foreignContactId,
      payload: { changedFields: ["displayName"] }, actionType: "contact.update_field", config: { field: "displayName", value: "Changed by foreign dealer" },
      verifyUnchanged: async () => assert.deepEqual((await foreignContact()).rows[0], { display_name: "CRM-05 foreign contact", tags: [] }),
    });
    await assertForeignEntityActionRejected({
      name: "Foreign opportunity stage guard", eventType: "opportunity.stage_changed", entityType: "opportunity", entityId: foreignOpportunityId,
      payload: { previousStage: "new", stage: "working" }, actionType: "opportunity.update_stage", config: { stage: "won" },
      verifyUnchanged: async () => assert.equal((await fixture.query<{ stage: string }>("SELECT stage FROM public.opportunities WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[1], foreignOpportunityId])).rows[0]?.stage, "new"),
    });
    await assertForeignEntityActionRejected({
      name: "Foreign opportunity assignment guard", eventType: "opportunity.assigned", entityType: "opportunity", entityId: foreignOpportunityId,
      payload: { previousAssigneeId: null, assigneeId: userIds[1] }, actionType: "opportunity.assign", config: { assignedUserId: userIds[0] },
      verifyUnchanged: async () => assert.equal((await fixture.query<{ assigned_user_id: string | null }>("SELECT assigned_user_id::text FROM public.opportunities WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[1], foreignOpportunityId])).rows[0]?.assigned_user_id, null),
    });
    await assertForeignEntityActionRejected({
      name: "Foreign conversation assignment guard", eventType: "conversation.assigned", entityType: "conversation", entityId: foreignConversationId,
      payload: { contactId: foreignContactId, previousAssigneeId: null, assigneeId: null }, actionType: "conversation.assign", config: { assignedUserId: userIds[0] },
      verifyUnchanged: async () => assert.equal((await fixture.query<{ assigned_user_id: string | null }>("SELECT assigned_user_id::text FROM public.conversations WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[1], foreignConversationId])).rows[0]?.assigned_user_id, null),
    });

    await fixture.query("CREATE SEQUENCE IF NOT EXISTS public.crm05f_retry_fault_seq");
    await fixture.query("GRANT USAGE, SELECT ON SEQUENCE public.crm05f_retry_fault_seq TO bdc");
    await fixture.query("CREATE OR REPLACE FUNCTION public.crm05f_retry_fault() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id::text=TG_ARGV[0] AND current_setting('app.automation_origin',true)='system' AND nextval('public.crm05f_retry_fault_seq')=1 THEN RAISE EXCEPTION 'CRM-05-F transient test failure'; END IF; RETURN NEW; END $$");
    async function assertTransientActionRetry(input: {
      name: string; eventType: string; entityType: string; entityId: string; payload: Record<string, unknown>;
      actionType: string; config: Record<string, unknown>; table: "contacts" | "opportunities" | "conversations" | "appointments";
      auditAction: string; verifyBefore: () => Promise<void>; verifyAfter: () => Promise<void>;
    }): Promise<void> {
      const triggerId = randomUUID(); const actionId = randomUUID(); const endId = randomUUID(); const outboxId = randomUUID();
      const definition = { schemaVersion: 1, name: input.name, nodes: [
        { id: triggerId, type: "trigger.event", position: { x: 0, y: 0 }, config: { eventType: input.eventType } },
        { id: actionId, type: input.actionType, position: { x: 300, y: 0 }, config: input.config },
        { id: endId, type: "flow.end", position: { x: 600, y: 0 }, config: { outcome: "complete" } },
      ], edges: [
        { id: randomUUID(), source: triggerId, sourcePort: "next", target: actionId, targetPort: "in" },
        { id: randomUUID(), source: actionId, sourcePort: "next", target: endId, targetPort: "in" },
      ] };
      const save = await request(port, tokens[0]!, "/auth/automation/workflows/" + created.workflow.id + "/draft?dealerId=" + tenantIds[0], {
        method: "PUT", body: JSON.stringify({ dealerId: tenantIds[0], name: definition.name, definition, expectedRevision: workflowRevision }),
      });
      assert.equal(save.status, 200, "save transient retry workflow: " + input.name);
      workflowRevision += 1;
      const publish = await request(port, tokens[0]!, "/auth/automation/workflows/" + created.workflow.id + "/publish", {
        method: "POST", body: JSON.stringify({ dealerId: tenantIds[0], expectedRevision: workflowRevision }),
      });
      assert.equal(publish.status, 200, "publish transient retry workflow: " + input.name);
      const auditBefore = (await fixture.query<{ total: number }>(
        "SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action=$3",
        [tenantIds[0], input.entityId, input.auditAction],
      )).rows[0]!.total;
      await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
      await fixture.query(
        "INSERT INTO public.automation_event_outbox (id,tenant_id,event_type,origin,actor_type,actor_id,entity_type,entity_id,payload) VALUES ($1::uuid,$2::uuid,$3,'crm','user','crm05f-transient-retry',$4,$5::uuid,$6::jsonb)",
        [outboxId, tenantIds[0], input.eventType, input.entityType, input.entityId, JSON.stringify(input.payload)],
      );
      await fixture.query("COMMIT");
      await fixture.query("DROP TRIGGER IF EXISTS crm05f_retry_fault ON public." + input.table);
      await fixture.query("CREATE TRIGGER crm05f_retry_fault BEFORE UPDATE ON public." + input.table + " FOR EACH ROW EXECUTE FUNCTION public.crm05f_retry_fault('" + input.entityId + "')");
      await fixture.query("SELECT setval('public.crm05f_retry_fault_seq',1,false)");
      try {
        const faultWorker = new AutomationEngineWorker(apiPool, 20); await faultWorker.start();
        let run: { id: string; status: string; step_status: string | null; step_attempts: number } | undefined;
        try {
          for (let attempt = 0; attempt < 100; attempt++) {
            run = (await fixture.query<{ id: string; status: string; step_status: string | null; step_attempts: number }>(
              "SELECT r.id::text AS id,r.status,s.status AS step_status,s.attempts AS step_attempts FROM public.automation_runs r JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.node_id=$3::uuid WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.id=$4::uuid",
              [tenantIds[0], created.workflow.id, actionId, outboxId],
            )).rows[0];
            if (run?.step_status === "failed") break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        } finally { await faultWorker.stop(); }
        assert.equal(run?.step_status, "failed", input.actionType + " fails once on a transient database error");
        await input.verifyBefore();
        assert.equal((await fixture.query<{ total: number }>(
          "SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action=$3",
          [tenantIds[0], input.entityId, input.auditAction],
        )).rows[0]?.total, auditBefore, input.actionType + " does not audit the rolled-back attempt");
        await fixture.query("UPDATE public.automation_runs SET status='failed',attempts=4,finished_at=now(),updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], run!.id]);
        const retryResponse = await request(port, tokens[0]!, "/auth/automation/runs/" + run!.id + "/retry", {
          method: "POST", body: JSON.stringify({ dealerId: tenantIds[0] }),
        });
        assert.equal(retryResponse.status, 200, input.actionType + " accepts retry after failure");
        const recoveryWorker = new AutomationEngineWorker(apiPool, 20); await recoveryWorker.start();
        try {
          for (let attempt = 0; attempt < 100; attempt++) {
            run = (await fixture.query<{ id: string; status: string; step_status: string | null; step_attempts: number }>(
              "SELECT r.id::text AS id,r.status,s.status AS step_status,s.attempts AS step_attempts FROM public.automation_runs r JOIN public.automation_event_outbox e ON e.tenant_id=r.tenant_id AND e.id=r.event_id LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id AND s.node_id=$3::uuid WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid AND e.id=$4::uuid",
              [tenantIds[0], created.workflow.id, actionId, outboxId],
            )).rows[0];
            if (run?.status === "succeeded" && (run.step_attempts ?? 0) >= 2) break;
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        } finally { await recoveryWorker.stop(); }
        assert.equal(run?.status, "succeeded", input.actionType + " recovers on retry");
        assert.equal(run?.step_status, "succeeded");
        assert.ok((run?.step_attempts ?? 0) >= 2);
        await input.verifyAfter();
        assert.equal((await fixture.query<{ total: number }>(
          "SELECT COUNT(*)::int AS total FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND entity_id::text=$2::text AND action=$3",
          [tenantIds[0], input.entityId, input.auditAction],
        )).rows[0]?.total, auditBefore + 1, input.actionType + " produces one audit after recovery");
      } finally {
        await fixture.query("DROP TRIGGER IF EXISTS crm05f_retry_fault ON public." + input.table);
      }
    }
    try {
      await assertTransientActionRetry({
        name: "Transient contact tag retry", eventType: "contact.updated", entityType: "contact", entityId: contactId,
        payload: { changedFields: ["displayName"] }, actionType: "contact.manage_tag", config: { action: "add", tag: "retry-transient" },
        table: "contacts", auditAction: "contact.tag_added_by_automation",
        verifyBefore: async () => assert.deepEqual((await fixture.query<{ tags: string[] }>("SELECT tags FROM public.contacts WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], contactId])).rows[0]?.tags, []),
        verifyAfter: async () => assert.deepEqual((await fixture.query<{ tags: string[] }>("SELECT tags FROM public.contacts WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], contactId])).rows[0]?.tags, ["retry-transient"]),
      });
      await assertTransientActionRetry({
        name: "Transient contact field retry", eventType: "contact.updated", entityType: "contact", entityId: contactId,
        payload: { changedFields: ["preferredLanguage"] }, actionType: "contact.update_field", config: { field: "displayName", value: "Recovered display name" },
        table: "contacts", auditAction: "contact.field_updated_by_automation",
        verifyBefore: async () => assert.equal((await fixture.query<{ display_name: string }>("SELECT display_name FROM public.contacts WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], contactId])).rows[0]?.display_name, "CRM-05 tag test updated"),
        verifyAfter: async () => assert.equal((await fixture.query<{ display_name: string }>("SELECT display_name FROM public.contacts WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], contactId])).rows[0]?.display_name, "Recovered display name"),
      });
      await assertTransientActionRetry({
        name: "Transient opportunity assignment retry", eventType: "opportunity.assigned", entityType: "opportunity", entityId: opportunityId,
        payload: { previousAssigneeId: null, assigneeId: userIds[0] }, actionType: "opportunity.assign", config: { assignedUserId: null },
        table: "opportunities", auditAction: "opportunity.assigned_by_automation",
        verifyBefore: async () => assert.equal((await fixture.query<{ assigned_user_id: string | null }>("SELECT assigned_user_id::text FROM public.opportunities WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], opportunityId])).rows[0]?.assigned_user_id, userIds[0]),
        verifyAfter: async () => assert.equal((await fixture.query<{ assigned_user_id: string | null }>("SELECT assigned_user_id::text FROM public.opportunities WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], opportunityId])).rows[0]?.assigned_user_id, null),
      });
      await assertTransientActionRetry({
        name: "Transient conversation assignment retry", eventType: "conversation.assigned", entityType: "conversation", entityId: conversationId,
        payload: { contactId, previousAssigneeId: null, assigneeId: userIds[0] }, actionType: "conversation.assign", config: { assignedUserId: null },
        table: "conversations", auditAction: "conversation.assigned_by_automation",
        verifyBefore: async () => assert.equal((await fixture.query<{ assigned_user_id: string | null }>("SELECT assigned_user_id::text FROM public.conversations WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], conversationId])).rows[0]?.assigned_user_id, userIds[0]),
        verifyAfter: async () => assert.equal((await fixture.query<{ assigned_user_id: string | null }>("SELECT assigned_user_id::text FROM public.conversations WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], conversationId])).rows[0]?.assigned_user_id, null),
      });
      await assertTransientActionRetry({
        name: "Transient appointment status retry", eventType: "appointment.status_changed", entityType: "appointment", entityId: appointmentId,
        payload: { previousStatus: "scheduled", status: "confirmed" }, actionType: "appointment.update_status", config: { status: "no_show" },
        table: "appointments", auditAction: "appointment.status_updated_by_automation",
        verifyBefore: async () => assert.equal((await fixture.query<{ status: string }>("SELECT status FROM public.appointments WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], appointmentId])).rows[0]?.status, "confirmed"),
        verifyAfter: async () => assert.equal((await fixture.query<{ status: string }>("SELECT status FROM public.appointments WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], appointmentId])).rows[0]?.status, "no_show"),
      });
    } finally {
      await fixture.query("DROP TRIGGER IF EXISTS crm05f_retry_fault ON public.contacts");
      await fixture.query("DROP TRIGGER IF EXISTS crm05f_retry_fault ON public.opportunities");
      await fixture.query("DROP TRIGGER IF EXISTS crm05f_retry_fault ON public.conversations");
      await fixture.query("DROP TRIGGER IF EXISTS crm05f_retry_fault ON public.appointments");
      await fixture.query("DROP FUNCTION IF EXISTS public.crm05f_retry_fault()");
      await fixture.query("DROP SEQUENCE IF EXISTS public.crm05f_retry_fault_seq");
    }
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
