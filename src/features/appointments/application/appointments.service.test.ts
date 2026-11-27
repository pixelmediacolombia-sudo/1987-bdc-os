import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAppointmentWindow,
  DEFAULT_APPOINTMENT_AVAILABILITY,
  parseLocalDateTime,
} from "@/features/appointments/application/appointments.service";

test("appointment service converts dealer-local time to an unambiguous instant", () => {
  assert.equal(parseLocalDateTime("2026-07-15T10:30", "America/New_York").toISOString(), "2026-07-15T14:30:00.000Z");
});

test("appointment service rejects nonexistent and ambiguous daylight-saving times", () => {
  assert.throws(() => parseLocalDateTime("2026-03-08T02:30", "America/New_York"), /no existe por el cambio de horario/);
  assert.throws(() => parseLocalDateTime("2026-11-01T01:30", "America/New_York"), /es ambigua por el cambio de horario/);
});

test("appointment service checks duration, dealer day and availability", () => {
  const availability = DEFAULT_APPOINTMENT_AVAILABILITY[1];
  assertAppointmentWindow(new Date("2026-07-15T14:00:00.000Z"), new Date("2026-07-15T15:00:00.000Z"), "America/New_York", availability);
  assert.throws(() => assertAppointmentWindow(new Date("2026-07-15T14:00:00.000Z"), new Date("2026-07-15T22:30:00.000Z"), "America/New_York", availability), /fuera del horario/);
  assert.throws(() => assertAppointmentWindow(new Date("2026-07-15T23:00:00.000Z"), new Date("2026-07-16T04:00:00.000Z"), "America/New_York", availability), /mismo día/);
});
