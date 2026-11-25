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
  stage TEXT NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'working', 'closing', 'won', 'lost')),
  assigned_user_id UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  expected_close_date DATE,
  notes TEXT,
  created_by_user_id UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS opportunities_tenant_stage_activity_idx
  ON public.opportunities (tenant_id, stage, updated_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS opportunities_tenant_assignee_idx
  ON public.opportunities (tenant_id, assigned_user_id, updated_at DESC) WHERE assigned_user_id IS NOT NULL;
`;

export async function ensureOpportunitiesTable(pool: Pool): Promise<void> {
  await pool.query(OPPORTUNITIES_SQL);
}
