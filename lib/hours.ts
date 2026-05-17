import type { WeekHours, DayHours } from "./types";

type GooglePeriod = {
  open: { day: number; hour: number; minute: number };
  close?: { day: number; hour: number; minute: number };
};

type GoogleOpeningHours = {
  periods?: GooglePeriod[];
  weekdayDescriptions?: string[];
};

const DAY_NAMES: (keyof WeekHours)[] = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function pad(n: number): string {
  return n.toString().padStart(2, "0");
}

function fmt(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

function emptyWeek(): WeekHours {
  return {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: [],
  };
}

export function normalizeHours(
  regularOpeningHours: GoogleOpeningHours | undefined,
  utcOffsetMinutes: number | undefined,
): { hours: WeekHours | null; timezone: string } {
  const timezone = formatTimezone(utcOffsetMinutes);

  if (!regularOpeningHours?.periods || regularOpeningHours.periods.length === 0) {
    return { hours: null, timezone };
  }

  const week = emptyWeek();

  for (const period of regularOpeningHours.periods) {
    if (!period.open) continue;

    const openDay = DAY_NAMES[period.open.day];
    const openStr = fmt(period.open.hour, period.open.minute);

    // No close means open 24 hours.
    if (!period.close) {
      (week[openDay] as DayHours).push({ open: openStr, close: "23:59" });
      continue;
    }

    const closeStr = fmt(period.close.hour, period.close.minute);

    // Same-day period.
    if (period.close.day === period.open.day) {
      (week[openDay] as DayHours).push({ open: openStr, close: closeStr });
      continue;
    }

    // Overnight: push remainder of open day, then start of close day.
    (week[openDay] as DayHours).push({ open: openStr, close: "23:59" });
    const closeDay = DAY_NAMES[period.close.day];
    if (closeStr !== "00:00") {
      (week[closeDay] as DayHours).unshift({ open: "00:00", close: closeStr });
    }
  }

  return { hours: week, timezone };
}

function formatTimezone(utcOffsetMinutes: number | undefined): string {
  if (typeof utcOffsetMinutes !== "number") return "UTC";
  const hours = utcOffsetMinutes / 60;
  const sign = hours >= 0 ? "+" : "";
  return `UTC${sign}${hours}`;
}

export function describeHoursForPrompt(hours: WeekHours | null): string {
  if (!hours) {
    return "Hours are not on file. Default: Monday to Friday, 9 AM to 6 PM, closed weekends.";
  }
  const lines: string[] = [];
  for (const day of ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] as const) {
    const ranges = hours[day];
    if (!ranges || ranges.length === 0) {
      lines.push(`${cap(day)}: closed`);
    } else {
      lines.push(`${cap(day)}: ${ranges.map(r => `${r.open}-${r.close}`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}
