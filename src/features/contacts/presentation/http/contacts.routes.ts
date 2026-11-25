import { randomUUID } from "node:crypto";
import express, { type Request, type Response } from "express";
import type { Pool, PoolClient } from "pg";
import { activeSession, appendAudit, auditReference, validEmail, type IdentityUser } from "@/features/identity/presentation/http/routes/route-helpers";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHONE = /^\+?[0-9().\-\s]{7,40}$/;
type Tenant = { id: string; name: string | null };
type ContactRow = {
  id: string; dealerId: string; providerContactId: string; displayName: string | null; source: "meta" | "manual";
  phone: string | null; email: string | null; preferredLanguage: string; consentState: string;
  createdAt: Date | string; updatedAt: Date | string; conversationCount: number;
  lastActivity: Date | string | null; channels: string[];
};
type ContactInput = { displayName?: string | null; phone?: string | null; email?: string | null; preferredLanguage?: string | null };
type ContactActivity = { id: string; action: string; actorName: string; summary: string; createdAt: Date | string };
type InboxConversationRow = {
  id: string; dealerId: string; contactId: string; contactName: string | null; phone: string | null;
  channel: string; owner: string | null; state: string; lastActivity: Date | string;
  lastMessage: string | null; lastDirection: string | null; assignedUserId: string | null;
  assignedUserName: string | null; isRead: boolean;
};

async function dealerUser(pool: Pool, request: Request, response: Response): Promise<IdentityUser | undefined> {
  const user = await activeSession(pool, request);
  if (!user) { response.status(401).json({ error: "Inicia sesión para continuar." }); return undefined; }
  if (user.account_type !== "user") { response.status(403).json({ error: "Esta sección requiere una cuenta de dealer." }); return undefined; }
  return user;
}

