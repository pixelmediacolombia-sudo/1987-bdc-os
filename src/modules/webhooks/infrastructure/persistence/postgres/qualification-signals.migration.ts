import type { Pool } from "pg";

export const CREATE_QUALIFICATION_SIGNAL_TABLES_SQL = `
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS ctwa_clid TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_source_id TEXT,
  ADD COLUMN IF NOT EXISTS ctwa_captured_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS contacts_ctwa_clid_idx
  ON public.contacts (ctwa_clid)
  WHERE ctwa_clid IS NOT NULL;

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS meta_dataset_id TEXT,
  ADD COLUMN IF NOT EXISTS encrypted_meta_access_token TEXT,
  ADD COLUMN IF NOT EXISTS meta_event_name TEXT NOT NULL DEFAULT 'LeadSubmitted',
  ADD COLUMN IF NOT EXISTS meta_capi_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS meta_test_event_code TEXT;

ALTER TABLE public.tenants
  ALTER COLUMN meta_event_name SET DEFAULT 'LeadSubmitted';

CREATE TABLE IF NOT EXISTS public.capi_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  ledger_entry_id UUID NOT NULL REFERENCES public.objectives(id) ON DELETE CASCADE,
  event_name TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_time TIMESTAMPTZ NOT NULL,
  payload_sent JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'abandoned')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  fbtrace_id TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_token TEXT,
  claimed_at TIMESTAMPTZ,
  event_match_quality NUMERIC,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT capi_event_dealer_event_uq UNIQUE (dealer_id, event_id)
);

ALTER TABLE public.capi_events
  DROP CONSTRAINT IF EXISTS capi_events_status_check;
ALTER TABLE public.capi_events
  ADD CONSTRAINT capi_events_status_check
  CHECK (status IN ('pending', 'sent', 'failed', 'abandoned', 'skipped_no_attribution'));

ALTER TABLE public.capi_events
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS claim_token TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS event_match_quality NUMERIC;

CREATE INDEX IF NOT EXISTS capi_events_pending_idx
  ON public.capi_events (dealer_id, status, next_attempt_at, created_at);

ALTER TABLE public.capi_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capi_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capi_events_dealer_isolation ON public.capi_events;
CREATE POLICY capi_events_dealer_isolation ON public.capi_events
  FOR ALL TO PUBLIC
  USING (dealer_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (dealer_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

CREATE TABLE IF NOT EXISTS public.tenant_processing_routes (
  dealer_id UUID PRIMARY KEY REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Backfill only identifiers already present in trusted child records. Directly
-- scanning public.tenants here is ineffective because FORCE RLS hides rows
-- without app.tenant_id; do not weaken that policy for migrations.
INSERT INTO public.tenant_processing_routes (dealer_id)
SELECT tenant_id FROM public.user_tenant_memberships
UNION
SELECT tenant_id FROM public.dealer_invitations
ON CONFLICT (dealer_id) DO NOTHING;
DO $backfill_legacy_routes$
BEGIN
  IF to_regclass('public.tenant_location_routes') IS NOT NULL THEN
    EXECUTE 'INSERT INTO public.tenant_processing_routes (dealer_id)
             SELECT dealer_id FROM public.tenant_location_routes
             ON CONFLICT (dealer_id) DO NOTHING';
  END IF;
END;
$backfill_legacy_routes$;
CREATE OR REPLACE FUNCTION public.sync_tenant_processing_route()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  INSERT INTO public.tenant_processing_routes (dealer_id) VALUES (NEW.dealer_id)
  ON CONFLICT (dealer_id) DO NOTHING;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS tenants_sync_processing_route ON public.tenants;
CREATE TRIGGER tenants_sync_processing_route AFTER INSERT ON public.tenants
FOR EACH ROW EXECUTE FUNCTION public.sync_tenant_processing_route();
REVOKE ALL ON TABLE public.tenant_processing_routes FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.list_tenant_route_ids()
RETURNS TABLE(dealer_id UUID)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT route.dealer_id FROM public.tenant_processing_routes AS route;
$$;

CREATE OR REPLACE FUNCTION public.list_qualification_signal_dealers()
RETURNS TABLE(dealer_id UUID)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT route.dealer_id FROM public.list_tenant_route_ids() AS route;
$$;

REVOKE ALL ON FUNCTION public.list_tenant_route_ids() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_qualification_signal_dealers() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_tenant_route_ids() TO bdc;
GRANT EXECUTE ON FUNCTION public.list_qualification_signal_dealers() TO bdc;
`;

export async function ensureQualificationSignalTables(pool: Pool): Promise<void> {
  await pool.query("BEGIN");
  try {
    await pool.query(CREATE_QUALIFICATION_SIGNAL_TABLES_SQL);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
