import express, { type Request, type Response } from "express";
import type { Pool, PoolClient } from "pg";
import { activeSession, appendAudit, auditReference, type IdentityUser } from "@/features/identity/presentation/http/routes/route-helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STAGES = ["new", "working", "closing", "won", "lost"] as const;
type Stage = typeof STAGES[number];
type Opportunity = { id: string; dealerId: string; title: string; contactId: string | null; contactName: string; contactPhone: string | null; amountCents: string; stage: Stage; assignedUserId: string | null; assignedUserName: string | null; expectedCloseDate: string | null; notes: string | null; createdAt: Date; updatedAt: Date };

async function withTenant<T>(pool: Pool, tenantId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]); const value = await action(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
async function withUser<T>(pool: Pool, userId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query("BEGIN"); await client.query("SELECT set_config('app.user_id', $1, true)", [userId]); const value = await action(client); await client.query("COMMIT"); return value; }
  catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
async function dealerUser(pool: Pool, request: Request, response: Response): Promise<IdentityUser | undefined> {
  const user = await activeSession(pool, request);
  if (!user) { response.status(401).json({ error: "Inicia sesión para continuar." }); return; }
  if (user.account_type !== "user") { response.status(403).json({ error: "Esta sección requiere una cuenta de dealer." }); return; }
  return user;
}
async function isMember(pool: Pool, userId: string, dealerId: string): Promise<boolean> {
  if (!UUID.test(dealerId)) return false;
  const member = await withUser(pool, userId, async (client) => (await client.query("SELECT 1 FROM public.user_tenant_memberships WHERE user_id = $1 AND tenant_id = $2::uuid", [userId, dealerId])).rowCount === 1);
  return member && withTenant(pool, dealerId, async (client) => (await client.query("SELECT 1 FROM public.tenants WHERE dealer_id = $1::uuid AND status = 'active'", [dealerId])).rowCount === 1);
}
function parseStage(value: unknown): Stage | undefined { return typeof value === "string" && (STAGES as readonly string[]).includes(value) ? value as Stage : undefined; }
const COLUMNS = `o.id::text AS id, o.tenant_id::text AS "dealerId", o.title, o.contact_id::text AS "contactId", o.contact_name AS "contactName", o.contact_phone AS "contactPhone", o.amount_cents::text AS "amountCents", o.stage, o.assigned_user_id::text AS "assignedUserId", u.display_name AS "assignedUserName", o.expected_close_date::text AS "expectedCloseDate", o.notes, o.created_at AS "createdAt", o.updated_at AS "updatedAt"`;

export function createOpportunitiesRouter(pool: Pool): express.Router {
  const router = express.Router();
  router.get("/dashboard", async (request, response) => {
    try {
      const user = await dealerUser(pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const dashboard = await withTenant(pool, dealerId, async (client) => {
        const counts = await client.query(`SELECT (SELECT COUNT(*)::int FROM public.conversations WHERE tenant_id=$1::uuid AND read_at IS NULL) AS "unreadConversations", (SELECT COUNT(*)::int FROM public.contacts WHERE tenant_id=$1::uuid AND created_at >= date_trunc('month', now())) AS "newContacts", (SELECT COUNT(*)::int FROM public.opportunities WHERE tenant_id=$1::uuid AND stage IN ('new','working','closing')) AS "activeOpportunities", (SELECT COALESCE(SUM(amount_cents),0)::text FROM public.opportunities WHERE tenant_id=$1::uuid AND stage IN ('new','working','closing')) AS "pipelineValueCents"`, [dealerId]);
        const attention = await client.query(`SELECT cv.id::text AS id, c.id::text AS "contactId", COALESCE(NULLIF(c.display_name,''), c.phone, c.email, 'Contacto sin nombre') AS name, cv.channel, cv.last_activity AS "lastActivity", (SELECT m.content FROM public.messages m WHERE m.conversation_id=cv.id AND m.tenant_id=cv.tenant_id ORDER BY m.created_at DESC LIMIT 1) AS summary FROM public.conversations cv JOIN public.contacts c ON c.id=cv.contact_id AND c.tenant_id=cv.tenant_id WHERE cv.tenant_id=$1::uuid AND cv.read_at IS NULL ORDER BY cv.last_activity ASC LIMIT 8`, [dealerId]);
        const activities = await client.query(`SELECT id::text AS id, category, action, summary, created_at AS "createdAt" FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND category IN ('contacts','opportunities') ORDER BY created_at DESC LIMIT 5`, [dealerId]);
        return { metrics: counts.rows[0], attention: attention.rows, activities: activities.rows };
      });
      response.json(dashboard);
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar el inicio del dealer." }); }
  });
  router.get("/opportunities", async (request, response) => {
    try {
      const user = await dealerUser(pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const rows = await withTenant(pool, dealerId, (client) => client.query<Opportunity>(`SELECT ${COLUMNS} FROM public.opportunities o LEFT JOIN public.app_users u ON u.id=o.assigned_user_id WHERE o.tenant_id=$1::uuid ORDER BY o.updated_at DESC`, [dealerId]));
      response.json({ opportunities: rows.rows });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar las oportunidades." }); }
  });
  router.post("/opportunities", async (request, response) => {
    try {
      const user = await dealerUser(pool, request, response); if (!user) return;
      const body = request.body as Record<string, unknown>;
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const contactName = typeof body.contactName === "string" ? body.contactName.trim() : "";
      const amountCents = Number(body.amountCents ?? 0);
      const stage = parseStage(body.stage ?? "new");
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      if (title.length < 2 || title.length > 120 || !contactName || contactName.length > 120 || !Number.isSafeInteger(amountCents) || amountCents < 0 || !stage) { response.status(400).json({ error: "Revisa los datos de la oportunidad." }); return; }
      const contactId = typeof body.contactId === "string" ? body.contactId : null;
      const assignedUserId = typeof body.assignedUserId === "string" ? body.assignedUserId : user.id;
      const scopeValid = await withTenant(pool, dealerId, async (client) => {
        const contactValid = !contactId || (await client.query("SELECT 1 FROM public.contacts WHERE id=$1::uuid AND tenant_id=$2::uuid", [contactId, dealerId])).rowCount === 1;
        const assigneeValid = (await client.query("SELECT 1 FROM public.user_tenant_memberships WHERE user_id=$1::uuid AND tenant_id=$2::uuid", [assignedUserId, dealerId])).rowCount === 1;
        return contactValid && assigneeValid;
      });
      if (!scopeValid) { response.status(400).json({ error: "El contacto y el responsable deben pertenecer al dealer actual." }); return; }
      const saved = await withTenant(pool, dealerId, async (client) => {
        const inserted = await client.query<{ id: string }>(`INSERT INTO public.opportunities (tenant_id,title,contact_id,contact_name,contact_phone,amount_cents,stage,assigned_user_id,expected_close_date,notes,created_by_user_id) VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8::uuid,$9::date,$10,$11::uuid) RETURNING id::text AS id`, [dealerId,title,contactId,contactName,typeof body.contactPhone === "string" ? body.contactPhone : null,amountCents,stage,assignedUserId,typeof body.expectedCloseDate === "string" ? body.expectedCloseDate : null,typeof body.notes === "string" ? body.notes.trim().slice(0,2000) : null,user.id]);
        const result = await client.query<Opportunity>(`SELECT ${COLUMNS} FROM public.opportunities o LEFT JOIN public.app_users u ON u.id=o.assigned_user_id WHERE o.id=$1::uuid AND o.tenant_id=$2::uuid`,[inserted.rows[0].id,dealerId]);
        const tenant = await client.query<{ dealer_name: string }>("SELECT dealer_name FROM public.tenants WHERE dealer_id=$1::uuid", [dealerId]);
        await appendAudit(client,{actor:user,dealerId,dealerName:tenant.rows[0]?.dealer_name,category:"opportunities",action:"opportunity.created",summary:`Se creó la oportunidad ${title}.`,referenceId:auditReference(request),entityId:result.rows[0].id});
        return result.rows[0];
      });
      response.status(201).json({ opportunity: saved });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos guardar la oportunidad." }); }
  });
  router.get("/opportunities/:opportunityId/activity", async (request, response) => {
    try {
      const user = await dealerUser(pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const id = typeof request.params.opportunityId === "string" ? request.params.opportunityId : "";
      if (!UUID.test(id) || !await isMember(pool,user.id,dealerId)) { response.status(403).json({ error: "No tienes acceso a esta oportunidad." }); return; }
      const activity = await withTenant(pool,dealerId,async (client) => {
        const exists = await client.query("SELECT 1 FROM public.opportunities WHERE id=$1::uuid AND tenant_id=$2::uuid",[id,dealerId]);
        if (!exists.rowCount) return undefined;
        const rows = await client.query(`SELECT id::text AS id, action, summary, actor_name AS "actorName", created_at AS "createdAt" FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND category='opportunities' AND entity_id=$2 ORDER BY created_at DESC LIMIT 20`,[dealerId,id]);
        return rows.rows;
      });
      if (!activity) { response.status(404).json({ error: "No encontramos esa oportunidad." }); return; }
      response.json({ activity });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar el historial de la oportunidad." }); }
  });  router.patch("/opportunities/:opportunityId", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response); if (!user) return;
      const body = request.body as Record<string, unknown>;
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const id = typeof request.params.opportunityId === "string" ? request.params.opportunityId : "";
      if (!UUID.test(id) || !await isMember(pool,user.id,dealerId)) { response.status(403).json({ error: "No tienes acceso a esta oportunidad." }); return; }
      const stage = body.stage === undefined ? undefined : parseStage(body.stage);
      const assignee = body.assignedUserId === undefined ? undefined : body.assignedUserId === null ? null : typeof body.assignedUserId === "string" && UUID.test(body.assignedUserId) ? body.assignedUserId : undefined;
      if ((body.stage !== undefined && !stage) || (body.assignedUserId !== undefined && assignee === undefined)) { response.status(400).json({ error: "El cambio solicitado no es válido." }); return; }
      if (typeof body.assignedUserId === "string") {
        const assigneeAllowed = await withTenant(pool,dealerId,async (client) => (await client.query("SELECT 1 FROM public.user_tenant_memberships WHERE user_id=$1::uuid AND tenant_id=$2::uuid",[assignee,dealerId])).rowCount === 1);
        if (!assigneeAllowed) { response.status(400).json({ error: "El responsable debe pertenecer al dealer actual." }); return; }
      }
      const saved = await withTenant(pool,dealerId,async (client) => {
        const current = await client.query<{ stage: Stage; title: string }>("SELECT stage,title FROM public.opportunities WHERE id=$1::uuid AND tenant_id=$2::uuid FOR UPDATE",[id,dealerId]);
        if (!current.rows[0]) return undefined;
        await client.query(`UPDATE public.opportunities SET stage=COALESCE($3,stage), assigned_user_id=CASE WHEN $4 THEN $5::uuid ELSE assigned_user_id END, updated_at=now() WHERE id=$1::uuid AND tenant_id=$2::uuid`,[id,dealerId,stage ?? null,body.assignedUserId !== undefined,assignee ?? null]);
        const updated = await client.query<Opportunity>(`SELECT ${COLUMNS} FROM public.opportunities o LEFT JOIN public.app_users u ON u.id=o.assigned_user_id WHERE o.id=$1::uuid AND o.tenant_id=$2::uuid`,[id,dealerId]);
        const action = stage && stage !== current.rows[0].stage ? "opportunity.stage_changed" : "opportunity.assigned";
        const tenant = await client.query<{ dealer_name: string }>("SELECT dealer_name FROM public.tenants WHERE dealer_id=$1::uuid",[dealerId]);
        await appendAudit(client,{actor:user,dealerId,dealerName:tenant.rows[0]?.dealer_name,category:"opportunities",action,summary:action === "opportunity.stage_changed" ? `La oportunidad ${current.rows[0].title} cambió a ${stage}.` : `Se actualizó la asignación de ${current.rows[0].title}.`,referenceId:auditReference(request),entityId:id});
        return updated.rows[0];
      });
      if (!saved) { response.status(404).json({ error: "No encontramos esa oportunidad." }); return; }
      response.json({ opportunity: saved });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos actualizar la oportunidad." }); }
  });
  return router;
}
