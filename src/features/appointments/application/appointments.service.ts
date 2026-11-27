export type Availability = {
  weekday: number;
  isAvailable: boolean;
  opensAt: string | null;
  closesAt: string | null;
};

type LocalDateTime = { year: number; month: number; day: number; hour: number; minute: number };

export const DEFAULT_APPOINTMENT_AVAILABILITY: Availability[] = [
  { weekday: 0, isAvailable: false, opensAt: null, closesAt: null },
  { weekday: 1, isAvailable: true, opensAt: "09:00", closesAt: "18:00" },
  { weekday: 2, isAvailable: true, opensAt: "09:00", closesAt: "18:00" },
  { weekday: 3, isAvailable: true, opensAt: "09:00", closesAt: "18:00" },
  { weekday: 4, isAvailable: true, opensAt: "09:00", closesAt: "18:00" },
  { weekday: 5, isAvailable: true, opensAt: "09:00", closesAt: "18:00" },
  { weekday: 6, isAvailable: false, opensAt: null, closesAt: null },
];

export function localDateTimeParts(date: Date, timeZone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute") };
}

export function parseLocalDateTime(value: unknown, timeZone: string): Date {
  if (typeof value !== "string") throw Object.assign(new Error("Indica fecha y hora local."), { status: 400 });
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw Object.assign(new Error("Usa fecha y hora válidas."), { status: 400 });
  const expected: LocalDateTime = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]), hour: Number(match[4]), minute: Number(match[5]) };
  const naive = Date.UTC(expected.year, expected.month - 1, expected.day, expected.hour, expected.minute);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== expected.year || check.getUTCMonth() + 1 !== expected.month || check.getUTCDate() !== expected.day || expected.hour > 23 || expected.minute > 59) {
    throw Object.assign(new Error("La fecha u hora no existe."), { status: 400 });
  }
  const candidates = new Set<number>();
  for (let hours = -36; hours <= 36; hours += 3) {
    const sample = naive + hours * 3_600_000;
    const local = localDateTimeParts(new Date(sample), timeZone);
    const offset = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - sample;
    const candidate = naive - offset;
    const actual = localDateTimeParts(new Date(candidate), timeZone);
    if (actual.year === expected.year && actual.month === expected.month && actual.day === expected.day && actual.hour === expected.hour && actual.minute === expected.minute) candidates.add(candidate);
  }
  if (candidates.size === 0) throw Object.assign(new Error("Esa hora local no existe por el cambio de horario del dealer."), { status: 400 });
  if (candidates.size > 1) throw Object.assign(new Error("Esa hora local es ambigua por el cambio de horario; elige otra hora."), { status: 400 });
  return new Date([...candidates][0]!);
}

export function assertAppointmentWindow(start: Date, end: Date, timeZone: string, availability: Availability | undefined): void {
  const startLocal = localDateTimeParts(start, timeZone);
  const endLocal = localDateTimeParts(end, timeZone);
  if (end <= start || startLocal.year !== endLocal.year || startLocal.month !== endLocal.month || startLocal.day !== endLocal.day) {
    throw Object.assign(new Error("La cita debe terminar después de iniciar y dentro del mismo día del dealer."), { status: 400 });
  }
  if (!availability?.isAvailable || !availability.opensAt || !availability.closesAt ||
      localTimeOf(start, timeZone) < availability.opensAt.slice(0, 5) ||
      localTimeOf(end, timeZone) > availability.closesAt.slice(0, 5)) {
    throw Object.assign(new Error("La cita queda fuera del horario disponible del dealer."), { status: 400 });
  }
}

export function weekdayOf(date: Date, timeZone: string): number {
  const parts = localDateTimeParts(date, timeZone);
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay();
}

function localTimeOf(date: Date, timeZone: string): string {
  const parts = localDateTimeParts(date, timeZone);
  return `${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")}`;
}
