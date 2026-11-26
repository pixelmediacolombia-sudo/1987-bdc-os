import type { Pool, PoolClient } from "pg";
import { calculateAutomationBackoff, evaluateAutomationCondition, findAutomationNextNode, findAutomationNode, automationRunStartNode } from "@/modules/automations/domain/automation-engine";
import { parseAutomationEvent, type AutomationEvent } from "@/modules/automations/domain/automation-event";
import { validateAutomationWorkflowDefinition, type AutomationWorkflowDefinition, type AutomationWorkflowNode } from "@/modules/automations/domain/automation-workflow";

type EventRow = {
  id: string; tenant_id: string; schema_version: number; event_type: string; occurred_at: Date | string; origin: string;
  actor_type: string; actor_id: string | null; entity_type: string; entity_id: string; payload: unknown;
  attempts: number; lock_token: string;
};
type WorkflowRow = { id: string; published_definition: unknown; published_revision: number };
type RunRow = {
  id: string; tenant_id: string; workflow_id: string; workflow_revision: number; event_type: string;
  event_snapshot: unknown; workflow_snapshot: unknown; current_node_id: string | null; attempts: number; lock_token: string;
};

const BATCH_SIZE = 25;
const LEASE_SECONDS = 120;
const MAX_ATTEMPTS = 5;

export class AutomationEngineWorker {
  private timer: NodeJS.Timeout | undefined;
  private activePoll: Promise<void> | undefined;
  private stopped = true;

