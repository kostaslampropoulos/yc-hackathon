"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Calendar } from "lucide-react";

type Appointment = {
  id: string;
  callerName: string;
  callerPhone: string;
  service: string;
  startTime: string;
  durationMinutes: number;
  status: "booked" | "cancelled";
};

// Mirrors lib/dates.ts but inlined for the client.
function parseOffsetMinutes(tz: string): number {
  if (!tz || tz === "UTC") return 0;
  const m = tz.match(/^UTC([+-])(\d+(?:\.\d+)?)$/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * Math.round(parseFloat(m[2]) * 60);
}

function formatInTz(iso: string, tz: string): string {
  const d = new Date(iso);
  const offset = parseOffsetMinutes(tz);
  const shifted = new Date(d.getTime() + offset * 60_000);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  const day = days[shifted.getUTCDay()];
  const month = months[shifted.getUTCMonth()];
  const date = shifted.getUTCDate();
  let h = shifted.getUTCHours();
  const m = shifted.getUTCMinutes();
  const period = h >= 12 ? "PM" : "AM";
  h = h % 12 === 0 ? 12 : h % 12;
  return `${day}, ${month} ${date} · ${h}:${m.toString().padStart(2, "0")} ${period}`;
}

export function RecentAppointments({ businessId }: { businessId: string }) {
  const [appointments, setAppointments] = useState<Appointment[] | null>(null);
  const [timezone, setTimezone] = useState<string>("UTC");

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(`/api/business/${businessId}/appointments`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { appointments: Appointment[]; timezone: string };
        if (!cancelled) {
          setAppointments(data.appointments);
          setTimezone(data.timezone || "UTC");
        }
      } catch {
        // ignore
      }
    }
    tick();
    const interval = setInterval(tick, 3000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [businessId]);

  return (
    <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold flex items-center gap-2">
          <Calendar className="w-4 h-4" />
          Upcoming appointments
        </h2>
        <span className="text-xs text-muted-foreground">{timezone}</span>
      </div>
      {appointments === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : appointments.length === 0 ? (
        <div className="text-sm text-muted-foreground">No appointments yet.</div>
      ) : (
        <ul className="flex flex-col gap-3">
          {appointments.map((a) => (
            <li key={a.id} className="flex flex-col gap-1 rounded-md bg-background p-3">
              <div className="flex items-center justify-between gap-2 text-sm">
                <span className="font-medium truncate">{a.callerName}</span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {a.durationMinutes}m
                </span>
              </div>
              <div className="text-xs text-muted-foreground truncate">{a.service}</div>
              <div className="text-xs text-muted-foreground">{formatInTz(a.startTime, timezone)}</div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
