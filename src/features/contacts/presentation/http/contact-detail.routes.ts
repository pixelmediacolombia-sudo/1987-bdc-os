import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { UUID, type ContactRow, type ContactInput, type ContactActivity, dealerUser, withTenant, isMember, optionalText, parseContactInput, hasReachableAddress, duplicateContact, lockContactIdentity, auditContact, loadContactSummary, CONTACT_COLUMNS, validEmail } from "./contacts.route-helpers";

export function createContactDetailRouter(pool: Pool): express.Router {
  const router = express.Router();
  router.patch("/contacts/:contactId", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response);
      if (!user) return;
      const dealerId = typeof request.body?.dealerId === "string" ? request.body.dealerId : typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const contactId = typeof request.params.contactId === "string" ? request.params.contactId : "";
      if (!UUID.test(dealerId) || !UUID.test(contactId)) { response.status(400).json({ error: "El dealer o contacto no es válido." }); return; }
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const parsed = parseContactInput(request.body);
      if (!parsed.value || parsed.error) { response.status(400).json({ error: parsed.error ?? "Revisa los datos del contacto." }); return; }
      const input = parsed.value;
      const fields = Object.keys(input) as Array<keyof ContactInput>;
      if (!fields.length) { response.status(400).json({ error: "No hay cambios para guardar." }); return; }
      const update = await withTenant(pool, dealerId, async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
        const currentResult = await client.query<ContactRow>(
          `SELECT ${CONTACT_COLUMNS} FROM public.contacts AS c WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid FOR UPDATE`, [contactId, dealerId],
        );
        const current = currentResult.rows[0];
        if (!current) return { missing: true as const };
        const next = { phone: input.phone === undefined ? current.phone : input.phone, email: input.email === undefined ? current.email : input.email };
        if (!hasReachableAddress(next) && current.source === "manual") return { invalid: true as const };
        await lockContactIdentity(client, dealerId, next);
        const duplicate = await duplicateContact(client, dealerId, next, contactId);
        if (duplicate) return { duplicate };
        const columns: Record<keyof ContactInput, string> = { displayName: "display_name", phone: "phone", email: "email", preferredLanguage: "preferred_language" };
        const values: unknown[] = [contactId, dealerId];
        const assignments = fields.map((field) => {
          values.push(field === "preferredLanguage" ? input[field] ?? "unknown" : input[field] ?? null);
          return `${columns[field]} = $${values.length}`;
        });
        const saved = await client.query<{ id: string }>(
          `UPDATE public.contacts AS c SET ${assignments.join(", ")}, updated_at = now()
            WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid RETURNING ${CONTACT_COLUMNS}`,
          values,
        );
        const contact = saved.rows[0]?.id ? await loadContactSummary(client, dealerId, saved.rows[0].id) : undefined;
        if (!contact) throw new Error("Updated contact could not be loaded");
        await auditContact(client, user, dealerId, "contact.updated", contactId, `Se actualizaron campos de la ficha: ${fields.join(", ")}.`, request);
        return { contact };
      });
      if ("missing" in update) { response.status(404).json({ error: "No encontramos ese contacto en este dealer." }); return; }
      if ("invalid" in update) { response.status(400).json({ error: "El contacto debe conservar un teléfono o correo." }); return; }
      if ("duplicate" in update) { response.status(409).json({ error: "Otro contacto ya usa ese teléfono o correo.", contactId: update.duplicate }); return; }
      response.status(200).json({ contact: update.contact });
    } catch (error) {
      if ((error as { code?: string })?.code === "23505") { response.status(409).json({ error: "Otro contacto ya usa esos datos." }); return; }
      if (!response.headersSent) response.status(500).json({ error: "No pudimos actualizar el contacto." });
    }
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
          `SELECT ${CONTACT_COLUMNS} FROM public.contacts AS c WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid`, [contactId, dealerId],
        );
        if (!result.rows[0]) return undefined;
        const activity = await client.query(
          `SELECT cv.id::text AS "conversationId", cv.channel, cv.owner, cv.state, cv.last_activity AS "lastActivity",
             m.id::text AS "messageId", m.direction, m.sender_type AS "senderType", m.sender_user_id::text AS "senderUserId", sender.display_name AS "senderName", m.content, m.status, m.created_at AS "createdAt"
           FROM (SELECT * FROM public.conversations WHERE tenant_id = $1::uuid AND contact_id = $2::uuid ORDER BY last_activity DESC LIMIT 20) AS cv
           LEFT JOIN LATERAL (SELECT id, direction, sender_type, sender_user_id, content, status, created_at FROM public.messages
             WHERE tenant_id = $1::uuid AND conversation_id = cv.id ORDER BY created_at DESC LIMIT 10) AS m ON true
           LEFT JOIN public.app_users AS sender ON sender.id = m.sender_user_id
           ORDER BY cv.last_activity DESC, m.created_at ASC`, [dealerId, contactId],
        );
        const contactActivities = await client.query<ContactActivity>(
          `SELECT id::text AS id, action, actor_name AS "actorName", summary, created_at AS "createdAt"
             FROM public.admin_audit_events
            WHERE target_tenant_id = $1::uuid AND category = 'contacts'
              AND (entity_id = $2 OR (entity_id IS NULL AND summary LIKE '%' || $2 || '%'))
            ORDER BY created_at DESC, id DESC LIMIT 50`,
          [dealerId, contactId.toLowerCase()],
        );
        const conversations = new Map<string, { id: string; channel: string; owner: string | null; state: string; lastActivity: Date | string; messages: Array<Record<string, unknown>> }>();
        for (const row of activity.rows) {
          let conversation = conversations.get(row.conversationId);
          if (!conversation) {
            conversation = { id: row.conversationId, channel: row.channel, owner: row.owner, state: row.state, lastActivity: row.lastActivity, messages: [] };
            conversations.set(conversation.id, conversation);
          }
          if (row.messageId) conversation.messages.push({ id: row.messageId, direction: row.direction, senderType: row.senderType, senderUserId: row.senderUserId, senderName: row.senderName, content: row.content, status: row.status, createdAt: row.createdAt });
        }
        return {
          ...result.rows[0],
          conversations: [...conversations.values()],
          activities: contactActivities.rows.map((item) => ({
            ...item,
            summary: item.summary.replaceAll(contactId.toLowerCase(), "").replace(/\s+/g, " ").trim(),
          })),
        };
      });
      if (!contact) { response.status(404).json({ error: "No encontramos ese contacto en este dealer." }); return; }
      response.status(200).json({ contact });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar el detalle del contacto." }); }
  });


  return router;
}
