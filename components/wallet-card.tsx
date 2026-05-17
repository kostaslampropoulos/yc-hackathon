"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

type WalletStatus = {
  configured: boolean;
  baseAddress?: string | null;
  solanaAddress?: string | null;
  balance?: { baseUsdc: number; solanaUsdc: number; totalUsdc: number } | null;
  balanceError?: string | null;
  pendingBillUsd: number;
  totalCallsCount: number;
};

export function WalletCard({ businessId }: { businessId: string }) {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/wallet/${businessId}`);
      if (!res.ok) return;
      const data = (await res.json()) as WalletStatus;
      setStatus(data);
    } catch {
      // ignore
    }
  }, [businessId]);

  useEffect(() => {
    void Promise.resolve().then(load);
    const i = setInterval(load, 8000);
    return () => clearInterval(i);
  }, [load]);

  const topUp = async (amount: number) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/wallet/${businessId}/topup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amountUsd: String(amount) }),
      });
      const data = (await res.json()) as { url?: string; error?: string };
      if (data.url) {
        window.open(data.url, "_blank", "noopener,noreferrer");
      } else {
        setError(data.error ?? "Could not start top-up.");
      }
    } finally {
      setBusy(false);
    }
  };

  const settle = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/wallet/${businessId}/settle`, { method: "POST" });
      const data = (await res.json()) as { ok?: boolean; txHash?: string; error?: string };
      if (!data.ok) {
        setError(data.error ?? "Settle failed.");
      } else {
        await load();
      }
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return (
      <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
        <h2 className="font-semibold">Agent wallet</h2>
        <p className="text-sm text-muted-foreground">Loading…</p>
      </Card>
    );
  }

  if (!status.configured) {
    return (
      <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
        <h2 className="font-semibold">Agent wallet</h2>
        <p className="text-sm text-muted-foreground">
          Sponge wallet not configured. Set <span className="font-mono">SPONGE_MASTER_API_KEY</span> and re-provision to give this business its own agent wallet.
        </p>
        <div className="text-xs text-muted-foreground">
          Calls so far: {status.totalCallsCount} · Pending: ${status.pendingBillUsd.toFixed(2)}
        </div>
      </Card>
    );
  }

  const balanceUsdc = status.balance?.totalUsdc ?? 0;
  const pending = status.pendingBillUsd;
  const lowBalance = balanceUsdc < pending || balanceUsdc < 1;

  return (
    <Card className="p-6 flex flex-col gap-4 border-0 bg-muted">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h2 className="font-semibold">Agent wallet</h2>
          <p className="text-xs text-muted-foreground">Powered by Sponge — your receptionist owns its own balance</p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-mono">${balanceUsdc.toFixed(2)}</div>
          <div className="text-xs text-muted-foreground">USDC available</div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <div className="text-muted-foreground text-xs">Calls handled</div>
          <div className="font-mono">{status.totalCallsCount}</div>
        </div>
        <div>
          <div className="text-muted-foreground text-xs">Pending bill</div>
          <div className={`font-mono ${pending > 0 ? "text-amber-700" : ""}`}>${pending.toFixed(2)}</div>
        </div>
      </div>

      {status.baseAddress && (
        <div className="text-xs text-muted-foreground font-mono break-all">
          Base: {status.baseAddress}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => topUp(20)} disabled={busy}>
          {busy ? "…" : "Top up $20"}
        </Button>
        <Button size="sm" variant="outline" onClick={() => topUp(100)} disabled={busy}>
          $100
        </Button>
        <Button
          size="sm"
          variant={pending >= 0.01 ? "default" : "outline"}
          onClick={settle}
          disabled={busy || pending < 0.01}
        >
          {pending >= 0.01 ? `Settle $${pending.toFixed(2)}` : "Nothing to settle"}
        </Button>
      </div>

      {lowBalance && pending > 0 && (
        <p className="text-xs text-amber-700">
          Balance is below your pending bill — top up before settling.
        </p>
      )}
      {error && <p className="text-xs text-red-600">{error}</p>}
      {status.balanceError && (
        <p className="text-xs text-red-600">Balance lookup: {status.balanceError}</p>
      )}
    </Card>
  );
}
