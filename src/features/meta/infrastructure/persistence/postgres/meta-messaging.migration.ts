import type { Pool } from "pg";

export const CREATE_META_MESSAGING_CONNECTIONS_SQL = `
CREATE TABLE IF NOT EXISTS public.meta_messaging_connections (
  tenant_id UUID PRIMARY KEY REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  facebook_page_id TEXT,
  instagram_business_id TEXT,
  whatsapp_phone_number_id TEXT,
  encrypted_page_access_token TEXT,
  encrypted_whatsapp_access_token TEXT,
  granted_scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  health_state TEXT NOT NULL DEFAULT 'healthy'
    CHECK (health_state IN ('healthy', 'degraded', 'revoked', 'unknown')),
  connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (facebook_page_id IS NOT NULL OR whatsapp_phone_number_id IS NOT NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS meta_messaging_page_id_uq
  ON public.meta_messaging_connections (facebook_page_id)
  WHERE facebook_page_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS meta_messaging_ig_id_uq
  ON public.meta_messaging_connections (instagram_business_id)
  WHERE instagram_business_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS meta_messaging_whatsapp_phone_id_uq
  ON public.meta_messaging_connections (whatsapp_phone_number_id)
  WHERE whatsapp_phone_number_id IS NOT NULL;

ALTER TABLE public.meta_messaging_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meta_messaging_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS meta_messaging_connections_tenant_isolation ON public.meta_messaging_connections;
CREATE POLICY meta_messaging_connections_tenant_isolation ON public.meta_messaging_connections
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

CREATE TABLE IF NOT EXISTS public.meta_messaging_routes (
  account_id TEXT PRIMARY KEY,
  channel TEXT NOT NULL CHECK (channel IN ('messenger', 'instagram', 'whatsapp')),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel, account_id)
);
CREATE INDEX IF NOT EXISTS meta_messaging_routes_tenant_idx
  ON public.meta_messaging_routes (tenant_id, channel);
REVOKE ALL ON TABLE public.meta_messaging_routes FROM PUBLIC, bdc;

CREATE OR REPLACE FUNCTION public.sync_meta_messaging_routes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
BEGIN
  DELETE FROM public.meta_messaging_routes WHERE tenant_id = NEW.tenant_id;
  INSERT INTO public.meta_messaging_routes (account_id, channel, tenant_id)
  SELECT account_id, channel, NEW.tenant_id
    FROM (VALUES
      (NULLIF(btrim(NEW.facebook_page_id), ''), 'messenger'),
      (NULLIF(btrim(NEW.instagram_business_id), ''), 'instagram'),
      (NULLIF(btrim(NEW.whatsapp_phone_number_id), ''), 'whatsapp')
    ) AS configured(account_id, channel)
   WHERE account_id IS NOT NULL
  ON CONFLICT (account_id) DO UPDATE SET channel = EXCLUDED.channel, tenant_id = EXCLUDED.tenant_id;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS meta_messaging_connections_sync_routes ON public.meta_messaging_connections;
CREATE TRIGGER meta_messaging_connections_sync_routes
AFTER INSERT OR UPDATE OF facebook_page_id, instagram_business_id, whatsapp_phone_number_id
ON public.meta_messaging_connections
FOR EACH ROW EXECUTE FUNCTION public.sync_meta_messaging_routes();

CREATE OR REPLACE FUNCTION public.resolve_meta_tenant_id(p_account_id TEXT)
RETURNS UUID LANGUAGE SQL STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $function$
  SELECT tenant_id FROM public.meta_messaging_routes WHERE account_id = p_account_id LIMIT 1;
$function$;
REVOKE ALL ON FUNCTION public.resolve_meta_tenant_id(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_meta_tenant_id(TEXT) TO bdc;
`;

export async function ensureMetaMessagingTables(pool: Pool): Promise<void> {
  await pool.query("BEGIN");
  try {
    await pool.query(CREATE_META_MESSAGING_CONNECTIONS_SQL);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
