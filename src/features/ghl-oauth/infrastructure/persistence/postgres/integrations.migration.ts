import type { Pool } from "pg";

export const CREATE_INTEGRATIONS_TABLE_SQL = `
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider = 'ghl'),
  encrypted_access_token TEXT NOT NULL,
  encrypted_refresh_token TEXT,
  scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  health_state TEXT NOT NULL DEFAULT 'healthy'
    CHECK (health_state IN ('healthy', 'degraded', 'revoked', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT integrations_tenant_provider_uq UNIQUE (tenant_id, provider)
);

CREATE INDEX IF NOT EXISTS integrations_tenant_idx ON public.integrations (tenant_id);
CREATE INDEX IF NOT EXISTS integrations_provider_health_idx
  ON public.integrations (provider, health_state);
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
