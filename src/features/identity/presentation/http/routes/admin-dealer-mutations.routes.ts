import { randomBytes, randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { appendAudit, auditReference, invitationUrl, requireAdmin, tokenDigest, validEmail, INVITATION_TTL_HOURS, type IdentityRouteOptions, type IdentityUser } from "./route-helpers";

export function createAdminDealerMutationRoutes(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  const publicAppUrl = options.publicAppUrl ?? (options.production ? undefined : "http://localhost:3000");
  router.delete("/admin/dealers/:dealerId", async (request: Request, response: Response) => {
    const dealerId = request.params.dealerId;
    if (typeof dealerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(dealerId)) {
      response.status(400).json({ error: "El identificador del dealer no es válido." });
      return;
    }
    let admin: IdentityUser | undefined;
    try { admin = await requireAdmin(pool, request, response); } catch {
      response.status(500).json({ error: "No pudimos verificar la sesión." });
      return;
    }
    if (!admin) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [dealerId]);
      const existing = await client.query<{ dealer_name: string | null }>(
        "SELECT dealer_name FROM public.tenants WHERE dealer_id = $1 FOR UPDATE", [dealerId],
      );
      if (!existing.rows[0]) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "No encontramos ese dealer." });
        return;
      }
      await client.query("DELETE FROM public.tenants WHERE dealer_id = $1", [dealerId]);
      await appendAudit(client, { actor: admin, dealerId, dealerName: existing.rows[0].dealer_name,
        category: "dealers", action: "dealer.deleted", summary: "Dealer eliminado por el administrador.", referenceId: auditReference(request) });
      await client.query("COMMIT");
      response.status(204).end();
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      response.status(500).json({ error: "No pudimos eliminar el dealer." });
    } finally { client.release(); }
  });

  router.patch("/admin/dealers/:dealerId/name", async (request: Request, response: Response) => {
    const dealerId = request.params.dealerId;
    if (typeof dealerId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(dealerId)) {
      response.status(400).json({ error: "El identificador del dealer no es válido." });
      return;
    }
    const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";
    if (!name || name.length > 160) {
      response.status(400).json({ error: "Ingresa un nombre de hasta 160 caracteres." });
      return;
    }
    let admin: IdentityUser | undefined;
    try { admin = await requireAdmin(pool, request, response); } catch {
      response.status(500).json({ error: "No pudimos verificar la sesión." });
      return;
    }
    if (!admin) return;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [dealerId]);
      const existing = await client.query<{ dealer_name: string | null }>(
        "SELECT dealer_name FROM public.tenants WHERE dealer_id = $1 FOR UPDATE", [dealerId],
      );
      if (!existing.rows[0]) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "No encontramos ese dealer." });
        return;
      }
      await client.query("UPDATE public.tenants SET dealer_name = $2 WHERE dealer_id = $1", [dealerId, name]);
      await appendAudit(client, {
        actor: admin, dealerId, dealerName: name, category: "dealers", action: "dealer.renamed",
        summary: "Nombre del dealer actualizado por el administrador.", referenceId: auditReference(request),
      });
      await client.query("COMMIT");
      response.status(200).json({ dealer: { id: dealerId, name } });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      response.status(500).json({ error: "No pudimos guardar el nombre del dealer." });
    } finally { client.release(); }
  });

  router.post("/admin/dealers", async (request: Request, response: Response) => {
    const dealerName = typeof request.body?.dealerName === "string" ? request.body.dealerName.trim() : "";
    const ownerName = typeof request.body?.ownerName === "string" ? request.body.ownerName.trim() : "";
    const email = typeof request.body?.ownerEmail === "string" ? request.body.ownerEmail.trim().toLowerCase() : "";
    if (!dealerName || dealerName.length > 160 || !ownerName || ownerName.length > 160 || !validEmail(email)) {
      response.status(400).json({ error: "Ingresa el nombre del dealer, el nombre del responsable y un correo válido." });
      return;
    }

    const admin = await requireAdmin(pool, request, response).catch(() => undefined);
    if (!admin) {
      if (!response.headersSent) response.status(500).json({ error: "No pudimos verificar la sesión." });
      return;
    }
    if (!publicAppUrl) {
      response.status(503).json({ error: "Configura BDC_APP_URL antes de emitir invitaciones." });
      return;
    }

    const dealerId = randomUUID();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [dealerId]);
      const existing = await client.query<{ account_type: string; status: string }>(
        "SELECT account_type, status FROM public.app_users WHERE lower(email) = $1 LIMIT 1",
        [email],
      );
      if (existing.rows[0]) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "Ese correo ya tiene una cuenta. Invítalo desde el dealer correspondiente." });
        return;
      }
      const tenant = await client.query<{ id: string }>(
        `INSERT INTO public.tenants
           (dealer_id, dealer_name, timezone, policy_version, status,
            sofia_enabled, qualification_flow_enabled, qualification_signal_enabled)
         VALUES ($1, $2, 'America/New_York', 'pending_dealer_setup', 'active', false, false, false)
         RETURNING dealer_id::text AS id`,
        [dealerId, dealerName],
      );
      if (!tenant.rows[0]?.id) throw new Error("Tenant insert did not return an id");
      const rawToken = randomBytes(32).toString("base64url");
      await client.query(
        `INSERT INTO public.dealer_invitations
           (tenant_id, email, display_name, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 hour'))`,
        [dealerId, email, ownerName, tokenDigest(rawToken), admin.id, INVITATION_TTL_HOURS],
      );
      await appendAudit(client, { actor: admin, dealerId, dealerName, category: "dealers", action: "dealer.created",
        summary: `Dealer creado y se registró la invitación para ${email}.`, referenceId: auditReference(request) });
      await client.query("COMMIT");
      const url = invitationUrl(publicAppUrl, rawToken);
      let delivery: "sent" | "manual" | "failed" = "manual";
      if (options.invitationMailer) {
        try {
          await options.invitationMailer.send({ to: email, displayName: ownerName, dealerName, invitationUrl: url, expiresInHours: INVITATION_TTL_HOURS });
          delivery = "sent";
        } catch {
          delivery = "failed";
        }
      }
      response.status(201).json({
        dealer: { id: dealerId, name: dealerName, status: "onboarding" },
        invitation: { email, expiresInHours: INVITATION_TTL_HOURS, delivery, ...(delivery === "sent" ? {} : { url }) },
      });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      response.status(500).json({ error: "No pudimos crear el dealer y su invitación." });
    } finally {
      client.release();
    }
  });

  router.post("/admin/dealers/:dealerId/invitations", async (request: Request, response: Response) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const displayName = typeof request.body?.displayName === "string" ? request.body.displayName.trim() : "";
    if (!validEmail(email) || !displayName || displayName.length > 160) {
      response.status(400).json({ error: "Ingresa el nombre del usuario y un correo válido." });
      return;
    }
    let admin: IdentityUser | undefined;
    try {
      admin = await requireAdmin(pool, request, response);
    } catch {
      response.status(500).json({ error: "No pudimos verificar la sesión." });
      return;
    }
    if (!admin) return;
    if (!publicAppUrl) {
      response.status(503).json({ error: "Configura BDC_APP_URL antes de emitir invitaciones." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [request.params.dealerId]);
      const tenant = await client.query<{ id: string; dealer_name: string | null }>(
        "SELECT dealer_id::text AS id, dealer_name FROM public.tenants WHERE dealer_id = $1 FOR UPDATE",
        [request.params.dealerId],
      );
      if (!tenant.rows[0]) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "No encontramos ese dealer." });
        return;
      }
      const existing = await client.query<{ account_type: string; status: string }>(
        "SELECT account_type, status FROM public.app_users WHERE lower(email) = $1 LIMIT 1",
        [email],
      );
      const dealerName = tenant.rows[0].dealer_name?.trim() || "tu dealer";
      if (existing.rows[0]?.account_type === "admin") {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "No se puede invitar una cuenta administradora como usuario de dealer." });
        return;
      }
      if (existing.rows[0]?.status === "disabled") {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "La cuenta está deshabilitada y requiere asistencia del administrador." });
        return;
      }
      const prior = await client.query(
        `UPDATE public.dealer_invitations SET revoked_at = now()
          WHERE tenant_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [tenant.rows[0].id, email],
      );
      void prior;
      const rawToken = randomBytes(32).toString("base64url");
      await client.query(
        `INSERT INTO public.dealer_invitations
           (tenant_id, email, display_name, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 hour'))`,
        [tenant.rows[0].id, email, displayName, tokenDigest(rawToken), admin.id, INVITATION_TTL_HOURS],
      );
      await appendAudit(client, { actor: admin, dealerId: tenant.rows[0].id, dealerName,
        category: "invitations", action: "invitation.created", summary: `Invitación emitida para ${email}.`, referenceId: auditReference(request) });
      await client.query("COMMIT");
      const url = invitationUrl(publicAppUrl, rawToken);
      let delivery: "sent" | "manual" | "failed" = "manual";
      if (options.invitationMailer) {
        try {
          await options.invitationMailer.send({ to: email, displayName, dealerName, invitationUrl: url, expiresInHours: INVITATION_TTL_HOURS });
          delivery = "sent";
        } catch {
          delivery = "failed";
        }
      }
      response.status(201).json({ invitation: { email, expiresInHours: INVITATION_TTL_HOURS, delivery, ...(delivery === "sent" ? {} : { url }) } });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      response.status(500).json({ error: "No pudimos emitir la invitación." });
    } finally {
      client.release();
    }
  });
  return router;
}

