import type { Pool } from "pg";

export const CREATE_WEBHOOKS_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS public.raw_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  location_id TEXT NOT NULL,
  signature TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'policy_pending', 'policy_applied', 'suppression_applied', 'processed', 'failed')),
  suppression_required BOOLEAN NOT NULL DEFAULT false,
  stage_claim TEXT,
  stage_claimed_at TIMESTAMPTZ,
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT raw_webhooks_tenant_external_uq UNIQUE (tenant_id, external_id)
);

ALTER TABLE public.raw_webhooks
  ADD COLUMN IF NOT EXISTS suppression_required BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE public.raw_webhooks
  ADD COLUMN IF NOT EXISTS stage_claim TEXT;

ALTER TABLE public.raw_webhooks
  ADD COLUMN IF NOT EXISTS stage_claimed_at TIMESTAMPTZ;

ALTER TABLE public.raw_webhooks
  DROP CONSTRAINT IF EXISTS raw_webhooks_status_check;

ALTER TABLE public.raw_webhooks
  ADD CONSTRAINT raw_webhooks_status_check
  CHECK (status IN ('received', 'policy_pending', 'policy_applied', 'suppression_applied', 'processed', 'failed'));

CREATE INDEX IF NOT EXISTS raw_webhooks_tenant_received_idx
  ON public.raw_webhooks (tenant_id, received_at DESC);

CREATE INDEX IF NOT EXISTS raw_webhooks_location_idx
  ON public.raw_webhooks (location_id, received_at DESC);

CREATE TABLE IF NOT EXISTS public.outbound_message_registry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  semantic_hash TEXT NOT NULL,
  attempt_id UUID NOT NULL DEFAULT gen_random_uuid(),
  provider_message_id TEXT,
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'sent', 'failed', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '5 minutes'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT outbound_registry_attempt_uq UNIQUE (tenant_id, attempt_id)
);

-- Migrate installations created before outbound attempts became first-class.
ALTER TABLE public.outbound_message_registry
  DROP CONSTRAINT IF EXISTS outbound_registry_semantic_uq;

ALTER TABLE public.outbound_message_registry
  ADD COLUMN IF NOT EXISTS attempt_id UUID;
UPDATE public.outbound_message_registry
   SET attempt_id = gen_random_uuid()
 WHERE attempt_id IS NULL;
ALTER TABLE public.outbound_message_registry
  ALTER COLUMN attempt_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN attempt_id SET NOT NULL;

ALTER TABLE public.outbound_message_registry
  ADD COLUMN IF NOT EXISTS status TEXT;
UPDATE public.outbound_message_registry
   SET status = CASE WHEN provider_message_id IS NULL THEN 'reserved' ELSE 'sent' END
 WHERE status IS NULL;
ALTER TABLE public.outbound_message_registry
  ALTER COLUMN status SET DEFAULT 'reserved',
  ALTER COLUMN status SET NOT NULL;

ALTER TABLE public.outbound_message_registry
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
UPDATE public.outbound_message_registry
   SET expires_at = created_at + interval '5 minutes'
 WHERE expires_at IS NULL;
ALTER TABLE public.outbound_message_registry
  ALTER COLUMN expires_at SET DEFAULT (now() + interval '5 minutes'),
  ALTER COLUMN expires_at SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_registry_attempt_uq'
       AND conrelid = 'public.outbound_message_registry'::regclass
  ) THEN
    ALTER TABLE public.outbound_message_registry
      ADD CONSTRAINT outbound_registry_attempt_uq UNIQUE (tenant_id, attempt_id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'outbound_registry_status_check'
       AND conrelid = 'public.outbound_message_registry'::regclass
  ) THEN
    ALTER TABLE public.outbound_message_registry
      ADD CONSTRAINT outbound_registry_status_check
      CHECK (status IN ('reserved', 'sent', 'failed', 'expired'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS outbound_registry_provider_idx
  ON public.outbound_message_registry (tenant_id, contact_id, provider_message_id);

CREATE INDEX IF NOT EXISTS outbound_registry_reservation_idx
  ON public.outbound_message_registry (tenant_id, contact_id, status, expires_at);

ALTER TABLE public.outbound_message_registry ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.outbound_message_registry FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbound_registry_tenant_isolation ON public.outbound_message_registry;
CREATE POLICY outbound_registry_tenant_isolation ON public.outbound_message_registry
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE public.raw_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.raw_webhooks FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS raw_webhooks_isolation ON public.raw_webhooks;
CREATE POLICY raw_webhooks_isolation ON public.raw_webhooks
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

-- Bootstrap-only routing metadata. This table contains identifiers only and is
-- intentionally separate from tenant-scoped business data because tenants is
-- FORCE ROW LEVEL SECURITY and cannot be queried before app.tenant_id exists.
CREATE TABLE IF NOT EXISTS public.tenant_location_routes (
  ghl_location_id TEXT PRIMARY KEY,
  dealer_id UUID NOT NULL UNIQUE REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION public.sync_tenant_location_route()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.tenant_location_routes (ghl_location_id, dealer_id)
  VALUES (NEW.ghl_location_id, NEW.dealer_id)
  ON CONFLICT (ghl_location_id) DO UPDATE
    SET dealer_id = EXCLUDED.dealer_id,
        updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS tenants_sync_location_route ON public.tenants;
CREATE TRIGGER tenants_sync_location_route
AFTER INSERT OR UPDATE OF ghl_location_id ON public.tenants
FOR EACH ROW EXECUTE FUNCTION public.sync_tenant_location_route();

REVOKE ALL ON TABLE public.tenant_location_routes FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.resolve_ghl_tenant_id(p_location_id TEXT)
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT dealer_id
    FROM public.tenant_location_routes
   WHERE ghl_location_id = p_location_id
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.resolve_ghl_tenant_id(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_ghl_tenant_id(TEXT) TO bdc;
`;

export async function ensureWebhookTables(pool: Pool): Promise<void> {
  await pool.query("BEGIN");
  try {
    await pool.query(CREATE_WEBHOOKS_TABLE_SQL);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
