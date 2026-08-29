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
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS claim_token TEXT,
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS event_match_quality NUMERIC;

CREATE INDEX IF NOT EXISTS capi_events_pending_idx
  ON public.capi_events (dealer_id, status, next_attempt_at, created_at);

CREATE TABLE IF NOT EXISTS public.ghl_qualification_tag_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dealer_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  ghl_contact_id TEXT NOT NULL,
  ledger_entry_id UUID NOT NULL REFERENCES public.objectives(id) ON DELETE CASCADE,
  tag TEXT NOT NULL DEFAULT 'qualification_completed',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sent', 'failed', 'abandoned')),
  attempts INT NOT NULL DEFAULT 0,
  last_error TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claim_token TEXT,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ghl_qualification_tag_event_uq UNIQUE (dealer_id, ledger_entry_id)
);

CREATE INDEX IF NOT EXISTS ghl_qualification_tag_pending_idx
  ON public.ghl_qualification_tag_events (dealer_id, status, next_attempt_at, created_at);

ALTER TABLE public.capi_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.capi_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS capi_events_dealer_isolation ON public.capi_events;
CREATE POLICY capi_events_dealer_isolation ON public.capi_events
  FOR ALL TO PUBLIC
  USING (dealer_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (dealer_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE public.ghl_qualification_tag_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ghl_qualification_tag_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ghl_qualification_tag_events_dealer_isolation ON public.ghl_qualification_tag_events;
CREATE POLICY ghl_qualification_tag_events_dealer_isolation ON public.ghl_qualification_tag_events
  FOR ALL TO PUBLIC
  USING (dealer_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (dealer_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

CREATE OR REPLACE FUNCTION public.list_qualification_signal_dealers()
RETURNS TABLE(dealer_id UUID)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  -- Enumerate only bootstrap routing metadata here. The worker applies the
  -- tenant-scoped qualification_signal_enabled check when claiming events;
  -- joining FORCE RLS tenants without app.tenant_id would hide every route.
  SELECT route.dealer_id
    FROM public.tenant_location_routes AS route;
$$;

REVOKE ALL ON FUNCTION public.list_qualification_signal_dealers() FROM PUBLIC;
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
