import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { activeSession, appendAudit, auditReference, type IdentityUser } from "@/features/identity/presentation/http/routes/route-helpers";
import { isTenantMember as isMember } from "@/features/identity/application/tenant-membership.service";
import { withTenant } from "@/features/identity/infrastructure/persistence/postgres/tenant-transaction";
import { DEFAULT_OPPORTUNITY_STAGES, parseOpportunityStage, type OpportunityStage } from "@/features/opportunities/application/opportunities.service";
import { ensureOpportunityStages } from "@/features/opportunities/infrastructure/persistence/postgres/opportunity-stages.repository";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Opportunity = { id: string; dealerId: string; title: string; contactId: string | null; contactName: string; contactPhone: string | null; amountCents: string; stage: OpportunityStage; assignedUserId: string | null; assignedUserName: string | null; expectedCloseDate: string | null; notes: string | null; nextAction: string | null; nextActionAt: string | null; archivedAt: Date | null; createdAt: Date; updatedAt: Date };

async function dealerUser(pool: Pool, request: Request, response: Response): Promise<IdentityUser | undefined> {
  const user = await activeSession(pool, request);
  if (!user) { response.status(401).json({ error: "Inicia sesión para continuar." }); return; }
  if (user.account_type !== "user") { response.status(403).json({ error: "Esta sección requiere una cuenta de dealer." }); return; }
  return user;
}
const COLUMNS = `o.id::text AS id, o.tenant_id::text AS "dealerId", o.title, o.contact_id::text AS "contactId", o.contact_name AS "contactName", o.contact_phone AS "contactPhone", o.amount_cents::text AS "amountCents", o.stage, o.assigned_user_id::text AS "assignedUserId", u.display_name AS "assignedUserName", o.expected_close_date::text AS "expectedCloseDate", o.notes, o.next_action AS "nextAction", o.next_action_at::text AS "nextActionAt", o.archived_at AS "archivedAt", o.created_at AS "createdAt", o.updated_at AS "updatedAt"`;



export class OpportunitiesController {
  constructor(private readonly pool: Pool) {}

