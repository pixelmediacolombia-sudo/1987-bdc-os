import type { Pool } from "pg";

export const AUTOMATION_ENGINE_SQL = `
ALTER TABLE public.automation_event_outbox ADD COLUMN IF NOT EXISTS lock_token UUID;
ALTER TABLE public.automation_event_outbox ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS automation_event_outbox_processing_idx ON public.automation_event_outbox (tenant_id,locked_at) WHERE status='processing';
CREATE UNIQUE INDEX IF NOT EXISTS automation_workflows_tenant_id_uq ON public.automation_workflows (tenant_id,id);

CREATE TABLE IF NOT EXISTS public.automation_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  workflow_id UUID NOT NULL, event_id UUID NOT NULL, generation INTEGER NOT NULL DEFAULT 1 CHECK (generation>0),
  workflow_revision INTEGER NOT NULL CHECK (workflow_revision>0), event_type TEXT NOT NULL,
  event_snapshot JSONB NOT NULL CHECK (jsonb_typeof(event_snapshot)='object'), workflow_snapshot JSONB NOT NULL CHECK (jsonb_typeof(workflow_snapshot)='object'),
  current_node_id UUID, status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','waiting','succeeded','failed','dead_letter','cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0), available_at TIMESTAMPTZ NOT NULL DEFAULT now(), locked_at TIMESTAMPTZ,
  lock_token UUID, replay_of_run_id UUID, replay_request_key UUID, last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), started_at TIMESTAMPTZ, finished_at TIMESTAMPTZ, updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT automation_runs_workflow_fk FOREIGN KEY (tenant_id,workflow_id) REFERENCES public.automation_workflows(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT automation_runs_event_fk FOREIGN KEY (tenant_id,event_id) REFERENCES public.automation_event_outbox(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT automation_runs_generation_uq UNIQUE (tenant_id,workflow_id,event_id,generation)
);
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_replay_request_uq ON public.automation_runs (tenant_id,replay_request_key) WHERE replay_request_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS automation_runs_tenant_id_uq ON public.automation_runs (tenant_id,id);
CREATE INDEX IF NOT EXISTS automation_runs_queue_idx ON public.automation_runs (tenant_id,available_at,created_at,id) WHERE status IN ('queued','waiting');
CREATE INDEX IF NOT EXISTS automation_runs_tenant_created_idx ON public.automation_runs (tenant_id,created_at DESC,id DESC);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.automation_runs TO bdc;

CREATE TABLE IF NOT EXISTS public.automation_run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  run_id UUID NOT NULL, node_id UUID NOT NULL, node_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','cancelled')), attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
  input_snapshot JSONB NOT NULL CHECK (jsonb_typeof(input_snapshot)='object'),
  output_snapshot JSONB CHECK (output_snapshot IS NULL OR jsonb_typeof(output_snapshot)='object'), error_message TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(), finished_at TIMESTAMPTZ,
  CONSTRAINT automation_run_steps_run_fk FOREIGN KEY (tenant_id,run_id) REFERENCES public.automation_runs(tenant_id,id) ON DELETE CASCADE,
  CONSTRAINT automation_run_steps_node_uq UNIQUE (tenant_id,run_id,node_id)
);
CREATE INDEX IF NOT EXISTS automation_run_steps_tenant_run_idx ON public.automation_run_steps (tenant_id,run_id,started_at,id);
GRANT SELECT,INSERT,UPDATE,DELETE ON public.automation_run_steps TO bdc;

-- Tenant discovery returns identifiers only. All data claims require the active app.tenant_id.
CREATE OR REPLACE FUNCTION public.list_automation_tenant_ids()
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
  SELECT tenant_id FROM public.automation_event_outbox WHERE status IN ('pending','processing')
  UNION SELECT tenant_id FROM public.automation_runs WHERE status IN ('queued','running','waiting')
$$;
REVOKE ALL ON FUNCTION public.list_automation_tenant_ids() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_automation_tenant_ids() TO bdc;

CREATE OR REPLACE FUNCTION public.claim_automation_events(p_tenant_id UUID,p_limit INTEGER,p_lease_seconds INTEGER)
RETURNS SETOF public.automation_event_outbox LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit,1),1),50); v_lease INTEGER := LEAST(GREATEST(COALESCE(p_lease_seconds,120),30),900);
BEGIN
  IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE='42501'; END IF;
  UPDATE public.automation_event_outbox SET status=CASE WHEN attempts>=5 THEN 'failed' ELSE 'pending' END,
    available_at=CASE WHEN attempts>=5 THEN available_at ELSE now()+make_interval(secs=>LEAST(300,power(2,LEAST(attempts,8))::integer)) END,
    lock_token=NULL,locked_at=NULL,dispatched_at=CASE WHEN attempts>=5 THEN now() ELSE dispatched_at END,
    last_error=CASE WHEN attempts>=5 THEN COALESCE(last_error,'Evento agotó el lease de procesamiento.') ELSE last_error END
   WHERE tenant_id=p_tenant_id AND status='processing' AND locked_at < now()-make_interval(secs=>v_lease);
  RETURN QUERY WITH candidates AS (
    SELECT id FROM public.automation_event_outbox WHERE tenant_id=p_tenant_id AND status='pending' AND available_at<=now() AND attempts<5
     ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT v_limit
  ) UPDATE public.automation_event_outbox e SET status='processing',attempts=e.attempts+1,locked_at=now(),lock_token=gen_random_uuid()
      FROM candidates c WHERE e.tenant_id=p_tenant_id AND e.id=c.id RETURNING e.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_automation_events(UUID,INTEGER,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_automation_events(UUID,INTEGER,INTEGER) TO bdc;

CREATE OR REPLACE FUNCTION public.claim_automation_runs(p_tenant_id UUID,p_limit INTEGER,p_lease_seconds INTEGER)
RETURNS SETOF public.automation_runs LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE v_limit INTEGER := LEAST(GREATEST(COALESCE(p_limit,1),1),50); v_lease INTEGER := LEAST(GREATEST(COALESCE(p_lease_seconds,120),30),900);
BEGIN
  IF p_tenant_id IS DISTINCT FROM NULLIF(current_setting('app.tenant_id',true),'')::uuid THEN RAISE EXCEPTION 'tenant scope mismatch' USING ERRCODE='42501'; END IF;
  UPDATE public.automation_runs SET status=CASE WHEN attempts>=4 THEN 'dead_letter' ELSE 'queued' END, attempts=attempts+1,
    available_at=CASE WHEN attempts>=4 THEN available_at ELSE now()+make_interval(secs=>LEAST(300,power(2,LEAST(attempts,8))::integer)) END,
    lock_token=NULL,locked_at=NULL,finished_at=CASE WHEN attempts>=4 THEN now() ELSE finished_at END,
    last_error=CASE WHEN attempts>=4 THEN COALESCE(last_error,'Ejecución agotó el lease de procesamiento.') ELSE last_error END,updated_at=now()
   WHERE tenant_id=p_tenant_id AND status='running' AND locked_at < now()-make_interval(secs=>v_lease);
  RETURN QUERY WITH candidates AS (
    SELECT id FROM public.automation_runs WHERE tenant_id=p_tenant_id AND status IN ('queued','waiting') AND available_at<=now()
     ORDER BY available_at,created_at,id FOR UPDATE SKIP LOCKED LIMIT v_limit
  ) UPDATE public.automation_runs r SET status='running',locked_at=now(),lock_token=gen_random_uuid(),
      started_at=COALESCE(r.started_at,now()),updated_at=now() FROM candidates c WHERE r.tenant_id=p_tenant_id AND r.id=c.id RETURNING r.*;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_automation_runs(UUID,INTEGER,INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_automation_runs(UUID,INTEGER,INTEGER) TO bdc;

ALTER TABLE public.automation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_runs_isolation ON public.automation_runs;
CREATE POLICY automation_runs_isolation ON public.automation_runs FOR ALL TO PUBLIC
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
ALTER TABLE public.automation_run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.automation_run_steps FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_run_steps_isolation ON public.automation_run_steps;
CREATE POLICY automation_run_steps_isolation ON public.automation_run_steps FOR ALL TO PUBLIC
 USING (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id=NULLIF(current_setting('app.tenant_id',true),'')::uuid);
`;

export async function ensureAutomationEngine(pool: Pool): Promise<void> {
  await pool.query(AUTOMATION_ENGINE_SQL);
}
