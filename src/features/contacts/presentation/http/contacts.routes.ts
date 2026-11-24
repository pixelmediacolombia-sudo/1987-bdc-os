import express, { type Request, type Response } from "express";
import type { Pool, PoolClient } from "pg";
import { activeSession } from "@/features/identity/presentation/http/routes/route-helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Tenant = { id: string; name: string | null };
type ContactRow = {
  id: string; dealerId: string; providerContactId: string; phone: string | null; email: string | null;
  preferredLanguage: string; consentState: string; createdAt: Date | string; updatedAt: Date | string;
  conversationCount: number; lastActivity: Date | string | null; channels: string[];
};

async function dealerUser(pool: Pool, request: Request, response: Response) {
  const user = await activeSession(pool, request);
  if (!user) { response.status(401).json({ error: "Inicia sesión para continuar." }); return undefined; }
  if (user.account_type !== "user") { response.status(403).json({ error: "Esta sección requiere una cuenta de dealer." }); return undefined; }
  return user;
}

async function isMember(pool: Pool, userId: string, dealerId: string): Promise<boolean> {
  if (!UUID.test(dealerId)) return false;
  const membership = await pool.query(
    "SELECT 1 FROM public.user_tenant_memberships WHERE user_id = $1 AND tenant_id = $2::uuid",
    [userId, dealerId],
  );
  if (membership.rowCount !== 1) return false;
  return withTenant(pool, dealerId, async (client) => {
    const tenant = await client.query(
      "SELECT 1 FROM public.tenants WHERE dealer_id = $1::uuid AND status = 'active'",
      [dealerId],
    );
    return tenant.rowCount === 1;
  });
}

async function withTenant<T>(pool: Pool, tenantId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const value = await action(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export function createContactsRouter(pool: Pool): express.Router {
  const router = express.Router();

  router.get("/contacts/dealers", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response);
      if (!user) return;
      const memberships = await pool.query<{ tenant_id: string }>(
        "SELECT tenant_id::text FROM public.user_tenant_memberships WHERE user_id = $1 ORDER BY tenant_id", [user.id],
      );
      const dealers: Tenant[] = [];
      for (const { tenant_id: id } of memberships.rows) {
        const dealer = await withTenant(pool, id, async (client) => {
          const result = await client.query<Tenant>(
            "SELECT dealer_id::text AS id, dealer_name AS name FROM public.tenants WHERE dealer_id = $1::uuid AND status = 'active'", [id],
          );
          return result.rows[0];
        });
        if (dealer) dealers.push(dealer);
      }
      response.status(200).json({ dealers });
    } catch { response.status(500).json({ error: "No pudimos cargar los dealers asociados." }); }
  });

  router.get("/contacts", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response);
      if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      if (!UUID.test(dealerId)) { response.status(400).json({ error: "Selecciona un dealer válido." }); return; }
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const search = typeof request.query.search === "string" ? request.query.search.trim().slice(0, 120) : "";
      const rawLimit = Number(request.query.limit ?? 50), rawOffset = Number(request.query.offset ?? 0);
      const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
      const offset = Number.isInteger(rawOffset) ? Math.max(rawOffset, 0) : 0;
      const data = await withTenant(pool, dealerId, async (client) => {
        const where = "c.tenant_id = $1::uuid AND ($2 = '' OR c.phone ILIKE '%' || $2 || '%' OR c.email ILIKE '%' || $2 || '%' OR c.provider_contact_id ILIKE '%' || $2 || '%')";
        const count = await client.query<{ total: number }>(
          "SELECT COUNT(*)::int AS total FROM public.contacts AS c WHERE " + where, [dealerId, search],
        );
        const rows = await client.query<ContactRow>(
          "SELECT c.id::text AS id, c.tenant_id::text AS \"dealerId\", c.provider_contact_id AS \"providerContactId\", c.phone, c.email, c.preferred_language AS \"preferredLanguage\", c.consent_state AS \"consentState\", c.created_at AS \"createdAt\", c.updated_at AS \"updatedAt\", COUNT(DISTINCT cv.id)::int AS \"conversationCount\", MAX(cv.last_activity) AS \"lastActivity\", COALESCE(array_agg(DISTINCT cv.channel) FILTER (WHERE cv.channel IS NOT NULL), ARRAY[]::text[]) AS channels FROM public.contacts AS c LEFT JOIN public.conversations AS cv ON cv.contact_id = c.id AND cv.tenant_id = c.tenant_id WHERE " + where + " GROUP BY c.id ORDER BY MAX(cv.last_activity) DESC NULLS LAST, c.updated_at DESC, c.id LIMIT $3 OFFSET $4",
          [dealerId, search, limit, offset],
        );
        return { contacts: rows.rows, total: count.rows[0]?.total ?? 0 };
      });
      response.status(200).json({ ...data, limit, offset });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar los contactos." }); }
  });

  router.get("/contacts/:contactId", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response);
      if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const contactId = typeof request.params.contactId === "string" ? request.params.contactId : "";
      if (!UUID.test(dealerId) || !UUID.test(contactId)) { response.status(400).json({ error: "El dealer o contacto no es válido." }); return; }
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const contact = await withTenant(pool, dealerId, async (client) => {
        const result = await client.query(
          "SELECT id::text AS id, tenant_id::text AS \"dealerId\", provider_contact_id AS \"providerContactId\", phone, email, preferred_language AS \"preferredLanguage\", consent_state AS \"consentState\", created_at AS \"createdAt\", updated_at AS \"updatedAt\" FROM public.contacts WHERE id = $1::uuid AND tenant_id = $2::uuid",
          [contactId, dealerId],
        );
        if (!result.rows[0]) return undefined;
        const activity = await client.query(
          "SELECT cv.id::text AS \"conversationId\", cv.channel, cv.owner, cv.state, cv.last_activity AS \"lastActivity\", m.id::text AS \"messageId\", m.direction, m.sender_type AS \"senderType\", m.content, m.created_at AS \"createdAt\" FROM (SELECT * FROM public.conversations WHERE tenant_id = $1::uuid AND contact_id = $2::uuid ORDER BY last_activity DESC LIMIT 20) AS cv LEFT JOIN LATERAL (SELECT id, direction, sender_type, content, created_at FROM public.messages WHERE tenant_id = $1::uuid AND conversation_id = cv.id ORDER BY created_at DESC LIMIT 10) AS m ON true ORDER BY cv.last_activity DESC, m.created_at ASC",
          [dealerId, contactId],
        );
        const conversations = new Map<string, { id: string; channel: string; owner: string | null; state: string; lastActivity: Date | string; messages: Array<Record<string, unknown>> }>();
        for (const row of activity.rows) {
          let conversation = conversations.get(row.conversationId);
          if (!conversation) {
            conversation = { id: row.conversationId, channel: row.channel, owner: row.owner, state: row.state, lastActivity: row.lastActivity, messages: [] };
            conversations.set(conversation.id, conversation);
          }
          if (row.messageId) conversation.messages.push({ id: row.messageId, direction: row.direction, senderType: row.senderType, content: row.content, createdAt: row.createdAt });
        }
        return { ...result.rows[0], conversations: [...conversations.values()] };
      });
      if (!contact) { response.status(404).json({ error: "No encontramos ese contacto en este dealer." }); return; }
      response.status(200).json({ contact });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar el detalle del contacto." }); }
  });

  return router;
}
