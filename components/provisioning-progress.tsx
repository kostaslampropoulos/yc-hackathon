"use client";

import { useEffect, useState } from "react";
import { Loader2, Check } from "lucide-react";

const STAGES = [
  { label: "Reading business profile", durationMs: 15_000 },
  { label: "Scanning website", durationMs: 15_000 },
  { label: "Designing your receptionist", durationMs: 15_000 },
  { label: "Provisioning phone number", durationMs: 15_000 },
];

export function ProvisioningProgress() {
  const [stage, setStage] = useState(0);

  useEffect(() => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let elapsed = 0;
    for (let i = 0; i < STAGES.length - 1; i++) {
      elapsed += STAGES[i].durationMs;
      timers.push(setTimeout(() => setStage((s) => Math.max(s, i + 1)), elapsed));
    }
    return () => {
      for (const t of timers) clearTimeout(t);
    };
  }, []);

  return (
    <div className="flex flex-col gap-3 mt-6">
      {STAGES.map((s, i) => {
        const status = i < stage ? "done" : i === stage ? "active" : "pending";
        return (
          <div
            key={s.label}
            className={`flex items-center gap-3 px-4 py-3 rounded-md border ${
              status === "active"
                ? "border-primary/40 bg-primary/5"
                : status === "done"
                  ? "border-border bg-card"
                  : "border-border bg-card opacity-50"
            }`}
          >
            <div className="w-5 h-5 flex items-center justify-center shrink-0">
              {status === "done" ? (
                <Check className="w-4 h-4 text-primary" />
              ) : status === "active" ? (
                <Loader2 className="w-4 h-4 animate-spin text-primary" />
              ) : (
                <div className="w-2 h-2 rounded-full bg-muted-foreground" />
              )}
            </div>
            <span className={`text-sm ${status === "active" ? "font-medium" : ""}`}>{s.label}</span>
          </div>
        );
      })}
    </div>
  );
}
