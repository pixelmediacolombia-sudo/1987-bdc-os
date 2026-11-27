import express, { type Request, type Response } from "express";
import type { RequestHandler } from "express";
import type { Pool, PoolClient } from "pg";
import { activeSession, appendAudit, auditReference, type IdentityUser } from "@/features/identity/presentation/http/routes/route-helpers";
import { isTenantMember as isMember } from "@/features/identity/application/tenant-membership.service";
import { withTenant, withUser } from "@/features/identity/infrastructure/persistence/postgres/tenant-transaction";
import { assertAppointmentWindow, DEFAULT_APPOINTMENT_AVAILABILITY, parseLocalDateTime, weekdayOf, type Availability } from "@/features/appointments/application/appointments.service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIVE_STATUS = ["scheduled", "confirmed"];
type Appointment = { id: string; dealerId: string; contactId: string | null; opportunityId: string | null; assignedUserId: string | null; assignedUserName: string | null; title: string; startsAt: Date; endsAt: Date; status: string; location: string | null; notes: string | null; reminderMinutes: number | null; reminderAt: Date | null; createdAt: Date; updatedAt: Date };

async function dealerUser(pool: Pool, request: Request, response: Response): Promise<IdentityUser | undefined> {
  const user = await activeSession(pool, request);
  if (!user) { response.status(401).json({ error: "Inicia sesión para continuar." }); return; }
  if (user.account_type !== "user") { response.status(403).json({ error: "Esta sección requiere una cuenta de dealer." }); return; }
  return user;
}
const COLUMNS = `a.id::text AS id,a.tenant_id::text AS "dealerId",a.contact_id::text AS "contactId",a.opportunity_id::text AS "opportunityId",a.assigned_user_id::text AS "assignedUserId",u.display_name AS "assignedUserName",a.title,a.starts_at AS "startsAt",a.ends_at AS "endsAt",a.status,a.location,a.notes,a.reminder_minutes AS "reminderMinutes",a.reminder_at AS "reminderAt",a.created_at AS "createdAt",a.updated_at AS "updatedAt"`;
async function timezoneFor(_client: PoolClient, _dealerId: string): Promise<string> {
  return "America/New_York";
}
async function ensureHours(client: PoolClient, dealerId: string): Promise<void> {
  for (const hour of DEFAULT_APPOINTMENT_AVAILABILITY) await client.query("INSERT INTO public.appointment_availability (tenant_id,weekday,is_available,opens_at,closes_at) VALUES ($1::uuid,$2,$3,$4::time,$5::time) ON CONFLICT (tenant_id,weekday) DO NOTHING", [dealerId, hour.weekday, hour.isAvailable, hour.opensAt, hour.closesAt]);
}
async function validateWindow(client: PoolClient, dealerId: string, start: Date, end: Date): Promise<void> {
  const timeZone = await timezoneFor(client, dealerId);
  await ensureHours(client, dealerId);
  const hours = await client.query<{ is_available: boolean; opens_at: string | null; closes_at: string | null }>("SELECT is_available,opens_at::text,closes_at::text FROM public.appointment_availability WHERE tenant_id=$1::uuid AND weekday=$2", [dealerId, weekdayOf(start, timeZone)]);
  const availability = hours.rows[0] && { weekday: weekdayOf(start, timeZone), isAvailable: hours.rows[0].is_available, opensAt: hours.rows[0].opens_at, closesAt: hours.rows[0].closes_at };
  assertAppointmentWindow(start, end, timeZone, availability);
}
async function appendAppointmentAudit(client: PoolClient, user: IdentityUser, dealerId: string, request: Request, action: string, summary: string, entityId?: string): Promise<void> {
  const tenant = await client.query<{ dealer_name: string }>("SELECT dealer_name FROM public.tenants WHERE dealer_id=$1::uuid", [dealerId]);
  await appendAudit(client, { actor: user, dealerId, dealerName: tenant.rows[0]?.dealer_name, category: "appointments", action, summary, referenceId: auditReference(request), entityId });
}
function sendError(response: Response, error: unknown, fallback: string): void {
  const cause = error as Error & { status?: number };
  if (!response.headersSent) response.status(cause.status ?? 500).json({ error: cause.message || fallback });
}






export class AppointmentsController {
  constructor(private readonly pool: Pool) {}

