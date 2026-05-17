// Tiny step-timer for one-shot latency breakdowns.
// Records cumulative + delta-since-last for each labeled step.

export type TimingSnapshot = {
  total: number;
  steps: Array<{ label: string; ms: number; cumulativeMs: number }>;
};

export class StepTimer {
  private startedAt = Date.now();
  private lastAt = this.startedAt;
  private steps: Array<{ label: string; ms: number; cumulativeMs: number }> = [];

  step(label: string): number {
    const now = Date.now();
    const ms = now - this.lastAt;
    const cumulativeMs = now - this.startedAt;
    this.steps.push({ label, ms, cumulativeMs });
    this.lastAt = now;
    return ms;
  }

  snapshot(): TimingSnapshot {
    return {
      total: Date.now() - this.startedAt,
      steps: [...this.steps],
    };
  }

  // Format: "[123ms total] hmac=1 db.findBusiness=8 ai.turn1=412 ..."
  format(prefix?: string): string {
    const total = Date.now() - this.startedAt;
    const inner = this.steps.map((s) => `${s.label}=${s.ms}`).join(" ");
    return `${prefix ? `${prefix} ` : ""}[${total}ms total] ${inner}`;
  }
}