  constructor(private readonly pool: Pool, private readonly pollMs = 1000) {}

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    void this.runOnce().catch((error) => console.error("[Automations] worker poll failed", safeError(error)));
    this.timer = setInterval(() => { void this.runOnce().catch((error) => console.error("[Automations] worker poll failed", safeError(error))); }, this.pollMs);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.activePoll?.catch(() => undefined);
  }

  async runOnce(): Promise<void> {
    if (this.activePoll || this.stopped) return this.activePoll;
    this.activePoll = this.pollTenantQueues();
    try { await this.activePoll; } finally { this.activePoll = undefined; }
  }

  private async pollTenantQueues(): Promise<void> {
    const tenants = await this.pool.query<{ tenant_id: string }>("SELECT tenant_id::text AS tenant_id FROM public.list_automation_tenant_ids() AS tenants(tenant_id)");
    for (const { tenant_id: tenantId } of tenants.rows) {
      if (this.stopped) return;
      const claimedEvents = await this.withTenant(tenantId, async (client) => (await client.query<EventRow>(
        "SELECT * FROM public.claim_automation_events($1::uuid,$2::integer,$3::integer)", [tenantId, BATCH_SIZE, LEASE_SECONDS],
      )).rows);
      for (const event of claimedEvents) await this.dispatchEvent(event);

      const claimedRuns = await this.withTenant(tenantId, async (client) => (await client.query<RunRow>(
        "SELECT * FROM public.claim_automation_runs($1::uuid,$2::integer,$3::integer)", [tenantId, BATCH_SIZE, LEASE_SECONDS],
      )).rows);
      for (const run of claimedRuns) await this.executeRun(run);
    }
  }

  private async dispatchEvent(row: EventRow): Promise<void> {
    try {
      const event = parseAutomationEvent({
        schemaVersion: row.schema_version, eventId: row.id, tenantId: row.tenant_id,
        type: row.event_type, occurredAt: new Date(row.occurred_at).toISOString(), origin: row.origin,
        actor: { type: row.actor_type, ...(row.actor_id ? { id: row.actor_id } : {}) },
        entity: { type: row.entity_type, id: row.entity_id }, payload: row.payload,
      });
      await this.withTenant(row.tenant_id, async (client) => {
        const workflows = await client.query<WorkflowRow>(
          `SELECT id::text AS id,published_definition,published_revision FROM public.automation_workflows
            WHERE tenant_id=$1::uuid AND published_definition IS NOT NULL AND published_revision IS NOT NULL`, [row.tenant_id],
        );
        for (const workflow of workflows.rows) {
          const definition = workflowDefinition(workflow.published_definition);
          const issues = validateAutomationWorkflowDefinition(definition);
          if (issues.length) throw new Error("La versión publicada no pasa la validación del motor.");
          const startNodeId = automationRunStartNode(definition, event.type);
          if (!startNodeId) continue;
          await client.query(
            `INSERT INTO public.automation_runs (tenant_id,workflow_id,event_id,workflow_revision,event_type,event_snapshot,workflow_snapshot,current_node_id)
             VALUES ($1::uuid,$2::uuid,$3::uuid,$4,$5,$6::jsonb,$7::jsonb,$8::uuid)
             ON CONFLICT (tenant_id,workflow_id,event_id,generation) DO NOTHING`,
            [row.tenant_id, workflow.id, row.id, workflow.published_revision, event.type, JSON.stringify(event), JSON.stringify(definition), startNodeId],
          );
        }
        const completed = await client.query(
          `UPDATE public.automation_event_outbox SET status='completed',dispatched_at=now(),locked_at=NULL,lock_token=NULL,last_error=NULL
            WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='processing' AND lock_token=$3::uuid`,
          [row.tenant_id, row.id, row.lock_token],
        );
        if (completed.rowCount !== 1) throw new Error("Se perdió el lease del evento.");
      });
    } catch (error) {
      await this.failEvent(row, safeError(error));
    }
  }

  private async failEvent(row: EventRow, message: string): Promise<void> {
    const terminal = row.attempts >= MAX_ATTEMPTS;
    const delaySeconds = calculateAutomationBackoff(row.attempts);
    await this.withTenant(row.tenant_id, async (client) => {
      await client.query(
        `UPDATE public.automation_event_outbox SET status=$4,
           available_at=CASE WHEN $4='failed' THEN available_at ELSE now()+make_interval(secs=>$5) END,
           lock_token=NULL,locked_at=NULL,dispatched_at=CASE WHEN $4='failed' THEN now() ELSE dispatched_at END,last_error=$6
         WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='processing' AND lock_token=$3::uuid`,
        [row.tenant_id, row.id, row.lock_token, terminal ? "failed" : "pending", delaySeconds, message],
      );
    });
  }

  private async executeRun(claim: RunRow): Promise<void> {
    try {
      await this.withTenant(claim.tenant_id, async (client) => {
        const locked = await client.query<RunRow>(
          `SELECT id::text AS id,tenant_id::text AS tenant_id,workflow_id::text AS workflow_id,workflow_revision,event_type,
                  event_snapshot,workflow_snapshot,current_node_id::text AS current_node_id,attempts,lock_token::text AS lock_token
             FROM public.automation_runs WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='running' AND lock_token=$3::uuid FOR UPDATE`,
          [claim.tenant_id, claim.id, claim.lock_token],
        );
        const run = locked.rows[0];
        if (!run) return;
        if (!run.current_node_id) throw new Error("La ejecución no tiene un nodo actual.");
        const event = parseAutomationEvent(run.event_snapshot);
        const definition = workflowDefinition(run.workflow_snapshot);
        const issues = validateAutomationWorkflowDefinition(definition);
        if (issues.length) throw new Error("La definición guardada de esta ejecución no es válida.");
        const node = findAutomationNode(definition, run.current_node_id);
        const result = executeControlNode(event, definition, node);
        const stepInput = { eventId: event.eventId, eventType: event.type, nodeId: node.id };
        await client.query(
          `INSERT INTO public.automation_run_steps (tenant_id,run_id,node_id,node_type,status,attempts,input_snapshot,output_snapshot,started_at,finished_at)
           VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'succeeded',1,$5::jsonb,$6::jsonb,now(),now())
           ON CONFLICT (tenant_id,run_id,node_id) DO UPDATE SET node_type=EXCLUDED.node_type,status='succeeded',
             attempts=automation_run_steps.attempts+1,input_snapshot=EXCLUDED.input_snapshot,output_snapshot=EXCLUDED.output_snapshot,
             error_message=NULL,started_at=now(),finished_at=now()`,
          [run.tenant_id, run.id, node.id, node.type, JSON.stringify(stepInput), JSON.stringify(result.output)],
        );
        if (result.finished) {
          await client.query(
            `UPDATE public.automation_runs SET status='succeeded',current_node_id=NULL,attempts=0,lock_token=NULL,locked_at=NULL,
                    last_error=NULL,finished_at=now(),updated_at=now()
              WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='running' AND lock_token=$3::uuid`,
            [run.tenant_id, run.id, run.lock_token],
          );
        } else {
          await client.query(
            `UPDATE public.automation_runs SET status=CASE WHEN $5::integer IS NULL THEN 'queued' ELSE 'waiting' END,
                    current_node_id=$4::uuid,attempts=0,
                    available_at=CASE WHEN $5::integer IS NULL THEN now() ELSE now()+make_interval(secs=>$5) END,
                    lock_token=NULL,locked_at=NULL,last_error=NULL,updated_at=now()
              WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='running' AND lock_token=$3::uuid`,
            [run.tenant_id, run.id, run.lock_token, result.nextNodeId, result.waitSeconds ?? null],
          );
        }
      });
    } catch (error) {
      await this.failRun(claim, safeError(error));
    }
  }

  private async failRun(run: RunRow, message: string): Promise<void> {
    await this.withTenant(run.tenant_id, async (client) => {
      const attempts = run.attempts + 1;
      const terminal = attempts >= MAX_ATTEMPTS;
      if (run.current_node_id) {
        await client.query(
          `INSERT INTO public.automation_run_steps (tenant_id,run_id,node_id,node_type,status,attempts,input_snapshot,error_message,started_at,finished_at)
           VALUES ($1::uuid,$2::uuid,$3::uuid,'unknown','failed',1,'{}'::jsonb,$4,now(),now())
           ON CONFLICT (tenant_id,run_id,node_id) DO UPDATE SET status='failed',attempts=automation_run_steps.attempts+1,
             error_message=EXCLUDED.error_message,started_at=now(),finished_at=now()`,
          [run.tenant_id, run.id, run.current_node_id, message],
        );
      }
      await client.query(
        `UPDATE public.automation_runs SET status=$4,attempts=$5,available_at=CASE WHEN $4='dead_letter' THEN available_at ELSE now()+make_interval(secs=>$6) END,
                lock_token=NULL,locked_at=NULL,last_error=$7,finished_at=CASE WHEN $4='dead_letter' THEN now() ELSE NULL END,updated_at=now()
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND status='running' AND lock_token=$3::uuid`,
        [run.tenant_id, run.id, run.lock_token, terminal ? "dead_letter" : "queued", attempts, calculateAutomationBackoff(attempts), message],
      );
    });
  }

  private async withTenant<T>(tenantId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

function workflowDefinition(value: unknown): AutomationWorkflowDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("La definición del workflow no es un objeto.");
  return value as AutomationWorkflowDefinition;
}

function executeControlNode(event: AutomationEvent, definition: AutomationWorkflowDefinition, node: AutomationWorkflowNode): { nextNodeId?: string; finished: boolean; waitSeconds?: number; output: Record<string, unknown> } {
  if (node.type === "trigger.event") {
    if (node.config.eventType !== event.type) throw new Error("El trigger no coincide con el evento de entrada.");
    return { nextNodeId: findAutomationNextNode(definition, node.id, "next"), finished: false, output: { acceptedEventId: event.eventId } };
  }
  if (node.type === "condition.if") {
    const condition = evaluateAutomationCondition(event, node);
    const port = condition.matched ? "true" : "false";
    return { nextNodeId: findAutomationNextNode(definition, node.id, port), finished: false, output: { matched: condition.matched, value: condition.value, selectedPort: port } };
  }
  if (node.type === "flow.wait") return { nextNodeId: findAutomationNextNode(definition, node.id, "next"), finished: false, waitSeconds: node.config.durationSeconds, output: { waitSeconds: node.config.durationSeconds } };
  return { finished: true, output: { outcome: node.config.outcome } };
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Error interno de ejecución.";
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 240);
}