  getCalendarAvailability: RequestHandler = async (request, response) => {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      if (!await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const result = await withTenant(this.pool, dealerId, async (client) => {
        await ensureHours(client, dealerId);
        const hours = await client.query(`SELECT weekday,is_available AS "isAvailable",opens_at::text AS "opensAt",closes_at::text AS "closesAt" FROM public.appointment_availability WHERE tenant_id=$1::uuid ORDER BY weekday`, [dealerId]);
        return { availability: hours.rows, timeZone: await timezoneFor(client, dealerId) };
      });
      response.json(result);
    } catch (error) { sendError(response, error, "No pudimos cargar los horarios."); }
  };

  replaceCalendarAvailability: RequestHandler = async (request, response) => {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const rows = (request.body as { availability?: unknown })?.availability;
      if (!await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      const valid = Array.isArray(rows) && rows.length === 7 && rows.every((row) => row && typeof row === "object" && Number.isInteger((row as Availability).weekday) && typeof (row as Availability).isAvailable === "boolean" && (!(row as Availability).isAvailable || (/^\d{2}:\d{2}$/.test(String((row as Availability).opensAt)) && /^\d{2}:\d{2}$/.test(String((row as Availability).closesAt)) && String((row as Availability).opensAt) < String((row as Availability).closesAt))) && Number((row as Availability).weekday) >= 0 && Number((row as Availability).weekday) <= 6) && new Set(rows.map((row) => (row as Availability).weekday)).size === 7;
      if (!valid) { response.status(400).json({ error: "Configura un horario válido para cada día." }); return; }
      const availability = await withTenant(this.pool, dealerId, async (client) => {
        await client.query("DELETE FROM public.appointment_availability WHERE tenant_id=$1::uuid", [dealerId]);
        for (const row of rows as Availability[]) await client.query("INSERT INTO public.appointment_availability (tenant_id,weekday,is_available,opens_at,closes_at) VALUES ($1::uuid,$2,$3,$4::time,$5::time)", [dealerId, row.weekday, row.isAvailable, row.isAvailable ? row.opensAt : null, row.isAvailable ? row.closesAt : null]);
        await appendAppointmentAudit(client, user, dealerId, request, "appointment.availability_updated", "Se actualizó la disponibilidad del dealer.");
        return (await client.query(`SELECT weekday,is_available AS "isAvailable",opens_at::text AS "opensAt",closes_at::text AS "closesAt" FROM public.appointment_availability WHERE tenant_id=$1::uuid ORDER BY weekday`, [dealerId])).rows;
      });
      response.json({ availability });
    } catch (error) { sendError(response, error, "No pudimos guardar los horarios."); }
  };

  getAppointments: RequestHandler = async (request, response) => {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const from = typeof request.query.from === "string" ? new Date(request.query.from) : null;
      const to = typeof request.query.to === "string" ? new Date(request.query.to) : null;
      if (!await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      if (!from || !to || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) { response.status(400).json({ error: "Indica un rango de fechas válido." }); return; }
      const result = await withTenant(this.pool, dealerId, async (client) => {
        const rows = await client.query<Appointment>(`SELECT ${COLUMNS} FROM public.appointments a LEFT JOIN public.app_users u ON u.id=a.assigned_user_id WHERE a.tenant_id=$1::uuid AND a.starts_at<$3 AND a.ends_at>$2 ORDER BY a.starts_at`, [dealerId, from.toISOString(), to.toISOString()]);
        return { appointments: rows.rows, timeZone: await timezoneFor(client, dealerId) };
      });
      response.json(result);
    } catch (error) { sendError(response, error, "No pudimos cargar las citas."); }
  };

