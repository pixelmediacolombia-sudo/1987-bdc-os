import type { Pool } from "pg";

/** Tenant flags are deliberately additive and fail closed. */
export const TENANT_FEATURE_FLAGS_SQL = `
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS sofia_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS qualification_flow_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS qualification_signal_enabled BOOLEAN NOT NULL DEFAULT false;
`;

export async function ensureTenantFeatureFlags(pool: Pool): Promise<void> {
  await pool.query("BEGIN");
  try {
    await pool.query(TENANT_FEATURE_FLAGS_SQL);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
