import type { Pool } from "pg";

export const AUTOMATION_EVENT_OUTBOX_SQL = `
CREATE TABLE IF NOT EXISTS public.automation_event_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  schema_version SMALLINT NOT NULL DEFAULT 1 CHECK (schema_version = 1),
  event_type TEXT NOT NULL CHECK (event_type IN ('contact.created','contact.updated','message.received','message.sent','conversation.assigned','conversation.status_changed','opportunity.created','opportunity.stage_changed','opportunity.assigned','opportunity.archived','opportunity.restored','opportunity.next_action_changed','appointment.created','appointment.updated','appointment.status_changed','appointment.rescheduled')),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin TEXT NOT NULL CHECK (origin IN ('crm','meta_webhook','scheduler','system')),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('user','contact','provider','system')),
  actor_id TEXT,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('contact','message','conversation','opportunity','appointment')),
  entity_id UUID NOT NULL,
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_at TIMESTAMPTZ,
  last_error TEXT,
  CONSTRAINT automation_event_outbox_tenant_event_uq UNIQUE (tenant_id, id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.automation_event_outbox TO bdc;
CREATE INDEX IF NOT EXISTS automation_event_outbox_pending_idx ON public.automation_event_outbox (available_at, created_at, id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS automation_event_outbox_tenant_created_idx ON public.automation_event_outbox (tenant_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.enqueue_automation_event(p_tenant_id UUID,p_event_type TEXT,p_entity_type TEXT,p_entity_id UUID,p_payload JSONB)
RETURNS UUID LANGUAGE plpgsql AS $$
DECLARE
  v_origin TEXT := COALESCE(NULLIF(current_setting('app.automation_origin',true),''),'crm');
  v_actor_id TEXT := NULLIF(current_setting('app.user_id',true),'');
  v_actor_type TEXT;
  v_event_id UUID;
BEGIN
  IF v_origin NOT IN ('crm','meta_webhook','scheduler','system') THEN v_origin := 'system'; END IF;
  v_actor_type := CASE WHEN v_actor_id IS NOT NULL THEN 'user' WHEN v_origin='meta_webhook' THEN 'provider' ELSE 'system' END;
  INSERT INTO public.automation_event_outbox(tenant_id,event_type,origin,actor_type,actor_id,entity_type,entity_id,payload)
    VALUES(p_tenant_id,p_event_type,v_origin,v_actor_type,v_actor_id,p_entity_type,p_entity_id,p_payload) RETURNING id INTO v_event_id;
  RETURN v_event_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_contact_automation_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_changed TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM public.enqueue_automation_event(NEW.tenant_id,'contact.created','contact',NEW.id,
      jsonb_build_object('source',CASE COALESCE(NULLIF(current_setting('app.automation_origin',true),''),'crm') WHEN 'meta_webhook' THEN 'meta_webhook' WHEN 'scheduler' THEN 'inbound' WHEN 'system' THEN 'inbound' ELSE 'manual' END));
    RETURN NEW;
  END IF;
  IF NEW.display_name IS DISTINCT FROM OLD.display_name THEN v_changed:=array_append(v_changed,'displayName'); END IF;
  IF NEW.phone IS DISTINCT FROM OLD.phone THEN v_changed:=array_append(v_changed,'phone'); END IF;
  IF NEW.email IS DISTINCT FROM OLD.email THEN v_changed:=array_append(v_changed,'email'); END IF;
  IF NEW.preferred_language IS DISTINCT FROM OLD.preferred_language THEN v_changed:=array_append(v_changed,'preferredLanguage'); END IF;
  IF NEW.consent_state IS DISTINCT FROM OLD.consent_state THEN v_changed:=array_append(v_changed,'consentState'); END IF;
  IF cardinality(v_changed)>0 THEN PERFORM public.enqueue_automation_event(NEW.tenant_id,'contact.updated','contact',NEW.id,jsonb_build_object('changedFields',to_jsonb(v_changed))); END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS contacts_automation_events ON public.contacts;
CREATE TRIGGER contacts_automation_events AFTER INSERT OR UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.capture_contact_automation_event();

CREATE OR REPLACE FUNCTION public.capture_conversation_automation_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id THEN
    PERFORM public.enqueue_automation_event(NEW.tenant_id,'conversation.assigned','conversation',NEW.id,jsonb_build_object('contactId',NEW.contact_id,'previousAssigneeId',OLD.assigned_user_id,'assigneeId',NEW.assigned_user_id));
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    PERFORM public.enqueue_automation_event(NEW.tenant_id,'conversation.status_changed','conversation',NEW.id,jsonb_build_object('contactId',NEW.contact_id,'previousStatus',OLD.state,'status',NEW.state));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS conversations_automation_events ON public.conversations;
CREATE TRIGGER conversations_automation_events AFTER UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.capture_conversation_automation_event();

CREATE OR REPLACE FUNCTION public.capture_message_automation_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_contact_id UUID; v_channel TEXT;
BEGIN
  IF (TG_OP='INSERT' AND NEW.direction='inbound' AND NEW.status='received') OR (TG_OP='UPDATE' AND NEW.direction='outbound' AND NEW.status='sent' AND OLD.status IS DISTINCT FROM 'sent') THEN
    SELECT contact_id,channel INTO v_contact_id,v_channel FROM public.conversations WHERE tenant_id=NEW.tenant_id AND id=NEW.conversation_id;
    IF TG_OP='INSERT' THEN
      PERFORM public.enqueue_automation_event(NEW.tenant_id,'message.received','message',NEW.id,jsonb_build_object('conversationId',NEW.conversation_id,'contactId',v_contact_id,'channel',v_channel,'senderType','client'));
    ELSE
      PERFORM public.enqueue_automation_event(NEW.tenant_id,'message.sent','message',NEW.id,jsonb_build_object('conversationId',NEW.conversation_id,'contactId',v_contact_id,'channel',v_channel,'senderType',CASE WHEN NEW.sender_user_id IS NOT NULL THEN 'staff' WHEN NEW.sender_type IN ('agent','system') THEN NEW.sender_type ELSE 'system' END,'deliveryStatus',NEW.status));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS messages_automation_events ON public.messages;
CREATE TRIGGER messages_automation_events AFTER INSERT OR UPDATE OF status ON public.messages FOR EACH ROW EXECUTE FUNCTION public.capture_message_automation_event();

CREATE OR REPLACE FUNCTION public.capture_opportunity_automation_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_next_action TEXT;
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM public.enqueue_automation_event(NEW.tenant_id,'opportunity.created','opportunity',NEW.id,jsonb_strip_nulls(jsonb_build_object('contactId',NEW.contact_id,'stage',NEW.stage)));
    RETURN NEW;
  END IF;
  IF NEW.stage IS DISTINCT FROM OLD.stage THEN PERFORM public.enqueue_automation_event(NEW.tenant_id,'opportunity.stage_changed','opportunity',NEW.id,jsonb_strip_nulls(jsonb_build_object('contactId',NEW.contact_id,'previousStage',OLD.stage,'stage',NEW.stage))); END IF;
  IF NEW.assigned_user_id IS DISTINCT FROM OLD.assigned_user_id THEN PERFORM public.enqueue_automation_event(NEW.tenant_id,'opportunity.assigned','opportunity',NEW.id,jsonb_build_object('previousAssigneeId',OLD.assigned_user_id,'assigneeId',NEW.assigned_user_id) || CASE WHEN NEW.contact_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('contactId',NEW.contact_id) END); END IF;
  IF OLD.archived_at IS NULL AND NEW.archived_at IS NOT NULL THEN PERFORM public.enqueue_automation_event(NEW.tenant_id,'opportunity.archived','opportunity',NEW.id,jsonb_strip_nulls(jsonb_build_object('contactId',NEW.contact_id)));
  ELSIF OLD.archived_at IS NOT NULL AND NEW.archived_at IS NULL THEN PERFORM public.enqueue_automation_event(NEW.tenant_id,'opportunity.restored','opportunity',NEW.id,jsonb_strip_nulls(jsonb_build_object('contactId',NEW.contact_id))); END IF;
  IF NEW.next_action IS DISTINCT FROM OLD.next_action OR NEW.next_action_at IS DISTINCT FROM OLD.next_action_at THEN
    v_next_action:=CASE WHEN NEW.next_action_at IS NULL THEN NULL ELSE to_char(NEW.next_action_at::timestamp,'YYYY-MM-DD')||'T00:00:00Z' END;
    PERFORM public.enqueue_automation_event(NEW.tenant_id,'opportunity.next_action_changed','opportunity',NEW.id,jsonb_build_object('nextActionAt',v_next_action) || CASE WHEN NEW.contact_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('contactId',NEW.contact_id) END);
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS opportunities_automation_events ON public.opportunities;
CREATE TRIGGER opportunities_automation_events AFTER INSERT OR UPDATE ON public.opportunities FOR EACH ROW EXECUTE FUNCTION public.capture_opportunity_automation_event();

CREATE OR REPLACE FUNCTION public.capture_appointment_automation_event() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    PERFORM public.enqueue_automation_event(NEW.tenant_id,'appointment.created','appointment',NEW.id,jsonb_strip_nulls(jsonb_build_object('contactId',NEW.contact_id,'opportunityId',NEW.opportunity_id,'startsAt',NEW.starts_at,'endsAt',NEW.ends_at,'status',NEW.status)));
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN PERFORM public.enqueue_automation_event(NEW.tenant_id,'appointment.status_changed','appointment',NEW.id,jsonb_strip_nulls(jsonb_build_object('contactId',NEW.contact_id,'previousStatus',OLD.status,'status',NEW.status))); END IF;
  IF NEW.starts_at IS DISTINCT FROM OLD.starts_at THEN PERFORM public.enqueue_automation_event(NEW.tenant_id,'appointment.rescheduled','appointment',NEW.id,jsonb_strip_nulls(jsonb_build_object('contactId',NEW.contact_id,'previousStartsAt',OLD.starts_at,'startsAt',NEW.starts_at,'endsAt',NEW.ends_at))); END IF;
  IF ROW(NEW.contact_id,NEW.opportunity_id,NEW.assigned_user_id,NEW.title,NEW.starts_at,NEW.ends_at,NEW.status,NEW.location,NEW.notes,NEW.reminder_minutes) IS DISTINCT FROM ROW(OLD.contact_id,OLD.opportunity_id,OLD.assigned_user_id,OLD.title,OLD.starts_at,OLD.ends_at,OLD.status,OLD.location,OLD.notes,OLD.reminder_minutes) THEN
    PERFORM public.enqueue_automation_event(NEW.tenant_id,'appointment.updated','appointment',NEW.id,jsonb_strip_nulls(jsonb_build_object('contactId',NEW.contact_id,'opportunityId',NEW.opportunity_id,'startsAt',NEW.starts_at,'endsAt',NEW.ends_at,'status',NEW.status)));
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS appointments_automation_events ON public.appointments;
CREATE TRIGGER appointments_automation_events AFTER INSERT OR UPDATE ON public.appointments FOR EACH ROW EXECUTE FUNCTION public.capture_appointment_automation_event();
`;

export async function ensureAutomationEventOutbox(pool: Pool): Promise<void> {
  await pool.query(AUTOMATION_EVENT_OUTBOX_SQL);
}


