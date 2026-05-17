// Pure functions, no DB calls.
// Business timezones in this app are fixed offsets like "UTC", "UTC+5", "UTC-7", "UTC+5.5".
// No DST handling — good enough for Phase 2.

const DAY_KEYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;
export type DayKey = (typeof DAY_KEYS)[number];

export function parseOffsetMinutes(tz: string): number {
  if (!tz || tz === "UTC") return 0;
  const m = tz.match(/^UTC([+-])(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  const hours = parseFloat(m[2]);
  return sign * Math.round(hours * 60);
}

function pad(n: number, width = 2): string {
  return n.toString().padStart(width, "0");
}

// Parse "YYYY-MM-DD" as midnight in business tz, return the corresponding UTC Date.
export function toBusinessDate(date: string, tz: string): Date {
  return toBusinessDateTime(`${date}T00:00:00`, tz);
}

// Parse "YYYY-MM-DDTHH:MM[:SS]" as that wall-clock time in business tz, return UTC Date.
export function toBusinessDateTime(dateTime: string, tz: string): Date {
  const m = dateTime.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`Invalid datetime: ${dateTime}`);
  const [, y, mo, d, h, mi, s] = m;
  const offset = parseOffsetMinutes(tz);
  // Treat the components as if they were UTC, then shift by -offset to get true UTC.
  const utcMs = Date.UTC(
    parseInt(y, 10),
    parseInt(mo, 10) - 1,
    parseInt(d, 10),
    parseInt(h, 10),
    parseInt(mi, 10),
    s ? parseInt(s, 10) : 0,
  );
  return new Date(utcMs - offset * 60_000);
}

// Get the wall-clock components in business tz from a UTC Date.
function getBusinessComponents(d: Date, tz: string): {
  year: number;
  month: number;
  day: number;
  hours: number;
  minutes: number;
  dayOfWeek: number; // 0=Sunday
} {
  const offset = parseOffsetMinutes(tz);
  const shifted = new Date(d.getTime() + offset * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
    dayOfWeek: shifted.getUTCDay(),
  };
}

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAY_LONG = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
];

// "Saturday, May 23 at 11:00 AM"
export function formatInBusinessTz(d: Date, tz: string): string {
  const c = getBusinessComponents(d, tz);
  const time = formatTime12(c.hours, c.minutes);
  return `${DAY_LONG[c.dayOfWeek]}, ${MONTH_NAMES[c.month - 1]} ${c.day} at ${time}`;
}

// "11:00 AM"
export function formatTimeInBusinessTz(d: Date, tz: string): string {
  const c = getBusinessComponents(d, tz);
  return formatTime12(c.hours, c.minutes);
}

// "2026-05-23"
export function formatDateInBusinessTz(d: Date, tz: string): string {
  const c = getBusinessComponents(d, tz);
  return `${c.year}-${pad(c.month)}-${pad(c.day)}`;
}

export function dayOfWeekInTz(d: Date, tz: string): DayKey {
  return DAY_KEYS[getBusinessComponents(d, tz).dayOfWeek];
}

export function dayOfWeekForDateStr(dateStr: string, tz: string): DayKey {
  const d = toBusinessDate(dateStr, tz);
  return dayOfWeekInTz(d, tz);
}

export function addDaysToDateStr(dateStr: string, days: number): string {
  // Pure calendar math — assume dateStr is "YYYY-MM-DD".
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) throw new Error(`Invalid date: ${dateStr}`);
  const d = new Date(Date.UTC(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3])));
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function todayInBusinessTz(tz: string): string {
  return formatDateInBusinessTz(new Date(), tz);
}

export function nowInBusinessTz(tz: string): string {
  const c = getBusinessComponents(new Date(), tz);
  return formatTime12(c.hours, c.minutes);
}

function formatTime12(hours: number, minutes: number): string {
  const period = hours >= 12 ? "PM" : "AM";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${h12}:${pad(minutes)} ${period}`;
}

// Parse "HH:MM" (24h) into minutes since midnight.
export function parseHHMM(s: string): number {
  const m = s.match(/^(\d{2}):(\d{2})$/);
  if (!m) throw new Error(`Invalid HH:MM: ${s}`);
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

// Minutes since midnight in business tz for a UTC Date.
export function minutesOfDayInTz(d: Date, tz: string): number {
  const c = getBusinessComponents(d, tz);
  return c.hours * 60 + c.minutes;
}

// Build a UTC Date for a specific date + minutes-of-day in business tz.
export function dateAtMinuteInTz(dateStr: string, minutesOfDay: number, tz: string): Date {
  const hours = Math.floor(minutesOfDay / 60);
  const mins = minutesOfDay % 60;
  return toBusinessDateTime(`${dateStr}T${pad(hours)}:${pad(mins)}:00`, tz);
}

export function formatMinutesAsTime12(minutesOfDay: number): string {
  const hours = Math.floor(minutesOfDay / 60);
  const mins = minutesOfDay % 60;
  return formatTime12(hours, mins);
}
