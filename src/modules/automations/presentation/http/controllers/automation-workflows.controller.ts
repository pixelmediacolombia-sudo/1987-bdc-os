import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { dealerUser, isMember, withTenant, UUID } from "@/features/contacts/presentation/http/contacts.route-helpers";
import { AUTOMATION_WORKFLOW_SCHEMA_VERSION, validateAutomationWorkflowDefinition, type AutomationWorkflowDefinition } from "@/modules/automations/domain/automation-workflow";
import { automationRunStartNode } from "@/modules/automations/domain/automation-engine";

type WorkflowRow = {
  id: string; name: string; draft_definition: unknown; draft_revision: number;
  published_definition: unknown | null; published_revision: number | null;
  created_at: Date | string; updated_at: Date | string;
};
const COLUMNS = `id::text AS id, name, draft_definition, draft_revision, published_definition,
  published_revision, created_at, updated_at`;



function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function serialize(row: WorkflowRow) {
  return {
    id: row.id,
    name: row.name,
    draft: { revision: row.draft_revision, definition: row.draft_definition, updatedAt: new Date(row.updated_at).toISOString() },
    published: row.published_definition === null || row.published_revision === null ? null : {
      revision: row.published_revision, definition: row.published_definition, publishedAt: new Date(row.updated_at).toISOString(),
    },
  };
}

export class AutomationWorkflowsController {
  constructor(private readonly pool: Pool) {}

