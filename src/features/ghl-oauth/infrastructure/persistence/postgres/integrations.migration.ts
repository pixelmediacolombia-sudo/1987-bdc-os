import type { Pool } from "pg";

export const CREATE_INTEGRATIONS_TABLE_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'ghl'),
  ghl_location_id TEXT,
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  access_token_expires_at TIMESTAMPTZ,
  health_state TEXT NOT NULL DEFAULT 'healthy'
    CHECK (health_state IN ('healthy', 'degraded', 'revoked', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integrations_tenant_provider_uq UNIQUE (tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS integrations_tenant_idx ON public.integrations (tenant_id);
CREATE INDEX IF NOT EXISTS integrations_provider_health_idx
  ON public.integrations (provider, health_state);

ALTER TABLE public.integrations ADD COLUMN IF NOT EXISTS ghl_location_id TEXT;
ALTER TABLE public.integrations ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMPTZ;

ALTER TABLE public.integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integrations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integrations_tenant_isolation ON public.integrations;
CREATE POLICY integrations_tenant_isolation ON public.integrations
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

CREATE TABLE IF NOT EXISTS public.integration_token_audits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  integration_id UUID REFERENCES public.integrations(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('token_refreshed', 'token_refresh_failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS integration_token_audits_tenant_created_idx
  ON public.integration_token_audits (tenant_id, created_at DESC);

ALTER TABLE public.integration_token_audits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_token_audits FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS integration_token_audits_tenant_isolation ON public.integration_token_audits;
CREATE POLICY integration_token_audits_tenant_isolation ON public.integration_token_audits
  AS PERMISSIVE
  FOR ALL
  TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));
`;

export async function ensureIntegrationsTable(pool: Pool): Promise<void> {
  await pool.query("BEGIN");
  try {
    await pool.query(CREATE_INTEGRATIONS_TABLE_SQL);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
