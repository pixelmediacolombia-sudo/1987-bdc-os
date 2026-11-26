import type { Pool } from "pg";

export const APPOINTMENTS_SQL = `
ALTER TABLE public.tenants ALTER COLUMN timezone SET DEFAULT 'America/New_York';
CREATE TABLE IF NOT EXISTS public.appointment_availability (
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  weekday SMALLINT NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  is_available BOOLEAN NOT NULL DEFAULT false,
  opens_at TIME,
  closes_at TIME,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, weekday),
  CHECK ((is_available AND opens_at IS NOT NULL AND closes_at IS NOT NULL AND opens_at < closes_at) OR (NOT is_available))
);
CREATE TABLE IF NOT EXISTS public.appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES public.tenants(dealer_id) ON DELETE CASCADE,
  contact_id UUID REFERENCES public.contacts(id) ON DELETE SET NULL,
  opportunity_id UUID REFERENCES public.opportunities(id) ON DELETE SET NULL,
  assigned_user_id UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 2 AND 120),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','confirmed','cancelled','completed','no_show')),
  location TEXT,
  notes TEXT,
  reminder_minutes SMALLINT CHECK (reminder_minutes IN (0,15,30,60)),
  reminder_at TIMESTAMPTZ,
  created_by_user_id UUID REFERENCES public.app_users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS appointments_tenant_start_idx ON public.appointments (tenant_id, starts_at, id);
CREATE INDEX IF NOT EXISTS appointments_tenant_assignee_start_idx ON public.appointments (tenant_id, assigned_user_id, starts_at) WHERE status IN ('scheduled','confirmed');
`;

export async function ensureAppointmentsTables(pool: Pool): Promise<void> {
  await pool.query(APPOINTMENTS_SQL);
}

