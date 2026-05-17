"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { PhoneIncoming, CalendarCheck, Loader2 } from "lucide-react";

type Call = {
  id: string;
  callId: string;
  callerPhone: string;
  status: "active" | "ended";
  startedAt: string;
  endedAt: string | null;
  summary: string | null;
  durationSeconds: number | null;
  bookingMade: boolean;
  lastUtterance: { role: string; text: string } | null;
};

function maskPhone(phone: string): string {
  if (!phone) return phone;
  return phone.length > 4 ? `${phone.slice(0, -4)}••••` : phone;
}

function formatDuration(seconds: number | null): string {
  if (!seconds) return "—";
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function RecentCalls({ businessId }: { businessId: string }) {
  const [calls, setCalls] = useState<Call[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      try {
        const res = await fetch(`/api/business/${businessId}/calls`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { calls: Call[] };
        if (!cancelled) setCalls(data.calls);
      } catch {
        // ignore transient errors
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
          <PhoneIncoming className="w-4 h-4" />
          Recent calls
        </h2>
        <span className="text-xs text-muted-foreground">Live</span>
      </div>
      {calls === null ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : calls.length === 0 ? (
        <div className="text-sm text-muted-foreground">No calls yet.</div>
      ) : (
        <ul className="flex flex-col gap-3">
          {calls.map((c) => (
            <li key={c.id} className="flex flex-col gap-1 rounded-md bg-background p-3">
              <div className="flex items-center justify-between gap-2 text-sm">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-mono truncate">{maskPhone(c.callerPhone)}</span>
                  {c.status === "active" && (
                    <span className="inline-flex items-center gap-1 text-xs text-primary">
                      <Loader2 className="w-3 h-3 animate-spin" /> in progress
                    </span>
                  )}
                  {c.bookingMade && (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
                      <CalendarCheck className="w-3 h-3" /> booked
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground shrink-0">
                  {timeAgo(c.startedAt)} · {formatDuration(c.durationSeconds)}
                </span>
              </div>
              {(c.summary || c.lastUtterance) && (
                <p className="text-xs text-muted-foreground line-clamp-2">
                  {c.summary || (c.lastUtterance ? `${c.lastUtterance.role}: ${c.lastUtterance.text}` : "")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
