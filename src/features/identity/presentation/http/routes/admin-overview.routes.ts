import express, { type Request, type Response } from "express";
import type { Pool, PoolClient } from "pg";
import { loadAdminDealerDirectory, requireAdmin, type IdentityRouteOptions } from "./route-helpers";

type AdminUserDirectoryEntry = {
  record_type: string;
  id: string;
  display_name: string;
  email: string;
  account_type: string;
  status: string;
  created_at: Date | string;
  expires_at: Date | string | null;
  dealers: unknown;
};

async function withPlatformAdmin<T>(pool: Pool, action: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.is_platform_admin', 'true', true)");
    const value = await action(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function createAdminOverviewRoutes(pool: Pool, options: IdentityRouteOptions): express.Router {
  const router = express.Router();
  router.get("/admin/system/health", async (request: Request, response: Response) => {
    try {
      if (!await requireAdmin(pool, request, response)) return;
      await pool.query("SELECT 1");

      let redisStatus: "healthy" | "unavailable" = "unavailable";
      try {
        redisStatus = await options.redisPing?.() === "PONG" ? "healthy" : "unavailable";
      } catch {
        redisStatus = "unavailable";
      }

      const services = {
        api: "healthy" as const,
        postgresql: "healthy" as const,
        redis: redisStatus,
      };
      response.status(200).json({
        overall: redisStatus === "healthy" ? "healthy" : "degraded",
        checked_at: new Date().toISOString(),
        services,
      });
    } catch {
      if (!response.headersSent) {
        response.status(503).json({ error: "No pudimos consultar el estado global del sistema." });
      }
    }
  });
  router.get("/admin/users", async (request: Request, response: Response) => {
    try {
      if (!await requireAdmin(pool, request, response)) return;
      const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const status = typeof request.query.status === "string" ? request.query.status : "";
      const accountType = typeof request.query.accountType === "string" ? request.query.accountType : "";
      const limitValue = Number(request.query.limit ?? 50);
      const offsetValue = Number(request.query.offset ?? 0);
      const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const validStatuses = ["active", "disabled", "invited", "pending", "expired"];
      if (search.length > 180 || (dealerId && !validUuid.test(dealerId))
          || (status && !validStatuses.includes(status)) || (accountType && !["admin", "user"].includes(accountType))
          || !Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100
          || !Number.isInteger(offsetValue) || offsetValue < 0 || offsetValue > 1000000) {
        response.status(400).json({ error: "Los filtros de usuarios no son válidos." });
        return;
      }

      const dealerDirectory = await loadAdminDealerDirectory(pool);
      const dealerNames = new Map(dealerDirectory.map((dealer) => [dealer.id, dealer.name] as const));
      const clauses: string[] = [];
      const values: unknown[] = [];
      const add = (sql: (index: number) => string, value: unknown) => { values.push(value); clauses.push(sql(values.length)); };
      if (search) add((i) => `(display_name ILIKE $${i} OR email ILIKE $${i} OR dealers::text ILIKE $${i})`, `%${search}%`);
      if (dealerId) add((i) => `EXISTS (SELECT 1 FROM jsonb_array_elements(dealers) AS dealer_entry(value) WHERE dealer_entry.value->>'id' = $${i})`, dealerId);
      if (status) add((i) => `status = $${i}`, status);
      if (accountType) add((i) => `account_type = $${i}`, accountType);
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const directoryCte = `
        user_entries AS (
          SELECT 'user'::text AS record_type, u.id::text AS id, u.display_name, u.email,
                 u.account_type, u.status, u.created_at, NULL::timestamptz AS expires_at,
                 COALESCE(jsonb_agg(jsonb_build_object('id', m.tenant_id::text, 'name', NULL::text)
                   ORDER BY m.tenant_id)
                   FILTER (WHERE m.tenant_id IS NOT NULL), '[]'::jsonb) AS dealers
            FROM public.app_users AS u
            LEFT JOIN public.user_tenant_memberships AS m ON m.user_id = u.id
           GROUP BY u.id
        ),
        invitation_entries AS (
          SELECT 'invitation'::text AS record_type, i.id::text AS id, i.display_name, i.email,
                 'user'::text AS account_type,
                 CASE WHEN i.expires_at <= now() THEN 'expired' ELSE 'pending' END AS status,
                 i.created_at, i.expires_at,
                 jsonb_build_array(jsonb_build_object('id', i.tenant_id::text, 'name', NULL::text)) AS dealers
            FROM public.dealer_invitations AS i
           WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL
        ),
        directory AS (
          SELECT * FROM user_entries
          UNION ALL
          SELECT * FROM invitation_entries
        )`;
      const directoryPage = await withPlatformAdmin(pool, async (client) => {
        const count = await client.query<{ total: string }>(`WITH ${directoryCte} SELECT COUNT(*)::text AS total FROM directory ${where}`, values);
        const entries = await client.query<AdminUserDirectoryEntry>(
          `WITH ${directoryCte}
           SELECT record_type, id, display_name, email, account_type, status, created_at, expires_at, dealers
             FROM directory ${where}
            ORDER BY created_at DESC, record_type ASC, id ASC
            LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
          [...values, limitValue, offsetValue],
        );
        return { total: Number(count.rows[0]?.total ?? 0), entries: entries.rows };
      });
      const mappedEntries = directoryPage.entries.map((entry) => ({
        ...entry,
        dealers: (Array.isArray(entry.dealers) ? entry.dealers as Array<{ id: string; name: string | null }> : [])
          .map((dealer) => ({ ...dealer, name: dealerNames.get(dealer.id) ?? null })),
      }));
      response.status(200).json({ entries: mappedEntries, total: directoryPage.total, limit: limitValue, offset: offsetValue });
    } catch {
      response.status(500).json({ error: "No pudimos cargar los usuarios de la plataforma." });
    }
  });
  router.get("/admin/audit", async (request: Request, response: Response) => {
    try {
      if (!await requireAdmin(pool, request, response)) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const actor = typeof request.query.actor === "string" ? request.query.actor.trim() : "";
      const category = typeof request.query.category === "string" ? request.query.category : "";
      const from = typeof request.query.from === "string" ? request.query.from : "";
      const to = typeof request.query.to === "string" ? request.query.to : "";
      const search = typeof request.query.search === "string" ? request.query.search.trim() : "";
      const limitValue = Number(request.query.limit ?? 50);
      const offsetValue = Number(request.query.offset ?? 0);
      const validUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
      const validDate = (value: string) => { if (!value) return true; if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; };
      if ((dealerId && !validUuid.test(dealerId)) || (category && !["dealers", "users", "invitations", "settings", "security", "contacts"].includes(category))
          || actor.length > 254 || search.length > 180 || !validDate(from) || !validDate(to)
          || (from && to && from > to) || !Number.isInteger(limitValue) || limitValue < 1 || limitValue > 100
          || !Number.isInteger(offsetValue) || offsetValue < 0 || offsetValue > 1000000) {
        response.status(400).json({ error: "Los filtros de auditoría no son válidos." });
        return;
      }
      const clauses: string[] = [];
      const values: unknown[] = [];
      const add = (sql: (index: number) => string, value: unknown) => { values.push(value); clauses.push(sql(values.length)); };
      if (dealerId) add((i) => `target_tenant_id = $${i}::uuid`, dealerId);
      if (actor) add((i) => `(lower(actor_email) LIKE lower($${i}) OR lower(actor_name) LIKE lower($${i}))`, `%${actor}%`);
      if (category) add((i) => `category = $${i}`, category);
      if (from) add((i) => `created_at >= $${i}::date`, from);
      if (to) add((i) => `created_at < ($${i}::date + interval '1 day')`, to);
      if (search) add((i) => `concat_ws(' ', actor_name, actor_email, dealer_name, action, summary, reference_id) ILIKE $${i}`, `%${search}%`);
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const count = await pool.query<{ total: string }>(`SELECT COUNT(*)::text AS total FROM public.admin_audit_events ${where}`, values);
      const pageValues = [...values, limitValue, offsetValue];
      const events = await pool.query(
        `SELECT id::text, actor_email, actor_name, target_tenant_id::text AS dealer_id, dealer_name,
                category, action, outcome, summary, reference_id, created_at
           FROM public.admin_audit_events ${where}
          ORDER BY created_at DESC, id DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
        pageValues,
      );
      response.status(200).json({ events: events.rows, total: Number(count.rows[0]?.total ?? 0), limit: limitValue, offset: offsetValue });
    } catch {
      response.status(500).json({ error: "No pudimos cargar la auditoría administrativa." });
    }
  });
  return router;
}
