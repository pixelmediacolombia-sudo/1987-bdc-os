import type { Pool } from "pg";

export const CREATE_ADMIN_AUDIT_SQL = `
CREATE TABLE IF NOT EXISTS public.admin_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id UUID,
  actor_email TEXT NOT NULL,
  actor_name TEXT NOT NULL,
  target_tenant_id UUID,
  entity_id TEXT,
  dealer_name TEXT,
  category TEXT NOT NULL CHECK (category IN ('dealers', 'users', 'invitations', 'settings', 'security', 'contacts', 'opportunities')),
  action TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure')),
  summary TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_audit_events DROP CONSTRAINT IF EXISTS admin_audit_events_category_check;
ALTER TABLE public.admin_audit_events ADD CONSTRAINT admin_audit_events_category_check
  CHECK (category IN ('dealers', 'users', 'invitations', 'settings', 'security', 'contacts', 'opportunities'));
ALTER TABLE public.admin_audit_events ADD COLUMN IF NOT EXISTS entity_id TEXT;

CREATE INDEX IF NOT EXISTS admin_audit_events_created_idx
  ON public.admin_audit_events (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS admin_audit_events_dealer_idx
  ON public.admin_audit_events (target_tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_events_actor_idx
  ON public.admin_audit_events (lower(actor_email), created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_events_category_idx
  ON public.admin_audit_events (category, created_at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_events_entity_idx
  ON public.admin_audit_events (target_tenant_id, category, entity_id, created_at DESC, id DESC)
  WHERE entity_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.prevent_admin_audit_mutation()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION 'Admin audit events are append-only';
END;
$function$;

DROP TRIGGER IF EXISTS admin_audit_events_immutable ON public.admin_audit_events;
CREATE TRIGGER admin_audit_events_immutable
  BEFORE UPDATE OR DELETE ON public.admin_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.prevent_admin_audit_mutation();
`;

export async function ensureAdminAuditTable(pool: Pool): Promise<void> {
  await pool.query(CREATE_ADMIN_AUDIT_SQL);
}