  async getAutomationWorkflows(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      if (!await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const workflows = await withTenant(this.pool, dealerId, async (client) => (await client.query(
        `SELECT id::text AS id, name, draft_revision AS "draftRevision", published_revision AS "publishedRevision", updated_at AS "updatedAt"
           FROM public.automation_workflows WHERE tenant_id=$1::uuid ORDER BY updated_at DESC,id DESC`, [dealerId],
      )).rows);
      response.json({ workflows });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar las automatizaciones." }); }
  }

  async createAutomationWorkflows(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const body = asRecord(request.body) ?? {};
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      if (!name || name.length > 120) { response.status(400).json({ error: "El nombre debe tener entre 1 y 120 caracteres." }); return; }
      const definition = { schemaVersion: AUTOMATION_WORKFLOW_SCHEMA_VERSION, name, nodes: [], edges: [] };
      const row = await withTenant(this.pool, dealerId, async (client) => (await client.query<WorkflowRow>(
        `INSERT INTO public.automation_workflows (tenant_id,name,draft_definition,created_by_user_id,updated_by_user_id)
         VALUES ($1::uuid,$2,$3::jsonb,$4::uuid,$4::uuid) RETURNING ${COLUMNS}`,
        [dealerId, name, JSON.stringify(definition), user.id],
      )).rows[0]);
      response.status(201).json({ workflow: serialize(row!), validationIssues: validateAutomationWorkflowDefinition(definition) });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos crear el borrador." }); }
  }

  async getAutomationWorkflowsByWorkflowId(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const workflowId = typeof request.params.workflowId === "string" ? request.params.workflowId : "";
      if (!UUID.test(workflowId) || !await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a esta automatización." }); return; }
      const row = await withTenant(this.pool, dealerId, async (client) => (await client.query<WorkflowRow>(
        `SELECT ${COLUMNS} FROM public.automation_workflows WHERE tenant_id=$1::uuid AND id=$2::uuid`, [dealerId, workflowId],
      )).rows[0]);
      if (!row) { response.status(404).json({ error: "No encontramos este workflow." }); return; }
      response.json({ workflow: serialize(row), validationIssues: validateAutomationWorkflowDefinition(row.draft_definition) });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar el workflow." }); }
  }

  async replaceAutomationWorkflowsByWorkflowIdDraft(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const body = asRecord(request.body) ?? {};
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const workflowId = typeof request.params.workflowId === "string" ? request.params.workflowId : "";
      const expectedRevision = body.expectedRevision;
      const definition = asRecord(body.definition);
      if (!UUID.test(workflowId) || !await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este workflow." }); return; }
      if (!Number.isInteger(expectedRevision) || Number(expectedRevision) < 1 || !definition) {
        response.status(400).json({ error: "El borrador y su revisión actual son obligatorios." }); return;
      }
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 120) { response.status(400).json({ error: "El nombre debe tener entre 1 y 120 caracteres." }); return; }
      const definitionWithName = { ...definition, name };
      const issues = validateAutomationWorkflowDefinition(definitionWithName);
      if (issues.some((issue) => issue.code === "unsupported_version" || issue.code === "invalid_definition")) {
        response.status(400).json({ error: "La versión del workflow no es compatible.", validationIssues: issues }); return;
      }
      const serialized = JSON.stringify(definitionWithName);
      if (serialized.length > 256_000) { response.status(413).json({ error: "El borrador excede el tamaño permitido." }); return; }
      const updated = await withTenant(this.pool, dealerId, async (client) => (await client.query<WorkflowRow>(
        `UPDATE public.automation_workflows SET name=$3,draft_definition=$4::jsonb,draft_revision=draft_revision+1,
            updated_by_user_id=$5::uuid,updated_at=now()
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND draft_revision=$6
          RETURNING ${COLUMNS}`,
        [dealerId, workflowId, name, serialized, user.id, expectedRevision],
      )).rows[0]);
      if (!updated) {
        const exists = await withTenant(this.pool, dealerId, async (client) => (await client.query(
          "SELECT 1 FROM public.automation_workflows WHERE tenant_id=$1::uuid AND id=$2::uuid", [dealerId, workflowId],
        )).rowCount === 1);
        response.status(exists ? 409 : 404).json({ error: exists ? "El borrador cambió en otra sesión. Recárgalo antes de guardar." : "No encontramos este workflow." }); return;
      }
      response.json({ workflow: serialize(updated), validationIssues: issues });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos guardar el borrador." }); }
  }

  async publishAutomationWorkflowsByWorkflowId(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const body = asRecord(request.body) ?? {};
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : "";
      const workflowId = typeof request.params.workflowId === "string" ? request.params.workflowId : "";
      const expectedRevision = body.expectedRevision;
      if (!UUID.test(workflowId) || !Number.isInteger(expectedRevision) || Number(expectedRevision) < 1 || !await isMember(this.pool, user.id, dealerId)) {
        response.status(403).json({ error: "No tienes acceso a este workflow o la revisión no es válida." }); return;
      }
      const result = await withTenant(this.pool, dealerId, async (client) => {
        const current = await client.query<WorkflowRow>(
          `SELECT ${COLUMNS} FROM public.automation_workflows WHERE tenant_id=$1::uuid AND id=$2::uuid FOR UPDATE`, [dealerId, workflowId],
        );
        const row = current.rows[0];
        if (!row) return { kind: "missing" as const };
        if (row.draft_revision !== Number(expectedRevision)) return { kind: "conflict" as const };
        const issues = validateAutomationWorkflowDefinition(row.draft_definition);
        if (issues.length) return { kind: "invalid" as const, issues };
        const definition = asRecord(row.draft_definition);
        const nodes = definition && Array.isArray(definition.nodes) ? definition.nodes.map(asRecord) : [];
        const effects = nodes.filter((node) => node && !["trigger.event", "condition.if", "flow.wait", "flow.end"].includes(String(node.type)));
        if (!effects.some((node) => node?.type === "opportunity.update_stage") || effects.some((node) => node?.type !== "opportunity.update_stage")) {
          return { kind: "unsupported" as const };
        }
        const published = await client.query<WorkflowRow>(
          `UPDATE public.automation_workflows SET published_definition=draft_definition,published_revision=draft_revision,
                  updated_by_user_id=$3::uuid,updated_at=now()
            WHERE tenant_id=$1::uuid AND id=$2::uuid AND draft_revision=$4 RETURNING ${COLUMNS}`,
          [dealerId, workflowId, user.id, expectedRevision],
        );
        return { kind: "published" as const, row: published.rows[0]! };
      });
      if (result.kind === "missing") { response.status(404).json({ error: "No encontramos este workflow." }); return; }
      if (result.kind === "conflict") { response.status(409).json({ error: "El borrador cambió. Recárgalo antes de publicar." }); return; }
      if (result.kind === "invalid") { response.status(400).json({ error: "Corrige los errores del workflow antes de publicar.", validationIssues: result.issues }); return; }
      if (result.kind === "unsupported") { response.status(400).json({ error: "Solo se pueden publicar workflows con acciones de etapa de oportunidad ya implementadas." }); return; }
      response.json({ workflow: serialize(result.row), validationIssues: [] });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos publicar el workflow." }); }
  }

  async getAutomationWorkflowsByWorkflowIdRuns(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const workflowId = typeof request.params.workflowId === "string" ? request.params.workflowId : "";
      if (!UUID.test(workflowId) || !await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a estas ejecuciones." }); return; }
      const parsedLimit = Number(request.query.limit ?? 50);
      const limit = Number.isInteger(parsedLimit) ? Math.max(1, Math.min(parsedLimit, 100)) : 50;
      const runs = await withTenant(this.pool, dealerId, async (client) => (await client.query(
        `SELECT r.id::text AS id,r.status,r.generation,r.event_type AS "eventType",r.workflow_revision AS "workflowRevision",
                r.current_node_id::text AS "currentNodeId",r.attempts,r.available_at AS "availableAt",r.last_error AS "lastError",
                r.created_at AS "createdAt",r.started_at AS "startedAt",r.finished_at AS "finishedAt",
                COALESCE(jsonb_agg(jsonb_build_object('nodeId',s.node_id,'nodeType',s.node_type,'status',s.status,'attempts',s.attempts,
                  'output',s.output_snapshot,'error',s.error_message,'startedAt',s.started_at,'finishedAt',s.finished_at)
                  ORDER BY s.started_at,s.id) FILTER (WHERE s.id IS NOT NULL),'[]'::jsonb) AS steps
           FROM public.automation_runs r LEFT JOIN public.automation_run_steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.id
          WHERE r.tenant_id=$1::uuid AND r.workflow_id=$2::uuid GROUP BY r.id ORDER BY r.created_at DESC,r.id DESC LIMIT $3`,
        [dealerId, workflowId, limit],
      )).rows);
      response.json({ runs });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar las ejecuciones." }); }
  }

  async createAutomationRunsByRunIdCancel(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const body = asRecord(request.body) ?? {};
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : "";
      const runId = typeof request.params.runId === "string" ? request.params.runId : "";
      if (!UUID.test(runId) || !await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a esta ejecución." }); return; }
      const run = await withTenant(this.pool, dealerId, async (client) => {
        const changed = await client.query(
          `UPDATE public.automation_runs SET status='cancelled',lock_token=NULL,locked_at=NULL,last_error=NULL,finished_at=now(),updated_at=now()
            WHERE tenant_id=$1::uuid AND id=$2::uuid AND status IN ('queued','running','waiting') RETURNING id::text AS id,status`, [dealerId, runId],
        );
        if (changed.rowCount) {
          await client.query("UPDATE public.automation_run_steps SET status='cancelled',finished_at=now() WHERE tenant_id=$1::uuid AND run_id=$2::uuid AND status='running'", [dealerId, runId]);
          return changed.rows[0];
        }
        return (await client.query("SELECT id::text AS id,status FROM public.automation_runs WHERE tenant_id=$1::uuid AND id=$2::uuid", [dealerId, runId])).rows[0];
      });
      if (!run) { response.status(404).json({ error: "No encontramos esta ejecución." }); return; }
      if (run.status !== "cancelled") { response.status(409).json({ error: "Solo se pueden cancelar ejecuciones en cola, espera o procesamiento.", status: run.status }); return; }
      response.json({ run });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cancelar la ejecución." }); }
  }

  async createAutomationRunsByRunIdRetry(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const body = asRecord(request.body) ?? {};
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : "";
      const runId = typeof request.params.runId === "string" ? request.params.runId : "";
      if (!UUID.test(runId) || !await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a esta ejecución." }); return; }
      const run = await withTenant(this.pool, dealerId, async (client) => (await client.query(
        `UPDATE public.automation_runs SET status='queued',attempts=0,available_at=now(),lock_token=NULL,locked_at=NULL,last_error=NULL,
             finished_at=NULL,updated_at=now() WHERE tenant_id=$1::uuid AND id=$2::uuid AND status IN ('failed','dead_letter')
          RETURNING id::text AS id,status,generation`, [dealerId, runId],
      )).rows[0] ?? (await client.query("SELECT id::text AS id,status,generation FROM public.automation_runs WHERE tenant_id=$1::uuid AND id=$2::uuid", [dealerId, runId])).rows[0]);
      if (!run) { response.status(404).json({ error: "No encontramos esta ejecución." }); return; }
      if (run.status !== "queued") { response.status(409).json({ error: "Solo se pueden reintentar ejecuciones fallidas o en dead-letter.", status: run.status }); return; }
      response.json({ run });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos reintentar la ejecución." }); }
  }

  async createAutomationRunsByRunIdReplay(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const body = asRecord(request.body) ?? {};
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : "";
      const runId = typeof request.params.runId === "string" ? request.params.runId : "";
      const requestKey = typeof body.requestKey === "string" ? body.requestKey : "";
      if (!UUID.test(runId) || !UUID.test(requestKey) || !await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "La ejecución, clave de replay o dealer no son válidos." }); return; }
      const replay = await withTenant(this.pool, dealerId, async (client) => {
        const source = (await client.query<WorkflowRow & { tenant_id: string; workflow_id: string; event_id: string; generation: number; workflow_revision: number; event_type: string; event_snapshot: unknown; workflow_snapshot: unknown }>(
          `SELECT r.*,w.name FROM public.automation_runs r JOIN public.automation_workflows w ON w.tenant_id=r.tenant_id AND w.id=r.workflow_id
            WHERE r.tenant_id=$1::uuid AND r.id=$2::uuid FOR UPDATE OF r`, [dealerId, runId],
        )).rows[0];
        if (!source) return undefined;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`${dealerId}:${source.workflow_id}:${source.event_id}`]);
        const nodeId = automationRunStartNode(source.workflow_snapshot as AutomationWorkflowDefinition, source.event_type);
        if (!nodeId) throw new Error("La ejecución de origen no tiene un trigger compatible para replay.");
        const inserted = (await client.query(
          `INSERT INTO public.automation_runs (tenant_id,workflow_id,event_id,generation,workflow_revision,event_type,event_snapshot,workflow_snapshot,current_node_id,replay_of_run_id,replay_request_key)
           SELECT $1::uuid,$2::uuid,$3::uuid,COALESCE(MAX(generation),0)+1,$4,$5,$6::jsonb,$7::jsonb,$8::uuid,$9::uuid,$10::uuid
             FROM public.automation_runs WHERE tenant_id=$1::uuid AND workflow_id=$2::uuid AND event_id=$3::uuid
           ON CONFLICT (tenant_id,replay_request_key) WHERE replay_request_key IS NOT NULL DO NOTHING
           RETURNING id::text AS id,status,generation`,
          [dealerId, source.workflow_id, source.event_id, source.workflow_revision, source.event_type, JSON.stringify(source.event_snapshot), JSON.stringify(source.workflow_snapshot), nodeId, runId, requestKey],
        )).rows[0];
        if (inserted) return inserted;
        return (await client.query("SELECT id::text AS id,status,generation FROM public.automation_runs WHERE tenant_id=$1::uuid AND replay_request_key=$2::uuid", [dealerId, requestKey])).rows[0];
      });
      if (!replay) { response.status(404).json({ error: "No encontramos la ejecución de origen." }); return; }
      response.status(201).json({ run: replay });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos reproducir la ejecución." }); }
  }
}