  async getDashboard(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      if (!await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const dashboard = await withTenant(this.pool, dealerId, async (client) => {
        const counts = await client.query(`SELECT (SELECT COUNT(*)::int FROM public.conversations WHERE tenant_id=$1::uuid AND read_at IS NULL) AS "unreadConversations", (SELECT COUNT(*)::int FROM public.contacts WHERE tenant_id=$1::uuid AND created_at >= date_trunc('month', now())) AS "newContacts", (SELECT COUNT(*)::int FROM public.opportunities WHERE tenant_id=$1::uuid AND archived_at IS NULL AND stage IN ('new','working','closing')) AS "activeOpportunities", (SELECT COALESCE(SUM(amount_cents),0)::text FROM public.opportunities WHERE tenant_id=$1::uuid AND stage IN ('new','working','closing')) AS "pipelineValueCents"`, [dealerId]);
        const attention = await client.query(`SELECT cv.id::text AS id, c.id::text AS "contactId", COALESCE(NULLIF(c.display_name,''), c.phone, c.email, 'Contacto sin nombre') AS name, cv.channel, cv.last_activity AS "lastActivity", (SELECT m.content FROM public.messages m WHERE m.conversation_id=cv.id AND m.tenant_id=cv.tenant_id ORDER BY m.created_at DESC LIMIT 1) AS summary FROM public.conversations cv JOIN public.contacts c ON c.id=cv.contact_id AND c.tenant_id=cv.tenant_id WHERE cv.tenant_id=$1::uuid AND cv.read_at IS NULL ORDER BY cv.last_activity ASC LIMIT 8`, [dealerId]);
        const activities = await client.query(`SELECT id::text AS id, category, action, summary, created_at AS "createdAt" FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND category IN ('contacts','opportunities') ORDER BY created_at DESC LIMIT 5`, [dealerId]);
        return { metrics: counts.rows[0], attention: attention.rows, activities: activities.rows };
      });
      response.json(dashboard);
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar el inicio del dealer." }); }
  }

  async getOpportunitiesStages(request: Request, response: Response): Promise<void> { try { const user=await dealerUser(this.pool,request,response); if(!user)return; const dealerId=typeof request.query.dealerId==="string"?request.query.dealerId:""; if(!await isMember(this.pool,user.id,dealerId)){response.status(403).json({error:"No tienes acceso a este dealer."});return;} const stages=await withTenant(this.pool,dealerId,async client=>{await ensureOpportunityStages(client,dealerId);return (await client.query('SELECT stage_key AS "stageKey",label,position FROM public.opportunity_stages WHERE tenant_id=$1::uuid ORDER BY position',[dealerId])).rows;}); response.json({stages}); } catch { if(!response.headersSent)response.status(500).json({error:"No pudimos cargar las etapas."});} }

  async replaceOpportunitiesStages(request: Request, response: Response): Promise<void> { try { const user=await dealerUser(this.pool,request,response); if(!user)return; const dealerId=typeof request.query.dealerId==="string"?request.query.dealerId:""; const stages=(request.body as {stages?:unknown})?.stages; if(!await isMember(this.pool,user.id,dealerId)){response.status(403).json({error:"No tienes acceso a este dealer."});return;} const keys=DEFAULT_OPPORTUNITY_STAGES.map(x=>x.stageKey); const valid=Array.isArray(stages)&&stages.length===5&&stages.every(x=>x&&typeof x==="object"&&keys.includes((x as any).stageKey)&&typeof (x as any).label==="string"&&(x as any).label.trim().length>0&&(x as any).label.trim().length<=60&&Number.isInteger((x as any).position)&&(x as any).position>=0&&(x as any).position<5)&&new Set(stages.map(x=>(x as any).stageKey)).size===5&&new Set(stages.map(x=>(x as any).position)).size===5; if(!valid){response.status(400).json({error:"Configura las cinco etapas con nombres y posiciones únicas."});return;} const saved=await withTenant(this.pool,dealerId,async client=>{await ensureOpportunityStages(client,dealerId); await client.query("DELETE FROM public.opportunity_stages WHERE tenant_id=$1::uuid",[dealerId]); for(const x of stages as Array<{stageKey:string;label:string;position:number}>) await client.query('INSERT INTO public.opportunity_stages (tenant_id,stage_key,label,position) VALUES ($1::uuid,$2,$3,$4)',[dealerId,x.stageKey,x.label.trim(),x.position]); const tenant=await client.query<{dealer_name:string}>('SELECT dealer_name FROM public.tenants WHERE dealer_id=$1::uuid',[dealerId]); await appendAudit(client,{actor:user,dealerId,dealerName:tenant.rows[0]?.dealer_name,category:"opportunities",action:"opportunity.stages_configured",summary:"Se actualizaron las etapas del pipeline.",referenceId:auditReference(request)}); return (await client.query('SELECT stage_key AS "stageKey",label,position FROM public.opportunity_stages WHERE tenant_id=$1::uuid ORDER BY position',[dealerId])).rows;}); response.json({stages:saved}); } catch { if(!response.headersSent)response.status(500).json({error:"No pudimos guardar las etapas."});} }

  async getOpportunities(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      if (!await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const rows = await withTenant(this.pool, dealerId, async (client) => { await ensureOpportunityStages(client,dealerId); return client.query<Opportunity>(`SELECT ${COLUMNS} FROM public.opportunities o LEFT JOIN public.app_users u ON u.id=o.assigned_user_id WHERE o.tenant_id=$1::uuid AND ($2::boolean OR o.archived_at IS NULL) ORDER BY o.updated_at DESC`, [dealerId,request.query.includeArchived==="true"]); });
      response.json({ opportunities: rows.rows });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar las oportunidades." }); }
  }

  async createOpportunities(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const body = request.body as Record<string, unknown>;
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const contactName = typeof body.contactName === "string" ? body.contactName.trim() : "";
      const amountCents = Number(body.amountCents ?? 0);
      const stage = parseOpportunityStage(body.stage ?? "new");
      if (!await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      if (title.length < 2 || title.length > 120 || !contactName || contactName.length > 120 || !Number.isSafeInteger(amountCents) || amountCents < 0 || !stage) { response.status(400).json({ error: "Revisa los datos de la oportunidad." }); return; }
      const contactId = typeof body.contactId === "string" ? body.contactId : null;
      const assignedUserId = typeof body.assignedUserId === "string" ? body.assignedUserId : user.id;
      const scopeValid = await withTenant(this.pool, dealerId, async (client) => {
        const contactValid = !contactId || (await client.query("SELECT 1 FROM public.contacts WHERE id=$1::uuid AND tenant_id=$2::uuid", [contactId, dealerId])).rowCount === 1;
        const assigneeValid = (await client.query("SELECT 1 FROM public.user_tenant_memberships WHERE user_id=$1::uuid AND tenant_id=$2::uuid", [assignedUserId, dealerId])).rowCount === 1;
        return contactValid && assigneeValid;
      });
      if (!scopeValid) { response.status(400).json({ error: "El contacto y el responsable deben pertenecer al dealer actual." }); return; }
      const saved = await withTenant(this.pool, dealerId, async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
        await ensureOpportunityStages(client,dealerId); const nextAction=typeof body.nextAction==="string"?body.nextAction.trim().slice(0,500)||null:null; const nextActionAt=typeof body.nextActionAt==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(body.nextActionAt)?body.nextActionAt:null; const inserted = await client.query<{ id: string }>(`INSERT INTO public.opportunities (tenant_id,title,contact_id,contact_name,contact_phone,amount_cents,stage,assigned_user_id,expected_close_date,notes,next_action,next_action_at,created_by_user_id) VALUES ($1::uuid,$2,$3::uuid,$4,$5,$6,$7,$8::uuid,$9::date,$10,$11,$12::date,$13::uuid) RETURNING id::text AS id`, [dealerId,title,contactId,contactName,typeof body.contactPhone === "string" ? body.contactPhone : null,amountCents,stage,assignedUserId,typeof body.expectedCloseDate === "string" ? body.expectedCloseDate : null,typeof body.notes === "string" ? body.notes.trim().slice(0,2000) : null,nextAction,nextActionAt,user.id]);
        const result = await client.query<Opportunity>(`SELECT ${COLUMNS} FROM public.opportunities o LEFT JOIN public.app_users u ON u.id=o.assigned_user_id WHERE o.id=$1::uuid AND o.tenant_id=$2::uuid`,[inserted.rows[0].id,dealerId]);
        const tenant = await client.query<{ dealer_name: string }>("SELECT dealer_name FROM public.tenants WHERE dealer_id=$1::uuid", [dealerId]);
        await appendAudit(client,{actor:user,dealerId,dealerName:tenant.rows[0]?.dealer_name,category:"opportunities",action:"opportunity.created",summary:`Se creó la oportunidad ${title}.`,referenceId:auditReference(request),entityId:result.rows[0].id});
        return result.rows[0];
      });
      response.status(201).json({ opportunity: saved });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos guardar la oportunidad." }); }
  }

  async getOpportunitiesByOpportunityIdActivity(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const id = typeof request.params.opportunityId === "string" ? request.params.opportunityId : "";
      if (!UUID.test(id) || !await isMember(this.pool,user.id,dealerId)) { response.status(403).json({ error: "No tienes acceso a esta oportunidad." }); return; }
      const activity = await withTenant(this.pool,dealerId,async (client) => {
        const exists = await client.query("SELECT 1 FROM public.opportunities WHERE id=$1::uuid AND tenant_id=$2::uuid",[id,dealerId]);
        if (!exists.rowCount) return undefined;
        const rows = await client.query(`SELECT id::text AS id, action, summary, actor_name AS "actorName", created_at AS "createdAt" FROM public.admin_audit_events WHERE target_tenant_id=$1::uuid AND category='opportunities' AND entity_id=$2 ORDER BY created_at DESC LIMIT 20`,[dealerId,id]);
        return rows.rows;
      });
      if (!activity) { response.status(404).json({ error: "No encontramos esa oportunidad." }); return; }
      response.json({ activity });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar el historial de la oportunidad." }); }
  }

  async updateOpportunitiesByOpportunityId(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const body = request.body as Record<string, unknown>;
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const id = typeof request.params.opportunityId === "string" ? request.params.opportunityId : "";
      if (!UUID.test(id) || !await isMember(this.pool,user.id,dealerId)) { response.status(403).json({ error: "No tienes acceso a esta oportunidad." }); return; }
      const stage = body.stage === undefined ? undefined : parseOpportunityStage(body.stage);
      const assignee = body.assignedUserId === undefined ? undefined : body.assignedUserId === null ? null : typeof body.assignedUserId === "string" && UUID.test(body.assignedUserId) ? body.assignedUserId : undefined;
      const nextAction=body.nextAction===undefined?undefined:body.nextAction===null?null:typeof body.nextAction==="string"&&body.nextAction.trim().length<=500?body.nextAction.trim()||null:undefined; const nextActionAt=body.nextActionAt===undefined?undefined:body.nextActionAt===null||body.nextActionAt===""?null:typeof body.nextActionAt==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(body.nextActionAt)?body.nextActionAt:undefined;
      if ((body.stage !== undefined && !stage) || (body.assignedUserId !== undefined && assignee === undefined) || (body.nextAction!==undefined&&nextAction===undefined) || (body.nextActionAt!==undefined&&nextActionAt===undefined) || (body.archived!==undefined&&typeof body.archived!=="boolean")) { response.status(400).json({ error: "El cambio solicitado no es válido." }); return; }
      if (typeof body.assignedUserId === "string") {
        const assigneeAllowed = await withTenant(this.pool,dealerId,async (client) => (await client.query("SELECT 1 FROM public.user_tenant_memberships WHERE user_id=$1::uuid AND tenant_id=$2::uuid",[assignee,dealerId])).rowCount === 1);
        if (!assigneeAllowed) { response.status(400).json({ error: "El responsable debe pertenecer al dealer actual." }); return; }
      }
      const saved = await withTenant(this.pool,dealerId,async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
        const current = await client.query<{ stage: OpportunityStage; title: string; archived_at: Date | null }>("SELECT stage,title,archived_at FROM public.opportunities WHERE id=$1::uuid AND tenant_id=$2::uuid FOR UPDATE",[id,dealerId]);
        if (!current.rows[0]) return undefined;
        await client.query(`UPDATE public.opportunities SET stage=COALESCE($3,stage), assigned_user_id=CASE WHEN $4 THEN $5::uuid ELSE assigned_user_id END, next_action=CASE WHEN $6 THEN $7 ELSE next_action END, next_action_at=CASE WHEN $8 THEN $9::date ELSE next_action_at END, archived_at=CASE WHEN $10 THEN CASE WHEN $11 THEN COALESCE(archived_at,now()) ELSE NULL END ELSE archived_at END,updated_at=now() WHERE id=$1::uuid AND tenant_id=$2::uuid`,[id,dealerId,stage??null,body.assignedUserId!==undefined,assignee??null,body.nextAction!==undefined,nextAction??null,body.nextActionAt!==undefined,nextActionAt??null,body.archived!==undefined,body.archived===true]);
        const updated = await client.query<Opportunity>(`SELECT ${COLUMNS} FROM public.opportunities o LEFT JOIN public.app_users u ON u.id=o.assigned_user_id WHERE o.id=$1::uuid AND o.tenant_id=$2::uuid`,[id,dealerId]);
        const action = stage && stage !== current.rows[0].stage ? "opportunity.stage_changed" : body.archived!==undefined ? (body.archived?"opportunity.archived":"opportunity.restored") : body.nextAction!==undefined||body.nextActionAt!==undefined ? "opportunity.next_action_updated" : "opportunity.assigned";
        const tenant = await client.query<{ dealer_name: string }>("SELECT dealer_name FROM public.tenants WHERE dealer_id=$1::uuid",[dealerId]);
        await appendAudit(client,{actor:user,dealerId,dealerName:tenant.rows[0]?.dealer_name,category:"opportunities",action,summary:action === "opportunity.stage_changed" ? `La oportunidad ${current.rows[0].title} cambió a ${stage}.` : action === "opportunity.archived" ? `Se archivó la oportunidad ${current.rows[0].title}.` : action === "opportunity.restored" ? `Se restauró la oportunidad ${current.rows[0].title}.` : action === "opportunity.next_action_updated" ? `Se actualizó la próxima acción de ${current.rows[0].title}.` : `Se actualizó la asignación de ${current.rows[0].title}.`,referenceId:auditReference(request),entityId:id});
        return updated.rows[0];
      });
      if (!saved) { response.status(404).json({ error: "No encontramos esa oportunidad." }); return; }
      response.json({ opportunity: saved });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos actualizar la oportunidad." }); }
  }
}
