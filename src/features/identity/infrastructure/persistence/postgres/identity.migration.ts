import type { Pool } from "pg";

export const CREATE_IDENTITY_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS public.app_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT,
  account_type TEXT NOT NULL CHECK (account_type IN ('admin', 'user')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('invited', 'active', 'disabled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_lower_uq
  ON public.app_users (lower(email));

CREATE UNIQUE INDEX IF NOT EXISTS app_users_single_platform_admin_uq
  ON public.app_users (account_type)
  WHERE account_type = 'admin';

CREATE TABLE IF NOT EXISTS public.user_tenant_memberships (
  user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS user_tenant_memberships_tenant_idx
  ON public.user_tenant_memberships (tenant_id, user_id);

CREATE TABLE IF NOT EXISTS public.app_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.app_users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS app_sessions_user_expiry_idx
  ON public.app_sessions (user_id, expires_at DESC)
  WHERE revoked_at IS NULL;

ALTER TABLE public.tenants ALTER COLUMN ghl_location_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.sync_tenant_location_route()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.ghl_location_id IS NOT NULL
     AND OLD.ghl_location_id IS DISTINCT FROM NEW.ghl_location_id THEN
    DELETE FROM public.tenant_location_routes
     WHERE dealer_id = NEW.dealer_id AND ghl_location_id = OLD.ghl_location_id;
  END IF;

  IF NULLIF(btrim(NEW.ghl_location_id), '') IS NOT NULL THEN
    INSERT INTO public.tenant_location_routes (ghl_location_id, dealer_id)
    VALUES (btrim(NEW.ghl_location_id), NEW.dealer_id)
    ON CONFLICT (ghl_location_id) DO UPDATE
      SET dealer_id = EXCLUDED.dealer_id,
          updated_at = now();
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TABLE IF NOT EXISTS public.dealer_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  invited_by UUID NOT NULL REFERENCES public.app_users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS dealer_invitations_pending_email_idx
  ON public.dealer_invitations (lower(email), tenant_id, expires_at DESC)
  WHERE accepted_at IS NULL AND revoked_at IS NULL;

COMMENT ON TABLE public.app_users IS
  'Human login accounts for BDC OS. Dealers/companies remain tenants.';
COMMENT ON TABLE public.user_tenant_memberships IS
  'Associates regular BDC OS users with one or more dealer tenants.';
COMMENT ON TABLE public.app_sessions IS
  'Opaque, revocable web sessions. Only a SHA-256 digest of the browser token is stored.';
COMMENT ON TABLE public.dealer_invitations IS
  'Single-use, expiring dealer invitations. Only a SHA-256 digest of the invitation token is stored.';
`;

export async function ensureIdentityTables(pool: Pool): Promise<void> {
  await pool.query("BEGIN");
  try {
    await pool.query(CREATE_IDENTITY_TABLES_SQL);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
