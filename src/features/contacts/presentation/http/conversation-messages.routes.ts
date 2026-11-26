import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import type { ConversationReplySender, ConversationReplyChannel } from "@/features/contacts/application/conversation-reply-sender.port";
import { MetaGraphApiError } from "@/features/meta/infrastructure/meta-graph-api.client";
import { UUID, dealerUser, withTenant, isMember, auditContact } from "./contacts.route-helpers";

export function createConversationMessageRouter(pool: Pool, replySender?: ConversationReplySender): express.Router {
  const router = express.Router();
  router.post("/conversations/:conversationId/messages", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response);
      if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const conversationId = typeof request.params.conversationId === "string" ? request.params.conversationId : "";
      const body = request.body && typeof request.body === "object" && !Array.isArray(request.body)
        ? request.body as Record<string, unknown> : undefined;
      const clientMessageId = typeof body?.clientMessageId === "string" ? body.clientMessageId : "";
      const content = typeof body?.content === "string" ? body.content.trim() : "";
      if (!UUID.test(dealerId) || !UUID.test(conversationId)) { response.status(400).json({ error: "El dealer o la conversación no es válida." }); return; }
      if (!UUID.test(clientMessageId) || !content || content.length > 2000 || Object.keys(body ?? {}).some((key) => !["clientMessageId", "content"].includes(key))) {
        response.status(400).json({ error: "Escribe una respuesta válida de hasta 2000 caracteres." }); return;
      }
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      if (!replySender) { response.status(503).json({ error: "El envío de mensajes no está disponible en este momento." }); return; }

      const reservation = await withTenant(pool, dealerId, async (client) => {
        const conversation = await client.query<{ contactId: string; providerContactId: string; channel: string; state: string }>(
          `SELECT cv.contact_id::text AS "contactId", c.provider_contact_id AS "providerContactId", cv.channel, cv.state
             FROM public.conversations AS cv JOIN public.contacts AS c ON c.id = cv.contact_id AND c.tenant_id = cv.tenant_id
            WHERE cv.id = $1::uuid AND cv.tenant_id = $2::uuid FOR UPDATE OF cv`, [conversationId, dealerId],
        );
        const current = conversation.rows[0];
        if (!current) return { kind: "missing" as const };
        if (current.state !== "open") return { kind: "closed" as const };
        const existing = await client.query<{ id: string; content: string; status: string; createdAt: Date | string; externalId: string | null }>(
          `SELECT id::text AS id, content, status, created_at AS "createdAt", external_id AS "externalId"
             FROM public.messages WHERE tenant_id = $1::uuid AND conversation_id = $2::uuid AND client_message_id = $3::uuid FOR UPDATE`,
          [dealerId, conversationId, clientMessageId],
        );
        let message = existing.rows[0];
        if (message && message.content !== content) return { kind: "key_conflict" as const };
        if (message?.status === "sent") return { kind: "sent" as const, message };
        if (message?.status === "pending") return { kind: "pending" as const, message };
        if (message?.status === "uncertain") return { kind: "uncertain" as const, message };
        const channel = current.channel.toLowerCase();
        const providerChannel: ConversationReplyChannel | undefined = ["facebook", "fb", "messenger"].includes(channel) ? "FB"
          : ["instagram", "ig"].includes(channel) ? "IG" : channel === "whatsapp" ? "WhatsApp" : undefined;
        if (!providerChannel) return { kind: "unsupported" as const };
        if (message) {
          const updated = await client.query(
            `UPDATE public.messages SET status = 'pending', sender_user_id = $4::uuid
              WHERE id = $1::uuid AND tenant_id = $2::uuid AND conversation_id = $3::uuid
              RETURNING id::text AS id, content, status, created_at AS "createdAt", external_id AS "externalId"`,
            [message.id, dealerId, conversationId, user.id],
          );
          message = updated.rows[0] as typeof message;
        } else {
          const created = await client.query(
            `INSERT INTO public.messages (tenant_id, conversation_id, client_message_id, direction, sender_type, sender_user_id, content, status)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'outbound', 'agent', $4::uuid, $5, 'pending')
             RETURNING id::text AS id, content, status, created_at AS "createdAt", external_id AS "externalId"`,
            [dealerId, conversationId, clientMessageId, user.id, content],
          );
          message = created.rows[0];
        }
        return { kind: "reserved" as const, message, contactId: current.providerContactId, providerChannel };
      });

      if (reservation.kind === "missing") { response.status(404).json({ error: "No encontramos la conversación en este dealer." }); return; }
      if (reservation.kind === "closed") { response.status(409).json({ error: "La conversación está cerrada." }); return; }
      if (reservation.kind === "unsupported") { response.status(422).json({ error: "Este canal no admite respuestas desde la bandeja." }); return; }
      if (reservation.kind === "key_conflict") { response.status(409).json({ error: "El identificador de solicitud ya se usó para otro mensaje." }); return; }
      if (reservation.kind === "sent") { response.status(200).json({ message: reservation.message, replayed: true }); return; }
      if (reservation.kind === "pending") { response.status(202).json({ message: reservation.message, replayed: true }); return; }
      if (reservation.kind === "uncertain") { response.status(409).json({ error: "No pudimos confirmar la entrega. Verifica la conversación antes de volver a intentar.", message: reservation.message }); return; }

      let delivered: { providerMessageId: string };
      try {
        delivered = await replySender.send({ tenantId: dealerId, contactId: reservation.contactId, content, channel: reservation.providerChannel, clientMessageId });
      } catch (error) {
        const knownRejection = error instanceof MetaGraphApiError && typeof error.status === "number" && error.status >= 400 && error.status < 500;
        const status = knownRejection ? "failed" : error instanceof MetaGraphApiError ? "uncertain" : "failed";
        const failureMessage = status === "uncertain" ? "No pudimos confirmar la entrega. Verifica la conversación antes de volver a intentar." : "No se pudo enviar el mensaje. Puedes intentarlo de nuevo.";
        const failed = await withTenant(pool, dealerId, async (client) => {
          const result = await client.query(
            `UPDATE public.messages SET status = $3
              WHERE id = $1::uuid AND tenant_id = $2::uuid
              RETURNING id::text AS id, direction, sender_type AS "senderType", sender_user_id::text AS "senderUserId", content, status, created_at AS "createdAt"`,
            [reservation.message.id, dealerId, status],
          );
          return { ...result.rows[0], senderName: user.display_name };
        }).catch(() => ({ ...reservation.message, status: "pending", senderName: user.display_name }));
        response.status(502).json({ error: failureMessage, message: failed });
        return;
      }

      try {
        const saved = await withTenant(pool, dealerId, async (client) => {
          const result = await client.query(
            `UPDATE public.messages SET status = 'sent', external_id = $3
              WHERE id = $1::uuid AND tenant_id = $2::uuid
              RETURNING id::text AS id, direction, sender_type AS "senderType", sender_user_id::text AS "senderUserId", content, status, created_at AS "createdAt"`,
            [reservation.message.id, dealerId, delivered.providerMessageId],
          );
          await client.query("UPDATE public.conversations SET last_activity = now(), read_at = now(), read_by_user_id = $3::uuid WHERE id = $1::uuid AND tenant_id = $2::uuid", [conversationId, dealerId, user.id]);
          await auditContact(client, user, dealerId, "message.sent", conversationId, "Se envió una respuesta desde la bandeja.", request);
          return { ...result.rows[0], senderName: user.display_name };
        });
        response.status(201).json({ message: saved, replayed: false });
      } catch {
        const uncertain = { ...reservation.message, status: "uncertain", senderName: user.display_name };
        await withTenant(pool, dealerId, async (client) => {
          await client.query(
            `UPDATE public.messages SET status = 'uncertain', external_id = $3
              WHERE id = $1::uuid AND tenant_id = $2::uuid`,
            [reservation.message.id, dealerId, delivered.providerMessageId],
          );
        }).catch(() => undefined);
        response.status(502).json({ error: "Meta recibió la solicitud, pero no pudimos confirmar el registro. Verifica la conversación antes de volver a intentar.", message: uncertain });
      }
    } catch {
      if (!response.headersSent) response.status(500).json({ error: "No pudimos procesar la respuesta." });
    }
  });
  return router;
}
