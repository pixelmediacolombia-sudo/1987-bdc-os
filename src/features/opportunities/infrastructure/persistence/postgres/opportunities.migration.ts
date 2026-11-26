import type { Pool } from "pg";

export const OPPORTUNITIES_SQL = `
CREATE TABLE IF NOT EXISTS public.opportunities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 120),
  contact_name TEXT NOT NULL CHECK (length(trim(contact_name)) BETWEEN 1 AND 120),
  contact_phone TEXT,
  amount_cents BIGINT NOT NULL DEFAULT 0 CHECK (amount_cents >= 0),
  stage TEXT NOT NULL DEFAULT 'new',
  assigned_user_id UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  expected_close_date DATE,
  notes TEXT,
  next_action TEXT,
  next_action_at DATE,
  archived_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS next_action TEXT;
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS next_action_at DATE;
ALTER TABLE public.opportunities ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ;
ALTER TABLE public.opportunities DROP CONSTRAINT IF EXISTS opportunities_stage_check;
CREATE TABLE IF NOT EXISTS public.opportunity_stages (
 tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
 stage_key TEXT NOT NULL CHECK (stage_key IN ('new','working','closing','won','lost')),
 label TEXT NOT NULL CHECK (length(trim(label)) BETWEEN 1 AND 60),
 position SMALLINT NOT NULL CHECK (position BETWEEN 0 AND 4), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY (tenant_id,stage_key), UNIQUE (tenant_id,position));
ALTER TABLE public.opportunity_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.opportunity_stages FORCE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.opportunity_stages TO bdc;
DROP POLICY IF EXISTS opportunity_stages_isolation ON public.opportunity_stages;
CREATE POLICY opportunity_stages_isolation ON public.opportunity_stages FOR ALL TO PUBLIC
 USING (tenant_id=(NULLIF(current_setting('app.tenant_id',true),'')::uuid))
 WITH CHECK (tenant_id=(NULLIF(current_setting('app.tenant_id',true),'')::uuid));
INSERT INTO public.opportunity_stages (tenant_id,stage_key,label,position)
SELECT t.dealer_id,s.stage_key,s.label,s.position FROM public.tenants t CROSS JOIN (VALUES ('new','Nuevo',0),('working','En proceso',1),('closing','Cierre',2),('won','Ganada',3),('lost','Perdida',4)) s(stage_key,label,position)
ON CONFLICT (tenant_id,stage_key) DO NOTHING;
CREATE INDEX IF NOT EXISTS opportunities_tenant_archive_activity_idx ON public.opportunities (tenant_id,archived_at,updated_at DESC);
CREATE INDEX IF NOT EXISTS opportunities_tenant_stage_activity_idx
  ON public.opportunities (tenant_id, stage, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS opportunities_tenant_assignee_idx
  ON public.opportunities (tenant_id, assigned_user_id, updated_at DESC) WHERE assigned_user_id IS NOT NULL;
`;

export async function ensureOpportunitiesTable(pool: Pool): Promise<void> {
  await pool.query(OPPORTUNITIES_SQL);
}
