import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import express from "express";
import { Pool } from "pg";
import test from "node:test";
import { createIdentityRouter } from "@/features/identity/presentation/http/identity.routes";
import { ensureTenantRowLevelSecurity } from "@/features/identity/infrastructure/persistence/postgres/tenant-rls.migration";
import { ensureAdminAuditTable } from "@/features/identity/infrastructure/persistence/postgres/admin-audit.migration";
import { ensureAppointmentsTables } from "@/features/appointments/infrastructure/persistence/postgres/appointments.migration";
import { ensureOpportunitiesTable } from "@/features/opportunities/infrastructure/persistence/postgres/opportunities.migration";
import { ensureRuntimeRolePrivileges } from "@/infrastructure/database/runtime-role.migration";

const enabled = process.env.APPOINTMENTS_E2E === "1" && Boolean(process.env.DATABASE_URL);
test("local appointments enforce dealer availability, timezone, overlap and tenant isolation", { skip: !enabled }, async () => {
  const ssl = ["1", "true", "yes"].includes((process.env.PGSSL ?? "").toLowerCase()) ? { rejectUnauthorized: false } : undefined;
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl });
  const apiPool = new Pool({ connectionString: process.env.RUNTIME_DATABASE_URL ?? process.env.DATABASE_URL, ssl, ...(process.env.RUNTIME_DATABASE_URL ? {} : { options: "-c role=bdc" }) });
  const migrationPool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL, ssl });
  await ensureAdminAuditTable(migrationPool); await ensureOpportunitiesTable(migrationPool); await ensureAppointmentsTables(migrationPool); await ensureTenantRowLevelSecurity(migrationPool); await ensureRuntimeRolePrivileges(migrationPool); await migrationPool.end();
  const fixture = await pool.connect();
  const tenantIds = [randomUUID(), randomUUID()]; const userIds: string[] = []; const contactIds = tenantIds.map(() => randomUUID());
  const tokens = tenantIds.map(() => randomBytes(32).toString("base64url")); const hashes = tokens.map((token) => createHash("sha256").update(token).digest("hex"));
  const refs = ["create", "collision", "cancel", "restore", "hours", "cross"].map((label) => `crm04-${label}-${randomUUID()}`);
  const app = express(); app.use(express.json()); app.use("/auth", createIdentityRouter(apiPool, { production: false }));
  let server: ReturnType<typeof app.listen> | undefined;
  const request = (port: number, token: string, path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { cookie: `bdc_os_session=${token}`, ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
  try {
    const users = await Promise.all(tenantIds.map((_, i) => fixture.query<{ id: string }>("INSERT INTO public.app_users (email,display_name,account_type,status) VALUES ($1,$2,'user','active') RETURNING id::text AS id", [`crm04-${randomUUID()}@example.test`, `CRM04 Dealer ${i + 1}`])));
    userIds.push(...users.map((result) => result.rows[0]!.id));
    for (const [i, tenantId] of tenantIds.entries()) {
      await fixture.query("BEGIN"); await fixture.query("SET LOCAL ROLE bdc"); await fixture.query("SELECT set_config('app.tenant_id',$1,true)", [tenantId]);
      await fixture.query("INSERT INTO public.tenants (dealer_id,dealer_name,timezone,policy_version,status,sofia_enabled,qualification_flow_enabled,qualification_signal_enabled) VALUES ($1,$2,$3,'crm04-e2e','active',false,false,false)", [tenantId, `CRM04 E2E Dealer ${i + 1}`, i === 0 ? "America/New_York" : "America/Bogota"]);
      await fixture.query("INSERT INTO public.contacts (id,tenant_id,provider_contact_id,display_name,phone,preferred_language,consent_state) VALUES ($1,$2,$3,$4,'+1 555 0104','es','unknown')", [contactIds[i], tenantId, `manual:${contactIds[i]}`, `CRM04 Contact ${i + 1}`]);
      await fixture.query("INSERT INTO public.user_tenant_memberships (user_id,tenant_id) VALUES ($1,$2)", [userIds[i], tenantId]); await fixture.query("COMMIT");
      await fixture.query("INSERT INTO public.app_sessions (user_id,token_hash,expires_at) VALUES ($1,$2,now()+interval '15 minutes')", [userIds[i], hashes[i]]);
    }
    server = app.listen(0, "127.0.0.1"); await once(server, "listening"); const address = server.address(); assert.ok(address && typeof address !== "string"); const port = address.port;
    const hoursResponse = await request(port, tokens[0]!, `/auth/calendar/availability?dealerId=${tenantIds[0]}`); assert.equal(hoursResponse.status, 200);
    const hoursBody = await hoursResponse.json() as { availability: Array<{ weekday: number; isAvailable: boolean; opensAt: string | null; closesAt: string | null }>; timeZone: string };
    assert.equal(hoursBody.timeZone, "America/New_York"); assert.equal(hoursBody.availability.length, 7); assert.equal(hoursBody.availability.find((day) => day.weekday === 1)?.opensAt?.slice(0, 5), "09:00");
    const payload = { dealerId: tenantIds[0], title: "Prueba de manejo CRM04", contactId: contactIds[0], assignedUserId: userIds[0], startsAtLocal: "2026-12-07T09:00", endsAtLocal: "2026-12-07T10:00", reminderMinutes: 15 };
    const createdResponse = await request(port, tokens[0]!, "/auth/appointments", { method: "POST", headers: { "x-correlation-id": refs[0]! }, body: JSON.stringify(payload) }); assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json() as { appointment: { id: string; startsAt: string; endsAt: string; reminderAt: string; status: string } };
    assert.deepEqual([created.appointment.startsAt, created.appointment.endsAt, created.appointment.status], ["2026-12-07T14:00:00.000Z", "2026-12-07T15:00:00.000Z", "scheduled"]);
    assert.equal(created.appointment.reminderAt, "2026-12-07T13:45:00.000Z");
    const overlap = await request(port, tokens[0]!, "/auth/appointments", { method: "POST", headers: { "x-correlation-id": refs[1]! }, body: JSON.stringify({ ...payload, title: "Cita duplicada" }) }); assert.equal(overlap.status, 409);
    const outside = await request(port, tokens[0]!, "/auth/appointments", { method: "POST", body: JSON.stringify({ ...payload, title: "Fuera de horario", startsAtLocal: "2026-12-07T18:15", endsAtLocal: "2026-12-07T19:00" }) }); assert.equal(outside.status, 400);
    const nonexistent = await request(port, tokens[0]!, "/auth/appointments", { method: "POST", body: JSON.stringify({ ...payload, title: "Hora inexistente", startsAtLocal: "2026-03-08T02:30", endsAtLocal: "2026-03-08T03:30" }) }); assert.equal(nonexistent.status, 400);
    const ambiguous = await request(port, tokens[0]!, "/auth/appointments", { method: "POST", body: JSON.stringify({ ...payload, title: "Hora ambigua", startsAtLocal: "2026-11-01T01:30", endsAtLocal: "2026-11-01T02:30" }) }); assert.equal(ambiguous.status, 400);
    const crossTenant = await request(port, tokens[1]!, `/auth/appointments?dealerId=${tenantIds[0]}&from=2026-12-07T00:00:00.000Z&to=2026-12-08T00:00:00.000Z`, { headers: { "x-correlation-id": refs[5]! } }); assert.equal(crossTenant.status, 403);
    const cancel = await request(port, tokens[0]!, `/auth/appointments/${created.appointment.id}?dealerId=${tenantIds[0]}`, { method: "PATCH", headers: { "x-correlation-id": refs[2]! }, body: JSON.stringify({ status: "cancelled" }) }); assert.equal(cancel.status, 200);
    const replacement = await request(port, tokens[0]!, "/auth/appointments", { method: "POST", body: JSON.stringify({ ...payload, title: "Cita tras cancelación" }) }); assert.equal(replacement.status, 201);
    const list = await request(port, tokens[0]!, `/auth/appointments?dealerId=${tenantIds[0]}&from=2026-12-07T00:00:00.000Z&to=2026-12-08T00:00:00.000Z`); assert.equal(list.status, 200);
    const listBody = await list.json() as { appointments: Array<{ status: string }> }; assert.deepEqual(listBody.appointments.map((item) => item.status).sort(), ["cancelled", "scheduled"]);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise<void>((resolve) => server!.close(() => resolve())); }
    await fixture.query("DELETE FROM public.admin_audit_events WHERE reference_id = ANY($1::text[])", [refs]).catch(() => undefined);
    await fixture.query("DELETE FROM public.app_sessions WHERE token_hash = ANY($1::text[])", [hashes]).catch(() => undefined);
    await fixture.query("DELETE FROM public.tenants WHERE dealer_id = ANY($1::uuid[])", [tenantIds]).catch(() => undefined);
    if (userIds.length) await fixture.query("DELETE FROM public.app_users WHERE id = ANY($1::uuid[])", [userIds]).catch(() => undefined);
    fixture.release(); await apiPool.end(); await pool.end();
  }
});
