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

ALTER TABLE public.opportunities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunities FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS opportunities_isolation ON public.opportunities;
CREATE POLICY opportunities_isolation ON public.opportunities FOR ALL TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS messages_isolation ON public.messages;
CREATE POLICY messages_isolation ON public.messages
  FOR ALL TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

ALTER TABLE public.dealer_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dealer_invitations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS dealer_invitations_select_scope ON public.dealer_invitations;
DROP POLICY IF EXISTS dealer_invitations_write_scope ON public.dealer_invitations;
DROP POLICY IF EXISTS dealer_invitations_insert_scope ON public.dealer_invitations;
DROP POLICY IF EXISTS dealer_invitations_update_scope ON public.dealer_invitations;
DROP POLICY IF EXISTS dealer_invitations_delete_scope ON public.dealer_invitations;
CREATE POLICY dealer_invitations_select_scope ON public.dealer_invitations
  FOR SELECT TO PUBLIC
  USING (
    tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    OR COALESCE(current_setting('app.is_platform_admin', true) = 'true', false)
    OR token_hash = NULLIF(current_setting('app.invitation_token_hash', true), '')
  );
CREATE POLICY dealer_invitations_insert_scope ON public.dealer_invitations
  FOR INSERT TO PUBLIC
  WITH CHECK (
    tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    OR COALESCE(current_setting('app.is_platform_admin', true) = 'true', false)
  );
CREATE POLICY dealer_invitations_update_scope ON public.dealer_invitations
  FOR UPDATE TO PUBLIC
  USING (
    tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    OR COALESCE(current_setting('app.is_platform_admin', true) = 'true', false)
    OR token_hash = NULLIF(current_setting('app.invitation_token_hash', true), '')
  )
  WITH CHECK (
    tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    OR COALESCE(current_setting('app.is_platform_admin', true) = 'true', false)
  );
CREATE POLICY dealer_invitations_delete_scope ON public.dealer_invitations
  FOR DELETE TO PUBLIC
  USING (
    tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    OR COALESCE(current_setting('app.is_platform_admin', true) = 'true', false)
  );

ALTER TABLE public.user_tenant_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_tenant_memberships FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS user_tenant_memberships_select_scope ON public.user_tenant_memberships;
DROP POLICY IF EXISTS user_tenant_memberships_write_scope ON public.user_tenant_memberships;
CREATE POLICY user_tenant_memberships_select_scope ON public.user_tenant_memberships
  FOR SELECT TO PUBLIC
  USING (
    tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    OR user_id = (NULLIF(current_setting('app.user_id', true), '')::uuid)
    OR COALESCE(current_setting('app.is_platform_admin', true) = 'true', false)
  );
CREATE POLICY user_tenant_memberships_write_scope ON public.user_tenant_memberships
  FOR ALL TO PUBLIC
  USING (
    tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    OR COALESCE(current_setting('app.is_platform_admin', true) = 'true', false)
  )
  WITH CHECK (
    tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid)
    OR COALESCE(current_setting('app.is_platform_admin', true) = 'true', false)
  );
`;

export async function ensureTenantRowLevelSecurity(pool: Pool): Promise<void> {
  await pool.query(TENANT_RLS_SQL);
}
