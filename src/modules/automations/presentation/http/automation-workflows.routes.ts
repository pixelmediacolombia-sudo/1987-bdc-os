import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { dealerUser, isMember, withTenant, UUID } from "@/features/contacts/presentation/http/contacts.route-helpers";
import { AUTOMATION_WORKFLOW_SCHEMA_VERSION, validateAutomationWorkflowDefinition } from "@/modules/automations/domain/automation-workflow";

type WorkflowRow = {
  id: string; name: string; draft_definition: unknown; draft_revision: number;
  published_definition: unknown | null; published_revision: number | null;
  created_at: Date | string; updated_at: Date | string;
};
const COLUMNS = `id::text AS id, name, draft_definition, draft_revision, published_definition,
  published_revision, created_at, updated_at`;

export function createAutomationWorkflowsRouter(pool: Pool): express.Router {
  const router = express.Router();
  router.get("/automation/workflows", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const workflows = await withTenant(pool, dealerId, async (client) => (await client.query(
        `SELECT id::text AS id, name, draft_revision AS "draftRevision", published_revision AS "publishedRevision", updated_at AS "updatedAt"
           FROM public.automation_workflows WHERE tenant_id=$1::uuid ORDER BY updated_at DESC,id DESC`, [dealerId],
      )).rows);
      response.json({ workflows });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar las automatizaciones." }); }
  });

  router.post("/automation/workflows", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response); if (!user) return;
      const body = asRecord(request.body) ?? {};
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      if (!name || name.length > 120) { response.status(400).json({ error: "El nombre debe tener entre 1 y 120 caracteres." }); return; }
      const definition = { schemaVersion: AUTOMATION_WORKFLOW_SCHEMA_VERSION, name, nodes: [], edges: [] };
      const row = await withTenant(pool, dealerId, async (client) => (await client.query<WorkflowRow>(
        `INSERT INTO public.automation_workflows (tenant_id,name,draft_definition,created_by_user_id,updated_by_user_id)
         VALUES ($1::uuid,$2,$3::jsonb,$4::uuid,$4::uuid) RETURNING ${COLUMNS}`,
        [dealerId, name, JSON.stringify(definition), user.id],
      )).rows[0]);
      response.status(201).json({ workflow: serialize(row!), validationIssues: validateAutomationWorkflowDefinition(definition) });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos crear el borrador." }); }
  });

  router.get("/automation/workflows/:workflowId", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const workflowId = typeof request.params.workflowId === "string" ? request.params.workflowId : "";
      if (!UUID.test(workflowId) || !await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a esta automatización." }); return; }
      const row = await withTenant(pool, dealerId, async (client) => (await client.query<WorkflowRow>(
        `SELECT ${COLUMNS} FROM public.automation_workflows WHERE tenant_id=$1::uuid AND id=$2::uuid`, [dealerId, workflowId],
      )).rows[0]);
      if (!row) { response.status(404).json({ error: "No encontramos este workflow." }); return; }
      response.json({ workflow: serialize(row), validationIssues: validateAutomationWorkflowDefinition(row.draft_definition) });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar el workflow." }); }
  });

  router.put("/automation/workflows/:workflowId/draft", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response); if (!user) return;
      const body = asRecord(request.body) ?? {};
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const workflowId = typeof request.params.workflowId === "string" ? request.params.workflowId : "";
      const expectedRevision = body.expectedRevision;
      const definition = asRecord(body.definition);
      if (!UUID.test(workflowId) || !await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este workflow." }); return; }
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
      const updated = await withTenant(pool, dealerId, async (client) => (await client.query<WorkflowRow>(
        `UPDATE public.automation_workflows SET name=$3,draft_definition=$4::jsonb,draft_revision=draft_revision+1,
            updated_by_user_id=$5::uuid,updated_at=now()
          WHERE tenant_id=$1::uuid AND id=$2::uuid AND draft_revision=$6
          RETURNING ${COLUMNS}`,
        [dealerId, workflowId, name, serialized, user.id, expectedRevision],
      )).rows[0]);
      if (!updated) {
        const exists = await withTenant(pool, dealerId, async (client) => (await client.query(
          "SELECT 1 FROM public.automation_workflows WHERE tenant_id=$1::uuid AND id=$2::uuid", [dealerId, workflowId],
        )).rowCount === 1);
        response.status(exists ? 409 : 404).json({ error: exists ? "El borrador cambió en otra sesión. Recárgalo antes de guardar." : "No encontramos este workflow." }); return;
      }
      response.json({ workflow: serialize(updated), validationIssues: issues });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos guardar el borrador." }); }
  });
  return router;
}

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
