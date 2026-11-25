import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { Request, Response } from "express";
import type { DealerInvitationMailer } from "@/features/identity/infrastructure/email/smtp-dealer-invitation-mailer";
import type { MetaCapiTenantConfig } from "@/modules/control/infrastructure/meta-capi.config";

export type IdentityRouteOptions = {
  production: boolean;
  publicAppUrl?: string;
  invitationMailer?: DealerInvitationMailer;
  metaCapiDealers?: MetaCapiTenantConfig[];
  metaCapiEventName?: string;
  metaOAuthStart?: (tenantId: string) => string;
  redisPing?: () => Promise<string>;
};

const SESSION_COOKIE = "bdc_os_session";
export const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_FAILED_ATTEMPTS = 10;
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const failedAttempts = new Map<string, { count: number; resetAt: number }>();

export type IdentityUser = { id: string; email: string; display_name: string; account_type: "admin" | "user" };
export type Invitation = { id: string; tenant_id: string; email: string; display_name: string; dealer_name: string };
export type AdminDealerDirectoryEntry = { id: string; name: string | null; status: string; user_count: number; pending_invitation_count: number };

export async function loadAdminDealerDirectory(pool: Pool): Promise<AdminDealerDirectoryEntry[]> {
  const routes = await pool.query<{ dealer_id: string }>(
    "SELECT dealer_id::text AS dealer_id FROM public.list_tenant_route_ids() ORDER BY dealer_id",
  );
  if (routes.rows.length === 0) return [];
  const client = await pool.connect();
  const dealers: AdminDealerDirectoryEntry[] = [];
  try {
    for (const { dealer_id: dealerId } of routes.rows) {
      await client.query("BEGIN");
      try {
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [dealerId]);
        const result = await client.query<AdminDealerDirectoryEntry>(
          `SELECT t.dealer_id::text AS id, t.dealer_name AS name, t.status,
                  (SELECT COUNT(*)::int FROM public.user_tenant_memberships AS m WHERE m.tenant_id = t.dealer_id) AS user_count,
                  (SELECT COUNT(*)::int FROM public.dealer_invitations AS i
                    WHERE i.tenant_id = t.dealer_id AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS pending_invitation_count
             FROM public.tenants AS t WHERE t.dealer_id = $1`,
          [dealerId],
        );
        await client.query("COMMIT");
        if (result.rows[0]) dealers.push(result.rows[0]);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      }
    }
    return dealers;
  } finally { client.release(); }
}
export const INVITATION_TTL_HOURS = 72;

export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

export function invitationUrl(publicAppUrl: string, token: string): string {
  const origin = new URL(publicAppUrl);
  if (origin.protocol !== "https:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") {
    throw new Error("BDC_APP_URL must use HTTPS outside localhost");
  }
  const url = new URL("/auth/invitations/accept", origin);
  url.searchParams.set("token", token);
  return url.toString();
}

type AuditCategory = "dealers" | "users" | "invitations" | "settings" | "security" | "contacts" | "opportunities";
type AuditInput = {
  actor: IdentityUser;
  dealerId?: string | null;
  dealerName?: string | null;
  category: AuditCategory;
  action: string;
  summary: string;
  referenceId: string;
  entityId?: string | null;
};

export function auditReference(request: Request): string {
  const provided = request.get("x-correlation-id")?.trim();
  const reference = provided && /^[A-Za-z0-9._:-]{1,128}$/.test(provided) ? provided : randomUUID();
  request.res?.setHeader("X-Correlation-Id", reference);
  return reference;
}

export async function appendAudit(client: PoolClient, input: AuditInput): Promise<void> {
  await client.query(
    `INSERT INTO public.admin_audit_events
       (actor_user_id, actor_email, actor_name, target_tenant_id, dealer_name, category, action, outcome, summary, reference_id, entity_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'success', $8, $9, $10)`,
    [input.actor.id, input.actor.email, input.actor.display_name, input.dealerId ?? null,
      input.dealerName ?? null, input.category, input.action, input.summary, input.referenceId, input.entityId ?? null],
  );
}

export async function requireAdmin(pool: Pool, request: Request, response: Response): Promise<IdentityUser | undefined> {
  const user = await activeSession(pool, request);
  if (!user) {
    response.status(401).json({ error: "Inicia sesión para continuar." });
    return undefined;
  }
  if (user.account_type !== "admin") {
    response.status(403).json({ error: "Esta acción requiere una cuenta administradora." });
    return undefined;
  }
  return user;
}

export function cookieValue(request: Request): string | undefined {
  const cookieHeader = request.headers.cookie ?? "";
  const part = cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  return part ? decodeURIComponent(part.slice(SESSION_COOKIE.length + 1)) : undefined;
}

export function sessionCookie(token: string | undefined, production: boolean): string {
  const secure = production ? "; Secure" : "";
  return token
    ? `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`
    : `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

export function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function failureKey(request: Request, email: string): string {
  return `${request.ip ?? request.socket.remoteAddress ?? "unknown"}:${email}`;
}

export function rateLimited(request: Request, email: string): boolean {
  const current = failedAttempts.get(failureKey(request, email));
  if (!current) return false;
  if (current.resetAt <= Date.now()) {
    failedAttempts.delete(failureKey(request, email));
    return false;
  }
  return current.count >= MAX_FAILED_ATTEMPTS;
}

export function recordFailure(request: Request, email: string): void {
  const key = failureKey(request, email);
  const current = failedAttempts.get(key);
  if (!current || current.resetAt <= Date.now()) {
    failedAttempts.set(key, { count: 1, resetAt: Date.now() + FAILED_ATTEMPT_WINDOW_MS });
    return;
  }
  current.count += 1;
}

export async function activeSession(pool: Pool, request: Request): Promise<IdentityUser | undefined> {
  const token = cookieValue(request);
  if (!token || token.length > 256) return undefined;
  const result = await pool.query<IdentityUser>(
    `SELECT u.id::text, u.email, u.display_name, u.account_type
       FROM public.app_sessions AS s
       JOIN public.app_users AS u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'
      LIMIT 1`,
    [tokenDigest(token)],
  );
  return result.rows[0];
}