  createAppointments: RequestHandler = async (request, response) => {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const body = request.body as Record<string, unknown>;
      const dealerId = typeof body.dealerId === "string" ? body.dealerId : "";
      const title = typeof body.title === "string" ? body.title.trim() : "";
      const contactId = typeof body.contactId === "string" ? body.contactId : null;
      const opportunityId = typeof body.opportunityId === "string" ? body.opportunityId : null;
      const assigneeId = body.assignedUserId === null || body.assignedUserId === "" ? null : typeof body.assignedUserId === "string" ? body.assignedUserId : user.id;
      const reminderMinutes = body.reminderMinutes === null ? null : Number(body.reminderMinutes ?? 15);
      if (!await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a este dealer." }); return; }
      if (title.length < 2 || title.length > 120 || (!contactId && !opportunityId) || (assigneeId !== null && !UUID.test(assigneeId)) || !(reminderMinutes === null || [0, 15, 30, 60].includes(reminderMinutes))) { response.status(400).json({ error: "Revisa el título, vínculo, responsable y recordatorio de la cita." }); return; }
      const appointment = await withTenant(this.pool, dealerId, async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [dealerId]);
        const timeZone = await timezoneFor(client, dealerId);
        const start = parseLocalDateTime(body.startsAtLocal, timeZone), end = parseLocalDateTime(body.endsAtLocal, timeZone);
        await validateWindow(client, dealerId, start, end);
        if (assigneeId && (await client.query("SELECT 1 FROM public.user_tenant_memberships WHERE user_id=$1::uuid AND tenant_id=$2::uuid", [assigneeId, dealerId])).rowCount !== 1) throw Object.assign(new Error("El responsable debe pertenecer al dealer actual."), { status: 400 });
        if (contactId && (await client.query("SELECT 1 FROM public.contacts WHERE id=$1::uuid AND tenant_id=$2::uuid", [contactId, dealerId])).rowCount !== 1) throw Object.assign(new Error("El contacto debe pertenecer al dealer actual."), { status: 400 });
        if (opportunityId && (await client.query("SELECT 1 FROM public.opportunities WHERE id=$1::uuid AND tenant_id=$2::uuid AND archived_at IS NULL", [opportunityId, dealerId])).rowCount !== 1) throw Object.assign(new Error("La oportunidad debe pertenecer al dealer y estar activa."), { status: 400 });
        if (contactId && opportunityId && (await client.query("SELECT 1 FROM public.opportunities WHERE id=$1::uuid AND tenant_id=$2::uuid AND contact_id=$3::uuid", [opportunityId, dealerId, contactId])).rowCount !== 1) throw Object.assign(new Error("El contacto y la oportunidad vinculada no coinciden."), { status: 400 });
        const conflict = await client.query("SELECT 1 FROM public.appointments WHERE tenant_id=$1::uuid AND assigned_user_id IS NOT DISTINCT FROM $2::uuid AND status=ANY($3::text[]) AND starts_at<$4 AND ends_at>$5", [dealerId, assigneeId, ACTIVE_STATUS, end.toISOString(), start.toISOString()]);
        if (conflict.rowCount) throw Object.assign(new Error("Ese responsable ya tiene una cita en ese horario."), { status: 409 });
        const inserted = await client.query<{ id: string }>(`INSERT INTO public.appointments (tenant_id,contact_id,opportunity_id,assigned_user_id,title,starts_at,ends_at,location,notes,reminder_minutes,reminder_at,created_by_user_id) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,$9,$10,CASE WHEN $10::smallint IS NULL THEN NULL ELSE $6::timestamptz-($10::text||' minutes')::interval END,$11::uuid) RETURNING id::text AS id`, [dealerId, contactId, opportunityId, assigneeId, title, start.toISOString(), end.toISOString(), typeof body.location === "string" ? body.location.trim().slice(0, 160) || null : null, typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) || null : null, reminderMinutes, user.id]);
        const saved = await client.query<Appointment>(`SELECT ${COLUMNS} FROM public.appointments a LEFT JOIN public.app_users u ON u.id=a.assigned_user_id WHERE a.id=$1::uuid AND a.tenant_id=$2::uuid`, [inserted.rows[0]!.id, dealerId]);
        await appendAppointmentAudit(client, user, dealerId, request, "appointment.created", `Se programó la cita ${title}.`, inserted.rows[0]!.id);
        return saved.rows[0];
      });
      response.status(201).json({ appointment });
    } catch (error) { sendError(response, error, "No pudimos guardar la cita."); }
  };

  updateAppointmentsByAppointmentId: RequestHandler = async (request, response) => {
    try {
      const user = await dealerUser(this.pool, request, response); if (!user) return;
      const dealerId = typeof request.query.dealerId === "string" ? request.query.dealerId : "";
      const id = typeof request.params.appointmentId === "string" ? request.params.appointmentId : "";
      const body = request.body as Record<string, unknown>;
      const statuses = ["scheduled", "confirmed", "cancelled", "completed", "no_show"];
      if (!UUID.test(id) || !await isMember(this.pool, user.id, dealerId)) { response.status(403).json({ error: "No tienes acceso a esta cita." }); return; }
      if (body.status !== undefined && (typeof body.status !== "string" || !statuses.includes(body.status))) { response.status(400).json({ error: "El estado de la cita no es válido." }); return; }
      const appointment = await withTenant(this.pool, dealerId, async (client) => {
        await client.query("SELECT set_config('app.user_id', $1, true)", [user.id]);
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [dealerId]);
        const found = await client.query<Appointment>(`SELECT ${COLUMNS} FROM public.appointments a LEFT JOIN public.app_users u ON u.id=a.assigned_user_id WHERE a.id=$1::uuid AND a.tenant_id=$2::uuid FOR UPDATE OF a`, [id, dealerId]);
        if (!found.rows[0]) return undefined;
        const current = found.rows[0];
        const status = typeof body.status === "string" ? body.status : current.status;
        let start = current.startsAt, end = current.endsAt;
        if (body.startsAtLocal !== undefined || body.endsAtLocal !== undefined) {
          if (body.startsAtLocal === undefined || body.endsAtLocal === undefined) throw Object.assign(new Error("Envía inicio y fin para reprogramar."), { status: 400 });
          const timeZone = await timezoneFor(client, dealerId);
          start = parseLocalDateTime(body.startsAtLocal, timeZone); end = parseLocalDateTime(body.endsAtLocal, timeZone);
          await validateWindow(client, dealerId, start, end);
        }
        const assigneeId = body.assignedUserId === undefined ? current.assignedUserId : body.assignedUserId === null ? null : typeof body.assignedUserId === "string" && UUID.test(body.assignedUserId) ? body.assignedUserId : undefined;
        if (assigneeId === undefined) throw Object.assign(new Error("El responsable no es válido."), { status: 400 });
        if (assigneeId && (await client.query("SELECT 1 FROM public.user_tenant_memberships WHERE user_id=$1::uuid AND tenant_id=$2::uuid", [assigneeId, dealerId])).rowCount !== 1) throw Object.assign(new Error("El responsable debe pertenecer al dealer actual."), { status: 400 });
        if (ACTIVE_STATUS.includes(status)) {
          const conflict = await client.query("SELECT 1 FROM public.appointments WHERE tenant_id=$1::uuid AND assigned_user_id IS NOT DISTINCT FROM $2::uuid AND id<>$3::uuid AND status=ANY($4::text[]) AND starts_at<$5 AND ends_at>$6", [dealerId, assigneeId, id, ACTIVE_STATUS, end.toISOString(), start.toISOString()]);
          if (conflict.rowCount) throw Object.assign(new Error("Ese responsable ya tiene una cita en ese horario."), { status: 409 });
        }
        const reminder = body.reminderMinutes === undefined ? current.reminderMinutes : body.reminderMinutes === null ? null : Number(body.reminderMinutes);
        if (!(reminder === null || [0, 15, 30, 60].includes(reminder))) throw Object.assign(new Error("El recordatorio no es válido."), { status: 400 });
        const title = typeof body.title === "string" ? body.title.trim() : current.title;
        if (title.length < 2 || title.length > 120) throw Object.assign(new Error("El título de la cita no es válido."), { status: 400 });
        await client.query(`UPDATE public.appointments SET title=$3,assigned_user_id=$4::uuid,starts_at=$5,ends_at=$6,status=$7,location=CASE WHEN $8 THEN $9 ELSE location END,notes=CASE WHEN $10 THEN $11 ELSE notes END,reminder_minutes=$12,reminder_at=CASE WHEN $12::smallint IS NULL THEN NULL ELSE $5::timestamptz-($12::text||' minutes')::interval END,updated_at=now() WHERE id=$1::uuid AND tenant_id=$2::uuid`, [id, dealerId, title, assigneeId, start.toISOString(), end.toISOString(), status, body.location !== undefined, typeof body.location === "string" ? body.location.trim().slice(0, 160) || null : null, body.notes !== undefined, typeof body.notes === "string" ? body.notes.trim().slice(0, 1000) || null : null, reminder]);
        const saved = await client.query<Appointment>(`SELECT ${COLUMNS} FROM public.appointments a LEFT JOIN public.app_users u ON u.id=a.assigned_user_id WHERE a.id=$1::uuid AND a.tenant_id=$2::uuid`, [id, dealerId]);
        const action = status !== current.status ? `appointment.${status}` : start.getTime() !== current.startsAt.getTime() ? "appointment.rescheduled" : "appointment.updated";
        await appendAppointmentAudit(client, user, dealerId, request, action, `Se actualizó la cita ${title}.`, id);
        return saved.rows[0];
      });
      if (!appointment) { response.status(404).json({ error: "No encontramos esa cita." }); return; }
      response.json({ appointment });
    } catch (error) { sendError(response, error, "No pudimos actualizar la cita."); }
  };
}
