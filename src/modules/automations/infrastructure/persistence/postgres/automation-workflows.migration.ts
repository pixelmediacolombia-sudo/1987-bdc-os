import type { Pool } from "pg";

export const AUTOMATION_WORKFLOWS_SQL = `
CREATE TABLE IF NOT EXISTS public.automation_workflows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  draft_definition JSONB NOT NULL CHECK (jsonb_typeof(draft_definition) = 'object'),
  draft_revision INTEGER NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  published_definition JSONB CHECK (published_definition IS NULL OR jsonb_typeof(published_definition) = 'object'),
  published_revision INTEGER CHECK (published_revision IS NULL OR published_revision > 0),
  created_by_user_id UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  updated_by_user_id UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((published_definition IS NULL) = (published_revision IS NULL))
);
CREATE INDEX IF NOT EXISTS automation_workflows_tenant_updated_idx
  ON public.automation_workflows (tenant_id, updated_at DESC, id DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_workflows TO bdc;
`;

export async function ensureAutomationWorkflows(pool: Pool): Promise<void> {
  await pool.query(AUTOMATION_WORKFLOWS_SQL);
}
