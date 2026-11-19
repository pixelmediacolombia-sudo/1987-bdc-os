import type { Pool } from "pg";

export const INTERNAL_DIAGNOSTIC_AUDIT_SQL = `
CREATE TABLE IF NOT EXISTS public.internal_diagnostic_access_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  actor TEXT NOT NULL,
  request_id UUID NOT NULL,
  method TEXT NOT NULL,
  route TEXT NOT NULL,
  remote_address TEXT NOT NULL,
  status_code INTEGER,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS internal_diagnostic_audit_tenant_started_idx
  ON public.internal_diagnostic_access_audit (tenant_id, started_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS internal_diagnostic_audit_request_uq
  ON public.internal_diagnostic_access_audit (tenant_id, request_id);

ALTER TABLE public.internal_diagnostic_access_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.internal_diagnostic_access_audit FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS internal_diagnostic_audit_tenant_isolation
  ON public.internal_diagnostic_access_audit;
CREATE POLICY internal_diagnostic_audit_tenant_isolation
  ON public.internal_diagnostic_access_audit
  AS PERMISSIVE FOR ALL TO PUBLIC
  USING (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid))
  WITH CHECK (tenant_id = (NULLIF(current_setting('app.tenant_id', true), '')::uuid));
`;

export async function ensureInternalDiagnosticAuditTable(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(INTERNAL_DIAGNOSTIC_AUDIT_SQL);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
