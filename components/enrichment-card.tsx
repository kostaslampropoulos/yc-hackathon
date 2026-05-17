"use client";

import { useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type EnrichedService = { name: string; priceUsd: number | null; durationMinutes: number | null };
type Enrichment = {
  status: "pending" | "running" | "succeeded" | "failed";
  services?: EnrichedService[];
  bookingUrl?: string | null;
  bookingProvider?: string | null;
  notes?: string | null;
  error?: string;
};

export function EnrichmentCard({
  businessId,
  initial,
}: {
  businessId: string;
  initial: Enrichment | null | undefined;
}) {
  const [enrichment, setEnrichment] = useState<Enrichment | null>(initial ?? null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    if (!enrichment || enrichment.status === "succeeded" || enrichment.status === "failed") return;
    let cancelled = false;
    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/enrichment/${businessId}`);
        if (!res.ok) return;
        const data = (await res.json()) as { enrichment: Enrichment | null };
        if (cancelled) return;
        if (data.enrichment) setEnrichment(data.enrichment);
        if (data.enrichment && (data.enrichment.status === "succeeded" || data.enrichment.status === "failed")) {
          clearInterval(interval);
        }
      } catch {
        // ignore transient errors
      }
    }, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [businessId, enrichment]);

  const rerun = async () => {
    setRefreshing(true);
    try {
      await fetch(`/api/enrichment/${businessId}`, { method: "POST" });
      setEnrichment({ status: "pending" });
    } finally {
      setRefreshing(false);
    }
  };

  if (!enrichment) {
    return (
      <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Deep website research</h2>
          <Button variant="outline" size="sm" onClick={rerun} disabled={refreshing}>
            {refreshing ? "Starting..." : "Run with Browser Use"}
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Browser Use can drive a real browser through your booking page to pull live services, prices, and discover your booking widget. Your agent will quote real prices once it&apos;s done.
        </p>
      </Card>
    );
  }

  if (enrichment.status === "pending" || enrichment.status === "running") {
    return (
      <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
        <div className="flex items-center gap-2">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-500" />
          <h2 className="font-semibold">Browser Use is researching your site…</h2>
        </div>
        <p className="text-sm text-muted-foreground">
          A real browser is driving through your website to find services, prices, and your booking widget. This usually takes 30–90 seconds. Your receptionist already works — this just makes it sharper.
        </p>
      </Card>
    );
  }

  if (enrichment.status === "failed") {
    return (
      <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Deep research didn&apos;t finish</h2>
          <Button variant="outline" size="sm" onClick={rerun} disabled={refreshing}>
            Retry
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">{enrichment.error ?? "Unknown error."}</p>
      </Card>
    );
  }

  const services = enrichment.services ?? [];
  return (
    <Card className="p-6 flex flex-col gap-4 border-0 bg-muted">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold">Live services from your website</h2>
          <p className="text-xs text-muted-foreground">Pulled by Browser Use</p>
        </div>
        <Button variant="outline" size="sm" onClick={rerun} disabled={refreshing}>
          {refreshing ? "Starting..." : "Re-run"}
        </Button>
      </div>

      {enrichment.bookingUrl && (
        <div className="text-sm">
          Booking page detected
          {enrichment.bookingProvider ? ` (${enrichment.bookingProvider})` : ""}:{" "}
          <a
            href={enrichment.bookingUrl}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2"
          >
            open
          </a>
        </div>
      )}

      {services.length > 0 && (
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-sm">
          {services.map((s) => (
            <li key={s.name} className="text-muted-foreground flex items-baseline justify-between gap-3">
              <span>• {s.name}{s.durationMinutes ? ` · ${s.durationMinutes}m` : ""}</span>
              {s.priceUsd != null && <span className="font-mono">${s.priceUsd}</span>}
            </li>
          ))}
        </ul>
      )}

      {enrichment.notes && (
        <p className="text-xs text-muted-foreground italic">{enrichment.notes}</p>
      )}
    </Card>
  );
}
