import type { Pool } from "pg";

export const CONVERSATION_AI_SHADOW_SQL = `
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS dealer_name TEXT,
  ADD COLUMN IF NOT EXISTS financial_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS facebook_page_id TEXT,
  ADD COLUMN IF NOT EXISTS conversational_ai_shadow_enabled BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS conversational_ai_send_enabled BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.conversation_ai_shadow_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  contact_id TEXT NOT NULL,
  inbound_external_id TEXT,
  extraction_model TEXT NOT NULL,
  drafting_model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  extraction JSONB,
  model_facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  rule_facts JSONB NOT NULL DEFAULT '{}'::jsonb,
  rule_response TEXT,
  model_response TEXT,
  draft_accepted BOOLEAN NOT NULL DEFAULT false,
  safety_issues JSONB NOT NULL DEFAULT '[]'::jsonb,
  input_tokens INTEGER,
  output_tokens INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversation_ai_shadow_tenant_contact_idx
  ON public.conversation_ai_shadow_runs (tenant_id, contact_id, created_at DESC);

ALTER TABLE public.conversation_ai_shadow_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_ai_shadow_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversation_ai_shadow_tenant_isolation ON public.conversation_ai_shadow_runs;
CREATE POLICY conversation_ai_shadow_tenant_isolation ON public.conversation_ai_shadow_runs
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));
`;

export async function ensureConversationAiShadowTables(pool: Pool): Promise<void> {
  await pool.query("BEGIN");
  try {
    await pool.query(CONVERSATION_AI_SHADOW_SQL);
    await pool.query("COMMIT");
  } catch (error) {
    await pool.query("ROLLBACK");
    throw error;
  }
}
