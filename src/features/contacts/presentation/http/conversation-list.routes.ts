import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { UUID, type InboxConversationRow, dealerUser, withTenant, isMember } from "./contacts.route-helpers";

export function createConversationListRouter(pool: Pool): express.Router {
  const router = express.Router();
  router.get("/conversations", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response);
      if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      if (!UUID.test(dealerId)) { response.status(400).json({ error: "Selecciona un dealer válido." }); return; }
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const search = typeof request.query.search === "string" ? request.query.search.trim().slice(0, 120) : "";
      const channel = typeof request.query.channel === "string" ? request.query.channel.trim().toLowerCase() : "";
      const unreadOnly = request.query.unreadOnly === "true";
      if (channel && !["messenger", "instagram", "whatsapp", "facebook"].includes(channel)) {
        response.status(400).json({ error: "El canal seleccionado no es válido." }); return;
      }
      const rawLimit = Number(request.query.limit ?? 50), rawOffset = Number(request.query.offset ?? 0);
      const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
      const offset = Number.isInteger(rawOffset) ? Math.max(rawOffset, 0) : 0;
      const result = await withTenant(pool, dealerId, async (client) => {
        const filter = `cv.tenant_id = $1::uuid
          AND ($2 = '' OR c.display_name ILIKE '%' || $2 || '%' OR c.phone ILIKE '%' || $2 || '%'
            OR c.email ILIKE '%' || $2 || '%' OR lm.content ILIKE '%' || $2 || '%')
          AND (NOT $4::boolean OR cv.read_at IS NULL)
          AND ($3 = '' OR ($3 = 'facebook' AND lower(cv.channel) IN ('facebook', 'fb', 'messenger'))
            OR ($3 = 'messenger' AND lower(cv.channel) IN ('messenger', 'facebook', 'fb'))
            OR ($3 = 'instagram' AND lower(cv.channel) IN ('instagram', 'ig')) OR lower(cv.channel) = $3)`;
        const count = await client.query<{ total: number }>(
          `SELECT COUNT(*)::int AS total
             FROM public.conversations AS cv
             JOIN public.contacts AS c ON c.tenant_id = cv.tenant_id AND c.id = cv.contact_id
             LEFT JOIN LATERAL (SELECT m.content FROM public.messages AS m
               WHERE m.tenant_id = cv.tenant_id AND m.conversation_id = cv.id
               ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS lm ON true
            WHERE ${filter}`,
          [dealerId, search, channel, unreadOnly],
        );
        const rows = await client.query<InboxConversationRow>(
          `SELECT cv.id::text AS id, cv.tenant_id::text AS "dealerId", cv.contact_id::text AS "contactId",
                  c.display_name AS "contactName", c.phone, cv.channel, cv.owner, cv.state,
                  cv.last_activity AS "lastActivity", lm.content AS "lastMessage", lm.direction AS "lastDirection",
                  cv.assigned_user_id::text AS "assignedUserId", assignee.display_name AS "assignedUserName",
                  (cv.read_at IS NOT NULL) AS "isRead"
             FROM public.conversations AS cv
             JOIN public.contacts AS c ON c.tenant_id = cv.tenant_id AND c.id = cv.contact_id
             LEFT JOIN public.app_users AS assignee ON assignee.id = cv.assigned_user_id AND assignee.status = 'active'
             LEFT JOIN LATERAL (SELECT m.content, m.direction FROM public.messages AS m
               WHERE m.tenant_id = cv.tenant_id AND m.conversation_id = cv.id
               ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS lm ON true
            WHERE ${filter}
            ORDER BY cv.last_activity DESC NULLS LAST, cv.id DESC
            LIMIT $5 OFFSET $6`,
          [dealerId, search, channel, unreadOnly, limit, offset],
        );
        return { conversations: rows.rows, total: count.rows[0]?.total ?? 0, limit, offset };
      });
      response.status(200).json(result);
    } catch { response.status(500).json({ error: "No pudimos cargar las conversaciones." }); }
  });

  router.get("/conversations/assignees", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response);
      if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      if (!UUID.test(dealerId)) { response.status(400).json({ error: "El dealer no es válido." }); return; }
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const assignees = await withTenant(pool, dealerId, async (client) => {
        const result = await client.query(
          `SELECT u.id::text AS id, u.display_name AS "displayName"
             FROM public.user_tenant_memberships AS m
             JOIN public.app_users AS u ON u.id = m.user_id
            WHERE m.tenant_id = $1::uuid AND u.account_type = 'user' AND u.status = 'active'
            ORDER BY lower(u.display_name), lower(u.email)`, [dealerId],
        );
        return result.rows;
      });
      response.status(200).json({ assignees });
    } catch { response.status(500).json({ error: "No pudimos cargar los asesores del dealer." }); }
  });
  return router;
}
