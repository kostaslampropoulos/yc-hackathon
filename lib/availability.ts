import type { Business, Appointment } from "./types";
import type { Collection } from "mongodb";
import {
  dayOfWeekForDateStr,
  parseHHMM,
  toBusinessDate,
  addDaysToDateStr,
  dateAtMinuteInTz,
  formatMinutesAsTime12,
  minutesOfDayInTz,
} from "./dates";

const SLOT_STEP_MINUTES = 30;

type AppointmentsCollection = Collection<Appointment>;

function defaultDayHours(): Array<{ open: string; close: string }> {
  // Used only when business.hours is null.
  return [{ open: "09:00", close: "18:00" }];
}

export async function getAvailableSlots(
  business: Business,
  dateStr: string,
  durationMinutes: number,
  appointmentsCollection: AppointmentsCollection,
): Promise<{ dayKey: string; slots: string[]; isClosed: boolean }> {
  const dayKey = dayOfWeekForDateStr(dateStr, business.timezone);

  const openWindows = business.hours
    ? business.hours[dayKey] ?? []
    : ["monday", "tuesday", "wednesday", "thursday", "friday"].includes(dayKey)
      ? defaultDayHours()
      : [];

  if (openWindows.length === 0) {
    return { dayKey, slots: [], isClosed: true };
  }

  // Build candidate slot start minutes (every SLOT_STEP_MINUTES, fitting durationMinutes).
  const candidates: number[] = [];
  for (const w of openWindows) {
    const openMin = parseHHMM(w.open);
    const closeMin = parseHHMM(w.close);
    for (let m = openMin; m + durationMinutes <= closeMin; m += SLOT_STEP_MINUTES) {
      candidates.push(m);
    }
  }

  if (candidates.length === 0) {
    return { dayKey, slots: [], isClosed: false };
  }

  // Query existing appointments overlapping this date in business tz.
  const dayStartUtc = toBusinessDate(dateStr, business.timezone);
  const dayEndUtc = new Date(dayStartUtc.getTime() + 24 * 60 * 60_000);

  const existing = await appointmentsCollection
    .find({
      businessId: business._id,
      status: "booked",
      startTime: { $lt: dayEndUtc },
      endTime: { $gt: dayStartUtc },
    })
    .toArray();

  // Convert existing appointments to (startMin, endMin) ranges in business tz.
  const busy = existing.map((a) => ({
    start: minutesOfDayInTz(a.startTime, business.timezone),
    end: minutesOfDayInTz(a.endTime, business.timezone),
  }));

  const free = candidates.filter((startMin) => {
    const endMin = startMin + durationMinutes;
    return !busy.some((b) => b.start < endMin && b.end > startMin);
  });

  return {
    dayKey,
    slots: free.map(formatMinutesAsTime12),
    isClosed: false,
  };
}

export async function findNextOpenSlots(
  business: Business,
  fromDateStr: string,
  count: number,
  durationMinutes: number,
  appointmentsCollection: AppointmentsCollection,
): Promise<Array<{ date: string; dayKey: string; slots: string[] }>> {
  const out: Array<{ date: string; dayKey: string; slots: string[] }> = [];
  let cursor = fromDateStr;
  for (let i = 0; i < 14 && out.length < count; i++) {
    const { dayKey, slots, isClosed } = await getAvailableSlots(
      business,
      cursor,
      durationMinutes,
      appointmentsCollection,
    );
    if (!isClosed && slots.length > 0) {
      out.push({ date: cursor, dayKey, slots: slots.slice(0, 4) });
    }
    cursor = addDaysToDateStr(cursor, 1);
  }
  return out;
}

// Re-check that a specific start..end UTC range is still free.
export async function isSlotAvailable(
  business: Business,
  startTime: Date,
  endTime: Date,
  appointmentsCollection: AppointmentsCollection,
): Promise<boolean> {
  const conflict = await appointmentsCollection.findOne({
    businessId: business._id,
    status: "booked",
    startTime: { $lt: endTime },
    endTime: { $gt: startTime },
  });
  return !conflict;
}

export { dateAtMinuteInTz };
