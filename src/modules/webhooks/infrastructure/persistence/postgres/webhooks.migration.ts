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
    CHECK (status IN ('received', 'processed', 'failed')),
  error_message TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  CONSTRAINT raw_webhooks_tenant_external_uq UNIQUE (tenant_id, external_id)
);

CREATE INDEX IF NOT EXISTS raw_webhooks_tenant_received_idx
  ON public.raw_webhooks (tenant_id, received_at DESC);

CREATE INDEX IF NOT EXISTS raw_webhooks_location_idx
  ON public.raw_webhooks (location_id, received_at DESC);

ALTER TABLE public.raw_webhooks ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS raw_webhooks_isolation ON public.raw_webhooks;
CREATE POLICY raw_webhooks_isolation ON public.raw_webhooks
  AS RESTRICTIVE
  FOR ALL
  TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

CREATE OR REPLACE FUNCTION public.resolve_ghl_tenant_id(p_location_id TEXT)
RETURNS UUID
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT dealer_id
    FROM public.tenants
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
