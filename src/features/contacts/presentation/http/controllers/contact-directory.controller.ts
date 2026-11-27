import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { UUID, type Tenant, type ContactRow, type ContactInput, dealerUser, withUser, withTenant, isMember, parseContactInput, hasReachableAddress, lockContactIdentity, duplicateContact, loadContactSummary, auditContact, CONTACT_COLUMNS } from "../contacts.route-helpers";



export class ContactDirectoryController {
  constructor(private readonly pool: Pool) {}

  async getContactsDealers(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response);
      if (!user) return;
      const memberships = await withUser(this.pool, user.id, (client) => client.query<{ tenant_id: string }>(
        "SELECT tenant_id::text FROM public.user_tenant_memberships WHERE user_id = $1 ORDER BY tenant_id", [user.id],
      ));
      const dealers: Tenant[] = [];
      for (const { tenant_id: id } of memberships.rows) {
        const dealer = await withTenant(this.pool, id, async (client) => {
          const result = await client.query<Tenant>(
            "SELECT dealer_id::text AS id, dealer_name AS name FROM public.tenants WHERE dealer_id = $1::uuid AND status = 'active'", [id],
          );
          return result.rows[0];
        });
        if (dealer) dealers.push(dealer);
      }
      response.status(200).json({ dealers });
    } catch { response.status(500).json({ error: "No pudimos cargar los dealers asociados." }); }
  }

  async getContacts(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response);
      if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      if (!UUID.test(dealerId)) { response.status(400).json({ error: "Selecciona un dealer válido." }); return; }
      if (!await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const search = typeof request.query.search === "string" ? request.query.search.trim().slice(0, 120) : "";
      const channel = typeof request.query.channel === "string" ? request.query.channel.trim().toLowerCase() : "";
      const consent = typeof request.query.consentState === "string" ? request.query.consentState.trim().toLowerCase() : "";
      if (channel && !["messenger", "instagram", "whatsapp", "facebook"].includes(channel)) { response.status(400).json({ error: "El canal seleccionado no es válido." }); return; }
      if (consent && !["granted", "denied", "unknown"].includes(consent)) { response.status(400).json({ error: "El estado de consentimiento no es válido." }); return; }
      const rawLimit = Number(request.query.limit ?? 25), rawOffset = Number(request.query.offset ?? 0);
      const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;
      const offset = Number.isInteger(rawOffset) ? Math.max(rawOffset, 0) : 0;
      const sort = request.query.sort === "name" ? "name" : "recent";
      const data = await withTenant(this.pool, dealerId, async (client) => {
        const where = `c.tenant_id = $1::uuid
          AND ($2 = '' OR c.display_name ILIKE '%' || $2 || '%' OR c.phone ILIKE '%' || $2 || '%' OR c.email ILIKE '%' || $2 || '%' OR c.provider_contact_id ILIKE '%' || $2 || '%')
          AND ($3 = '' OR EXISTS (SELECT 1 FROM public.conversations AS fc WHERE fc.tenant_id = c.tenant_id AND fc.contact_id = c.id
            AND (($3 = 'facebook' AND lower(fc.channel) IN ('facebook', 'fb', 'messenger'))
              OR ($3 = 'instagram' AND lower(fc.channel) IN ('instagram', 'ig')) OR lower(fc.channel) = $3)))
          AND ($4 = '' OR c.consent_state = $4)`;
        const count = await client.query<{ total: number }>(
          "SELECT COUNT(*)::int AS total FROM public.contacts AS c WHERE " + where, [dealerId, search, channel, consent],
        );
        const order = sort === "name"
          ? "lower(NULLIF(trim(c.display_name), '')) ASC NULLS LAST, c.updated_at DESC, c.id"
          : "MAX(cv.last_activity) DESC NULLS LAST, c.updated_at DESC, c.id";
        const rows = await client.query<ContactRow>(
          `SELECT ${CONTACT_COLUMNS}, COUNT(DISTINCT cv.id)::int AS "conversationCount",
            MAX(cv.last_activity) AS "lastActivity",
            COALESCE(array_agg(DISTINCT cv.channel) FILTER (WHERE cv.channel IS NOT NULL), ARRAY[]::text[]) AS channels
           FROM public.contacts AS c LEFT JOIN public.conversations AS cv ON cv.contact_id = c.id AND cv.tenant_id = c.tenant_id
           WHERE ${where} GROUP BY c.id ORDER BY ${order} LIMIT $5 OFFSET $6`,
          [dealerId, search, channel, consent, limit, offset],
        );
        return { contacts: rows.rows, total: count.rows[0]?.total ?? 0 };
      });
      response.status(200).json({ ...data, limit, offset });
    } catch { if (!response.headersSent) response.status(500).json({ error: "No pudimos cargar los contactos." }); }
  }

  async createContacts(request: Request, response: Response): Promise<void> {
    try {
      const user = await dealerUser(this.pool, request, response);
      if (!user) return;
      const dealerId = typeof request.body?.dealerId === "string" ? request.body.dealerId : "";
      if (!UUID.test(dealerId)) { response.status(400).json({ error: "Selecciona un dealer válido." }); return; }
      if (!await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const parsed = parseContactInput(request.body);
      if (!parsed.value || parsed.error) { response.status(400).json({ error: parsed.error ?? "Revisa los datos del contacto." }); return; }
      const contactInput = parsed.value;
      if (!contactInput.displayName?.trim()) { response.status(400).json({ error: "Escribe el nombre del contacto." }); return; }
      if (!hasReachableAddress(contactInput)) { response.status(400).json({ error: "Añade un teléfono o correo para identificar el contacto." }); return; }
      const created = await withTenant(this.pool, dealerId, async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
        await lockContactIdentity(client, dealerId, contactInput);
        const duplicate = await duplicateContact(client, dealerId, contactInput);
        if (duplicate) return { duplicate };
        const result = await client.query<{ id: string }>(
          `INSERT INTO public.contacts (tenant_id, provider_contact_id, display_name, phone, email, preferred_language, consent_state)
           VALUES ($1::uuid, $2, $3, $4, $5, $6, 'unknown')
           RETURNING ${CONTACT_COLUMNS.replaceAll("c.", "")}`,
          [dealerId, `manual:${randomUUID()}`, contactInput.displayName, contactInput.phone ?? null, contactInput.email ?? null, contactInput.preferredLanguage ?? "unknown"],
        );
        const id = result.rows[0]?.id;
        if (!id) throw new Error("Contact creation did not return a record");
        const contact = await loadContactSummary(client, dealerId, id);
        if (!contact) throw new Error("Created contact could not be loaded");
        await auditContact(client, user, dealerId, "contact.created", contact.id, "Se creó el contacto manual.", request);
        return { contact };
      });
      if ("duplicate" in created) { response.status(409).json({ error: "Ya existe un contacto con ese teléfono o correo.", contactId: created.duplicate }); return; }
      response.status(201).json({ contact: created.contact });
    } catch (error) {
      if ((error as { code?: string })?.code === "23505") { response.status(409).json({ error: "Ya existe un contacto con esos datos." }); return; }
      if (!response.headersSent) response.status(500).json({ error: "No pudimos crear el contacto." });
    }
  }
}
