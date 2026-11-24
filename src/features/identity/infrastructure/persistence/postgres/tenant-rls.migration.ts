import type { Pool } from "pg";

export const TENANT_RLS_SQL = `
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolation ON public.tenants;
CREATE POLICY tenants_isolation ON public.tenants
  FOR ALL TO PUBLIC
  USING (dealer_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (dealer_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));
`;

export async function ensureTenantRowLevelSecurity(pool: Pool): Promise<void> {
  await pool.query(TENANT_RLS_SQL);
}
