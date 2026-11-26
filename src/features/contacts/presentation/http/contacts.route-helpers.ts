import express, { type Request, type Response } from "express";
import type { Pool, PoolClient } from "pg";
import { activeSession, appendAudit, auditReference, validEmail, type IdentityUser } from "@/features/identity/presentation/http/routes/route-helpers";
export { validEmail } from "@/features/identity/presentation/http/routes/route-helpers";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PHONE = /^\+?[0-9().\-\s]{7,40}$/;
export type Tenant = { id: string; name: string | null };
export type ContactRow = {
  id: string; dealerId: string; providerContactId: string; displayName: string | null; source: "meta" | "manual";
  phone: string | null; email: string | null; preferredLanguage: string; consentState: string;
  createdAt: Date | string; updatedAt: Date | string; conversationCount: number;
  lastActivity: Date | string | null; channels: string[];
};
export type ContactInput = { displayName?: string | null; phone?: string | null; email?: string | null; preferredLanguage?: string | null };
export type ContactActivity = { id: string; action: string; actorName: string; summary: string; createdAt: Date | string };
export type InboxConversationRow = {
  id: string; dealerId: string; contactId: string; contactName: string | null; phone: string | null;
  channel: string; owner: string | null; state: string; lastActivity: Date | string;
  lastMessage: string | null; lastDirection: string | null; assignedUserId: string | null;
  assignedUserName: string | null; isRead: boolean;
};

export async function dealerUser(pool: Pool, request: Request, response: Response): Promise<IdentityUser | undefined> {
  const user = await activeSession(pool, request);
  if (!user) { response.status(401).json({ error: "Inicia sesión para continuar." }); return undefined; }
  if (user.account_type !== "user") { response.status(403).json({ error: "Esta sección requiere una cuenta de dealer." }); return undefined; }
  return user;
}

export async function isMember(pool: Pool, userId: string, dealerId: string): Promise<boolean> {
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

export async function withTenant<T>(pool: Pool, tenantId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
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

export async function withUser<T>(pool: Pool, userId: string, action: (client: PoolClient) => Promise<T>): Promise<T> {
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

export function optionalText(value: unknown, maximum: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length > maximum) return undefined;
  return text || null;
}

export function parseContactInput(body: unknown): { value?: ContactInput; error?: string } {
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

export function hasReachableAddress(contact: Pick<ContactInput, "phone" | "email">): boolean {
  return Boolean(contact.phone || contact.email);
}

export async function duplicateContact(client: PoolClient, dealerId: string, input: ContactInput, exceptId?: string): Promise<string | undefined> {
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

export async function lockContactIdentity(client: PoolClient, dealerId: string, input: ContactInput): Promise<void> {
  const keys = [
    input.email ? `contact:${dealerId}:email:${input.email.toLowerCase()}` : null,
    input.phone ? `contact:${dealerId}:phone:${input.phone.replace(/\D/g, "")}` : null,
  ].filter((value): value is string => Boolean(value)).sort();
  for (const key of keys) await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [key]);
}

export async function auditContact(client: PoolClient, actor: IdentityUser, dealerId: string, action: string, contactId: string, summary: string, request: Request): Promise<void> {
  const tenant = await client.query<{ dealer_name: string | null }>(
    "SELECT dealer_name FROM public.tenants WHERE dealer_id = $1::uuid", [dealerId],
  );
  await appendAudit(client, {
    actor, dealerId, dealerName: tenant.rows[0]?.dealer_name ?? null, category: "contacts", action,
    summary, referenceId: auditReference(request), entityId: contactId,
  });
}

export const CONTACT_COLUMNS = `c.id::text AS id, c.tenant_id::text AS "dealerId", c.provider_contact_id AS "providerContactId",
  c.display_name AS "displayName", CASE WHEN c.provider_contact_id LIKE 'manual:%' THEN 'manual' ELSE 'meta' END AS source,
  c.phone, c.email, c.preferred_language AS "preferredLanguage", c.consent_state AS "consentState",
  c.created_at AS "createdAt", c.updated_at AS "updatedAt"`;

export async function loadContactSummary(client: PoolClient, dealerId: string, contactId: string): Promise<ContactRow | undefined> {
  const result = await client.query<ContactRow>(
    `SELECT ${CONTACT_COLUMNS}, COUNT(DISTINCT cv.id)::int AS "conversationCount", MAX(cv.last_activity) AS "lastActivity",
       COALESCE(array_agg(DISTINCT cv.channel) FILTER (WHERE cv.channel IS NOT NULL), ARRAY[]::text[]) AS channels
       FROM public.contacts AS c LEFT JOIN public.conversations AS cv ON cv.contact_id = c.id AND cv.tenant_id = c.tenant_id
      WHERE c.id = $1::uuid AND c.tenant_id = $2::uuid GROUP BY c.id`, [contactId, dealerId],
  );
  return result.rows[0];
}

