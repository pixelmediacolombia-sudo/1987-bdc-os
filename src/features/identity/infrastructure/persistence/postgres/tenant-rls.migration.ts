import type { Pool } from "pg";

export const TENANT_RLS_SQL = `
ALTER TABLE public.tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenants_isolation ON public.tenants;
CREATE POLICY tenants_isolation ON public.tenants
  FOR ALL TO PUBLIC
  USING (dealer_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (dealer_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contacts_isolation ON public.contacts;
CREATE POLICY contacts_isolation ON public.contacts
  FOR ALL TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversations_isolation ON public.conversations;
CREATE POLICY conversations_isolation ON public.conversations
  FOR ALL TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_isolation ON public.messages;
CREATE POLICY messages_isolation ON public.messages
  FOR ALL TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));
`;

export async function ensureTenantRowLevelSecurity(pool: Pool): Promise<void> {
  await pool.query(TENANT_RLS_SQL);
}
