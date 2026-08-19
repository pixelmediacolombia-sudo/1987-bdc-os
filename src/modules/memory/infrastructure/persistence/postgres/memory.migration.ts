import type { Pool } from "pg";

export const CREATE_MEMORY_CONTRACTS_SQL = `
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/Bogota';
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS policy_version TEXT NOT NULL DEFAULT 'default_v1';
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';

CREATE TABLE IF NOT EXISTS public.facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT,
  source_message_id VARCHAR,
  confidence NUMERIC,
  active BOOLEAN NOT NULL DEFAULT true,
  superseded_value TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- The existing production contract uses key/value/observed_at. Keep this
-- migration additive instead of introducing a second facts shape.
CREATE INDEX IF NOT EXISTS facts_contact_active_idx ON public.facts (tenant_id, contact_id, active, observed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS facts_one_active_key_idx ON public.facts (tenant_id, contact_id, key) WHERE active = true;
ALTER TABLE public.facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.facts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS facts_isolation ON public.facts;
CREATE POLICY facts_isolation ON public.facts AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

CREATE TABLE IF NOT EXISTS public.objectives (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  objective_type TEXT NOT NULL,
  asked BOOLEAN NOT NULL DEFAULT false,
  answered BOOLEAN NOT NULL DEFAULT false,
  skipped BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT objectives_contact_type_uq UNIQUE (tenant_id, contact_id, objective_type)
);
CREATE INDEX IF NOT EXISTS objectives_contact_state_idx ON public.objectives (tenant_id, contact_id, answered, skipped);
ALTER TABLE public.objectives ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.objectives FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS objectives_isolation ON public.objectives;
CREATE POLICY objectives_isolation ON public.objectives AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));
`;

export async function ensureMemoryTables(pool: Pool): Promise<void> {
  await pool.query("BEGIN");
  try {
    await pool.query(CREATE_MEMORY_CONTRACTS_SQL);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
