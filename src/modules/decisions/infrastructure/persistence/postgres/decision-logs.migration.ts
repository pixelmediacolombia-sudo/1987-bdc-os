import type { Pool } from "pg";

export const CREATE_DECISION_LOGS_SQL = `
CREATE TABLE IF NOT EXISTS public.decision_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  input_version TEXT NOT NULL,
  allowed_actions JSONB NOT NULL CHECK (jsonb_typeof(allowed_actions) = 'array'),
  selected_action TEXT,
  reason TEXT NOT NULL,
  model_trace JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.decision_logs
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS decision_logs_tenant_contact_idx
  ON public.decision_logs (tenant_id, contact_id, created_at DESC);

ALTER TABLE public.decision_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.decision_logs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS decision_logs_select_isolation ON public.decision_logs;
CREATE POLICY decision_logs_select_isolation ON public.decision_logs
  FOR SELECT TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

DROP POLICY IF EXISTS decision_logs_insert_isolation ON public.decision_logs;
CREATE POLICY decision_logs_insert_isolation ON public.decision_logs
  FOR INSERT TO PUBLIC
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));

CREATE OR REPLACE FUNCTION public.prevent_decision_log_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'decision_logs are immutable';
END;
$$;

DROP TRIGGER IF EXISTS decision_logs_immutable ON public.decision_logs;
CREATE TRIGGER decision_logs_immutable
  BEFORE UPDATE OR DELETE ON public.decision_logs
  FOR EACH ROW EXECUTE FUNCTION public.prevent_decision_log_mutation();
`;

export async function ensureDecisionLogsTable(pool: Pool): Promise<void> {
  await pool.query("BEGIN");
  try {
    await pool.query(CREATE_DECISION_LOGS_SQL);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
