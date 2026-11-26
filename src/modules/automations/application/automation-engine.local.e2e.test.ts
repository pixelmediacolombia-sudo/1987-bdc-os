import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import test from "node:test";
import { AutomationEngineWorker } from "./automation-engine.worker";
import { ensureAdminAuditTable } from "@/features/identity/infrastructure/persistence/postgres/admin-audit.migration";
import { ensureTenantRowLevelSecurity } from "@/features/identity/infrastructure/persistence/postgres/tenant-rls.migration";
import { ensureRuntimeRolePrivileges } from "@/infrastructure/database/runtime-role.migration";
import { ensureAutomationEventOutbox } from "@/modules/automations/infrastructure/persistence/postgres/automation-event-outbox.migration";
import { ensureAutomationWorkflows } from "@/modules/automations/infrastructure/persistence/postgres/automation-workflows.migration";
import { ensureAutomationEngine } from "@/modules/automations/infrastructure/persistence/postgres/automation-engine.migration";

const enabled = process.env.AUTOMATION_ENGINE_E2E === "1" && Boolean(process.env.DATABASE_URL);
test("automation engine executes saved graph, deduplicates runs and scopes worker claims", { skip: !enabled }, async () => {
  const ssl = ["1", "true", "yes"].includes((process.env.PGSSL ?? "").toLowerCase()) ? { rejectUnauthorized: false } : undefined;
  const fixturePool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const runtimePool = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL, ssl, ...(process.env.RUNTIME_DATABASE_URL ? {} : { options: "-c role=bdc" }) });
  const migrationPool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL, ssl });
  await ensureAdminAuditTable(migrationPool); await ensureAutomationEventOutbox(migrationPool); await ensureAutomationWorkflows(migrationPool);
  await ensureAutomationEngine(migrationPool); await ensureTenantRowLevelSecurity(migrationPool); await ensureRuntimeRolePrivileges(migrationPool); await migrationPool.end();

  const fixture = await fixturePool.connect();
  const tenantIds = [randomUUID(), randomUUID()]; const userIds: string[] = [];
  const workflowIds = [randomUUID(), randomUUID()]; const triggerIds = [randomUUID(), randomUUID()];
  const conditionIds = [randomUUID(), randomUUID()]; const waitIds = [randomUUID(), randomUUID()]; const trueEndIds = [randomUUID(), randomUUID()]; const falseEndIds = [randomUUID(), randomUUID()];
  const eventId = randomUUID(); const messageId = randomUUID(); const conversationId = randomUUID(); const contactId = randomUUID();
  const connectionIds = Array.from({ length: 8 }, () => randomUUID());
  const definition = (index: number) => ({ schemaVersion: 1, name: `Engine E2E ${index + 1}`, nodes: [
    { id: triggerIds[index], type: "trigger.event", position: { x: 0, y: 0 }, config: { eventType: "message.received" } },
    { id: conditionIds[index], type: "condition.if", position: { x: 300, y: 0 }, config: { field: "message.channel", operator: "equals", value: "messenger" } },
    { id: waitIds[index], type: "flow.wait", position: { x: 600, y: 0 }, config: { durationSeconds: 1 } },
    { id: trueEndIds[index], type: "flow.end", position: { x: 900, y: 0 }, config: { outcome: "complete" } },
    { id: falseEndIds[index], type: "flow.end", position: { x: 600, y: 180 }, config: { outcome: "stop" } },
  ], edges: [
    { id: connectionIds[index * 4], source: triggerIds[index], sourcePort: "next", target: conditionIds[index], targetPort: "in" },
    { id: connectionIds[index * 4 + 1], source: conditionIds[index], sourcePort: "true", target: waitIds[index], targetPort: "in" },
    { id: connectionIds[index * 4 + 2], source: conditionIds[index], sourcePort: "false", target: falseEndIds[index], targetPort: "in" },
    { id: connectionIds[index * 4 + 3], source: waitIds[index], sourcePort: "next", target: trueEndIds[index], targetPort: "in" },
  ] });
  const event = { schemaVersion: 1, eventId, tenantId: tenantIds[0], type: "message.received", occurredAt: "2026-11-26T14:00:00.000Z", origin: "system", actor: { type: "contact" }, entity: { type: "message", id: messageId }, payload: { conversationId, contactId, channel: "Messenger", senderType: "client" } };
  const workers: AutomationEngineWorker[] = [];
  try {
    const users = await Promise.all(tenantIds.map((_, index) => fixturePool.query<{ id: string }>(
      "INSERT INTO public.app_users (email,display_name,account_type,status) VALUES ($1,$2,'user','active') RETURNING id::text AS id",
      [`engine-${randomUUID()}@example.test`, `Engine E2E ${index + 1}`],
    )));
    userIds.push(...users.map((result) => result.rows[0]!.id));
    for (const [index, tenantId] of tenantIds.entries()) {
      await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await fixture.query("INSERT INTO public.tenants (dealer_id,dealer_name,timezone,policy_version,status,sofia_enabled,qualification_flow_enabled,qualification_signal_enabled) VALUES ($1,$2,'America/New_York','crm05e-e2e','active',false,false,false)", [tenantId, `Engine Dealer ${index + 1}`]);
      await fixture.query("INSERT INTO public.user_tenant_memberships (user_id,tenant_id) VALUES ($1,$2)", [userIds[index], tenantId]);
      const graph = definition(index);
      await fixture.query(
        `INSERT INTO public.automation_workflows (id,tenant_id,name,draft_definition,draft_revision,published_definition,published_revision,created_by_user_id,updated_by_user_id)
         VALUES ($1::uuid,$2::uuid,$3,$4::jsonb,1,$4::jsonb,1,$5::uuid,$5::uuid)`,
        [workflowIds[index], tenantId, graph.name, JSON.stringify(graph), userIds[index]],
      );
      if (index === 0) {
        await fixture.query(
          `INSERT INTO public.automation_event_outbox (id,tenant_id,schema_version,event_type,origin,actor_type,entity_type,entity_id,payload)
           VALUES ($1::uuid,$2::uuid,1,'message.received','system','contact','message',$3::uuid,$4::jsonb)`,
          [eventId, tenantId, messageId, JSON.stringify(event.payload)],
        );
      }
      await fixture.query("COMMIT");
    }

    await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantIds[0]]);
    await fixture.query(
      `INSERT INTO public.automation_runs (tenant_id,workflow_id,event_id,generation,workflow_revision,event_type,event_snapshot,workflow_snapshot,current_node_id,attempts)
       VALUES ($1::uuid,$2::uuid,$3::uuid,2,1,'message.received',$4::jsonb,'{}'::jsonb,$5::uuid,4)`,
      [tenantIds[0], workflowIds[0], eventId, JSON.stringify(event), triggerIds[0]],
    );
    await fixture.query("COMMIT");

    const firstWorker = new AutomationEngineWorker(runtimePool, 20); workers.push(firstWorker); await firstWorker.start();
    const waitDeadline = Date.now() + 5_000;
    let paused: string | undefined;
    while (Date.now() < waitDeadline) {
      paused = await withTenant(runtimePool, tenantIds[0]!, async (client) => (await client.query<{ status: string }>(
        "SELECT status FROM public.automation_runs WHERE tenant_id=$1::uuid AND workflow_id=$2::uuid AND generation=1", [tenantIds[0], workflowIds[0]],
      )).rows[0]?.status);
      if (paused === "waiting") break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(paused, "waiting", "wait node must persist a waiting run before recovery");
    await firstWorker.stop();
    const restartedWorker = new AutomationEngineWorker(runtimePool, 20);
    const concurrentWorker = new AutomationEngineWorker(runtimePool, 20);
    workers.push(restartedWorker, concurrentWorker); await Promise.all([restartedWorker.start(), concurrentWorker.start()]);
    const deadline = Date.now() + 10_000;
    let states: Array<{ generation: number; status: string }> = [];
    while (Date.now() < deadline) {
      const result = await withTenant(runtimePool, tenantIds[0]!, async (client) => (await client.query<{ generation: number; status: string }>(
        "SELECT generation,status FROM public.automation_runs WHERE tenant_id=$1::uuid AND workflow_id=$2::uuid ORDER BY generation", [tenantIds[0], workflowIds[0]],
      )).rows);
      states = result;
      if (states.some((row) => row.generation === 1 && row.status === "succeeded") && states.some((row) => row.generation === 2 && row.status === "dead_letter")) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await Promise.all(workers.map((worker) => worker.stop()));
    const diagnostic = await withTenant(runtimePool, tenantIds[0]!, async (client) => ({
      runs: (await client.query("SELECT generation,status,attempts,last_error,current_node_id FROM public.automation_runs WHERE tenant_id=$1::uuid AND workflow_id=$2::uuid ORDER BY generation", [tenantIds[0], workflowIds[0]])).rows,
      event: (await client.query("SELECT status,attempts,last_error FROM public.automation_event_outbox WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], eventId])).rows[0],
    }));
    assert.deepEqual(states, [{ generation: 1, status: "succeeded" }, { generation: 2, status: "dead_letter" }], JSON.stringify(diagnostic));

    const results = await withTenant(runtimePool, tenantIds[0]!, async (client) => ({
      steps: (await client.query<{ node_id: string; output_snapshot: Record<string, unknown> | null; status: string }>(
        "SELECT node_id::text AS node_id,output_snapshot,status FROM public.automation_run_steps WHERE tenant_id=$1::uuid AND run_id=(SELECT id FROM public.automation_runs WHERE tenant_id=$1::uuid AND workflow_id=$2::uuid AND generation=1)", [tenantIds[0], workflowIds[0]],
      )).rows,
      event: (await client.query<{ status: string; attempts: number }>("SELECT status,attempts FROM public.automation_event_outbox WHERE tenant_id=$1::uuid AND id=$2::uuid", [tenantIds[0], eventId])).rows[0],
      runs: (await client.query<{ id: string; generation: number }>("SELECT id::text AS id,generation FROM public.automation_runs WHERE tenant_id=$1::uuid AND workflow_id=$2::uuid ORDER BY generation", [tenantIds[0], workflowIds[0]])).rows,
    }));
    assert.equal(results.steps.length, 4); assert.ok(results.steps.every((step) => step.status === "succeeded"));
    assert.equal(results.steps.find((step) => step.node_id === conditionIds[0])?.output_snapshot?.selectedPort, "true");
    assert.deepEqual(results.event, { status: "completed", attempts: 1 }); assert.equal(results.runs.length, 2);

    const tenantBView = await withTenant(runtimePool, tenantIds[1]!, async (client) => (await client.query("SELECT id FROM public.automation_runs WHERE tenant_id=$1::uuid", [tenantIds[0]])).rowCount);
    assert.equal(tenantBView, 0);
    await assert.rejects(withTenant(runtimePool, tenantIds[1]!, async (client) => client.query("SELECT * FROM public.claim_automation_events($1::uuid,1,120)", [tenantIds[0]])), { code: "42501" });
  } finally {
    await Promise.all(workers.map((worker) => worker.stop()));
    await fixture.query("DELETE FROM public.tenants WHERE dealer_id=ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    if (userIds.length) await fixture.query("DELETE FROM public.app_users WHERE id=ANY($1::uuid[])", [userIds]).catch(() => undefined);
    fixture.release(); await runtimePool.end(); await fixturePool.end();
  }
});

async function withTenant<T>(pool: Pool, tenantId: string, action: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]); const value = await action(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