async function isMember(pool: Pool, userId: string, dealerId: string): Promise<boolean> {
  if (!UUID.test(dealerId)) return false;
  const isMember = await withUser(pool, userId, async (client) => {
    const membership = await client.query(
      "SELECT 1 FROM public.user_tenant_memberships WHERE user_id = $1 AND tenant_id = $2::uuid",
      [userId, dealerId],
    );
    return membership.rowCount === 1;
  });
  if (!isMember) return false;
  return withTenant(pool, dealerId, async (client) => {
    const tenant = await client.query(
      "SELECT 1 FROM public.tenants WHERE dealer_id = $1::uuid AND status = 'active'", [dealerId],
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

async function withUser<T>(pool: Pool, userId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.user_id', $1, true)", [userId]);
    const value = await action(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function optionalText(value: unknown, maximum: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length > maximum) return undefined;
  return text || null;
}

function parseContactInput(body: unknown): { value?: ContactInput; error?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Revisa los datos del contacto." };
  const input = body as Record<string, unknown>;
  const value: ContactInput = {};
  if (Object.hasOwn(input, "displayName")) {
    const name = optionalText(input.displayName, 120);
    if (name === undefined || (typeof input.displayName === "string" && input.displayName.trim().length > 120)) return { error: "El nombre debe tener hasta 120 caracteres." };
    value.displayName = name;
  }
  if (Object.hasOwn(input, "phone")) {
    const phone = optionalText(input.phone, 40);
    if (phone === undefined || (phone && !PHONE.test(phone))) return { error: "Escribe un teléfono válido." };
    value.phone = phone;
  }
  if (Object.hasOwn(input, "email")) {
    const email = optionalText(input.email, 254);
    if (email === undefined || (email && !validEmail(email))) return { error: "Escribe un correo válido." };
    value.email = email?.toLowerCase() ?? null;
  }
  if (Object.hasOwn(input, "preferredLanguage")) {
    const language = optionalText(input.preferredLanguage, 16);
    if (language === undefined || (language && language !== "unknown" && !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language))) return { error: "Selecciona un idioma válido." };
    value.preferredLanguage = language?.toLowerCase() ?? null;
  }
  return { value };
}

function hasReachableAddress(contact: Pick<ContactInput, "phone" | "email">): boolean {
  return Boolean(contact.phone || contact.email);
}

async function duplicateContact(client: PoolClient, dealerId: string, input: ContactInput, exceptId?: string): Promise<string | undefined> {
  const result = await client.query<{ id: string }>(
    `SELECT id::text AS id FROM public.contacts
      WHERE tenant_id = $1::uuid AND ($4::uuid IS NULL OR id <> $4::uuid)
        AND (($2::text IS NOT NULL AND lower(email) = lower($2))
          OR ($3::text IS NOT NULL AND regexp_replace(phone, '\\D', '', 'g') = regexp_replace($3, '\\D', '', 'g')))
      ORDER BY updated_at DESC LIMIT 1`,
    [dealerId, input.email ?? null, input.phone ?? null, exceptId ?? null],
  );
  return result.rows[0]?.id;
}

async function lockContactIdentity(client: PoolClient, dealerId: string, input: ContactInput): Promise<void> {
  const keys = [
    input.email ? `contact:${dealerId}:email:${input.email.toLowerCase()}` : null,
    input.phone ? `contact:${dealerId}:phone:${input.phone.replace(/\D/g, "")}` : null,
  ].filter((value): value is string => Boolean(value)).sort();
  for (const key of keys) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

async function auditContact(client: PoolClient, actor: IdentityUser, dealerId: string, action: string, contactId: string, summary: string, request: Request): Promise<void> {
  const tenant = await client.query<{ dealer_name: string | null }>(
    "SELECT dealer_name FROM public.tenants WHERE dealer_id = $1::uuid", [dealerId],
  );
  await appendAudit(client, {
    actor, dealerId, dealerName: tenant.rows[0]?.dealer_name ?? null, category: "contacts", action,
    summary, referenceId: auditReference(request), entityId: contactId,
  });
}

const CONTACT_COLUMNS = `c.id::text AS id, c.tenant_id::text AS "dealerId", c.provider_contact_id AS "providerContactId",
  c.display_name AS "displayName", CASE WHEN c.provider_contact_id LIKE 'manual:%' THEN 'manual' ELSE 'meta' END AS source,
  c.phone, c.email, c.preferred_language AS "preferredLanguage", c.consent_state AS "consentState",
  c.created_at AS "createdAt", c.updated_at AS "updatedAt"`;

async function loadContactSummary(client: PoolClient, dealerId: string, contactId: string): Promise<ContactRow | undefined> {
  const result = await client.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS}, COUNT(DISTINCT cv.id)::int AS "conversationCount", MAX(cv.last_activity) AS "lastActivity",
       COALESCE(array_agg(DISTINCT cv.channel) FILTER (WHERE cv.channel IS NOT NULL), ARRAY[]::text[]) AS channels
       FROM public.contacts AS c LEFT JOIN public.conversations AS cv ON cv.contact_id = c.id AND cv.tenant_id = c.tenant_id
      WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid GROUP BY c.id`, [contactId, dealerId],
  );
  return result.rows[0];
}

export function createContactsRouter(pool: Pool): express.Router {
  const router = express.Router();

  router.get("/contacts/dealers", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response);
      if (!user) return;
      const memberships = await withUser(pool, user.id, (client) => client.query<{ tenant_id: string }>(
        "SELECT tenant_id::text FROM public.user_tenant_memberships WHERE user_id = $1 ORDER BY tenant_id", [user.id],
      ));
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
      const channel = typeof request.query.channel === "string" ? request.query.channel.trim().toLowerCase() : "";
      const consent = typeof request.query.consentState === "string" ? request.query.consentState.trim().toLowerCase() : "";
      if (channel && !["messenger", "instagram", "whatsapp", "facebook"].includes(channel)) { response.status(400).json({ error: "El canal seleccionado no es válido." }); return; }
      if (consent && !["granted", "denied", "unknown"].includes(consent)) { response.status(400).json({ error: "El estado de consentimiento no es válido." }); return; }
      const rawLimit = Number(request.query.limit ?? 25), rawOffset = Number(request.query.offset ?? 0);
      const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 25;
      const offset = Number.isInteger(rawOffset) ? Math.max(rawOffset, 0) : 0;
      const sort = request.query.sort === "name" ? "name" : "recent";
      const data = await withTenant(pool, dealerId, async (client) => {
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
  });

  router.post("/contacts", async (request: Request, response: Response) => {
    try {
      const user = await dealerUser(pool, request, response);
      if (!user) return;
      const dealerId = typeof request.body?.dealerId === "string" ? request.body.dealerId : "";
      if (!UUID.test(dealerId)) { response.status(400).json({ error: "Selecciona un dealer válido." }); return; }
      if (!await isMember(pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const parsed = parseContactInput(request.body);
      if (!parsed.value || parsed.error) { response.status(400).json({ error: parsed.error ?? "Revisa los datos del contacto." }); return; }
      const contactInput = parsed.value;
      if (!contactInput.displayName?.trim()) { response.status(400).json({ error: "Escribe el nombre del contacto." }); return; }
      if (!hasReachableAddress(contactInput)) { response.status(400).json({ error: "Añade un teléfono o correo para identificar el contacto." }); return; }
      const created = await withTenant(pool, dealerId, async (client) => {
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
  });

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
             m.id::text AS "messageId", m.direction, m.sender_type AS "senderType", m.content, m.created_at AS "createdAt"
           FROM (SELECT * FROM public.conversations WHERE tenant_id = $1::uuid AND contact_id = $2::uuid ORDER BY last_activity DESC LIMIT 20) AS cv
           LEFT JOIN LATERAL (SELECT id, direction, sender_type, content, created_at FROM public.messages
             WHERE tenant_id = $1::uuid AND conversation_id = cv.id ORDER BY created_at DESC LIMIT 10) AS m ON true
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
          if (row.messageId) conversation.messages.push({ id: row.messageId, direction: row.direction, senderType: row.senderType, content: row.content, createdAt: row.createdAt });
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
