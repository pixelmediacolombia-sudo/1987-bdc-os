import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { UUID, dealerUser, withTenant, isMember, auditContact } from "./contacts.route-helpers";

export function createConversationWorkflowRouter(pool: Pool): express.Router {
  const router = express.Router();
  router.patch("/conversations/:conversationId", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response);
      if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const conversationId = typeof request.params.conversationId === "string" ? request.params.conversationId : "";
      if (!UUID.test(dealerId) || !UUID.test(conversationId)) { response.status(400).json({ error: "El dealer o la conversación no es válida." }); return; }
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body)) { response.status(400).json({ error: "Indica la asignación o el estado de lectura." }); return; }
      const body = request.body as Record<string, unknown>;
      const hasAssignee = Object.hasOwn(body, "assignedUserId");
      const hasRead = Object.hasOwn(body, "isRead");
      if ((!hasAssignee && !hasRead) || Object.keys(body).some((key) => key !== "assignedUserId" && key !== "isRead")
        || (hasAssignee && body.assignedUserId !== null && (typeof body.assignedUserId !== "string" || !UUID.test(body.assignedUserId)))
        || (hasRead && typeof body.isRead !== "boolean")) {
        response.status(400).json({ error: "La actualización de conversación no es válida." }); return;
      }
      const result = await withTenant(pool, dealerId, async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
        if (hasAssignee && body.assignedUserId) {
          const member = await client.query(
            `SELECT 1 FROM public.user_tenant_memberships AS m JOIN public.app_users AS u ON u.id = m.user_id
              WHERE m.tenant_id = $1::uuid AND m.user_id = $2::uuid AND u.account_type = 'user' AND u.status = 'active'`,
            [dealerId, body.assignedUserId],
          );
          if (member.rowCount !== 1) return { invalidAssignee: true as const };
        }
        const updated = await client.query(
          `UPDATE public.conversations SET
             assigned_user_id = CASE WHEN $3::boolean THEN $4::uuid ELSE assigned_user_id END,
             read_at = CASE WHEN $5::boolean THEN CASE WHEN $6::boolean THEN now() ELSE NULL END ELSE read_at END,
             read_by_user_id = CASE WHEN $5::boolean THEN CASE WHEN $6::boolean THEN $7::uuid ELSE NULL END ELSE read_by_user_id END
            WHERE id = $1::uuid AND tenant_id = $2::uuid
            RETURNING id::text AS id, assigned_user_id::text AS "assignedUserId", read_at IS NOT NULL AS "isRead"`,
          [conversationId, dealerId, hasAssignee, hasAssignee ? body.assignedUserId : null, hasRead, hasRead ? body.isRead : false, user.id],
        );
        if (!updated.rows[0]) return undefined;
        if (hasAssignee) await auditContact(client, user, dealerId, "conversation.assigned", conversationId, body.assignedUserId ? "Se asignó la conversación a un asesor." : "Se quitó la asignación de la conversación.", request);
        if (hasRead) await auditContact(client, user, dealerId, body.isRead ? "conversation.read" : "conversation.unread", conversationId, body.isRead ? "Se marcó la conversación como leída." : "Se marcó la conversación como no leída.", request);
        return { conversation: updated.rows[0] };
      });
      if (result && "invalidAssignee" in result) { response.status(400).json({ error: "El asesor no pertenece a este dealer o está inactivo." }); return; }
      if (!result) { response.status(404).json({ error: "No encontramos la conversación en este dealer." }); return; }
      response.status(200).json(result);
    } catch { response.status(500).json({ error: "No pudimos actualizar la conversación." }); }
  });
  return router;
}
