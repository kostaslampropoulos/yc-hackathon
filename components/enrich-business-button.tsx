"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function EnrichBusinessButton({ businessId }: { businessId: string }) {
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function onClick() {
    setSubmitting(true);
    const toastId = toast.loading("Deep research running… (~1-2 minutes)");
    try {
      const res = await fetch(
        `/api/admin/agentphone?action=enrich-business&businessId=${encodeURIComponent(businessId)}`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        enriched?: boolean;
        markdownChars?: number;
        serviceCount?: number;
        intakeCount?: number;
        mossChunkCount?: number | null;
        agentPatched?: boolean;
        warnings?: { agentError?: string | null; mossError?: string | null };
        error?: string;
      };
      if (!res.ok || !data.enriched) {
        toast.error(data.error || `Enrich failed (${res.status}).`, { id: toastId });
        setSubmitting(false);
        return;
      }
      const summary =
        `Enriched: ${data.serviceCount ?? 0} services, ${data.intakeCount ?? 0} intake questions` +
        (data.mossChunkCount ? `, ${data.mossChunkCount} Moss chunks` : "");
      toast.success(summary, { id: toastId });
      if (data.warnings?.agentError) toast.warning(`AgentPhone update failed: ${data.warnings.agentError}`);
      if (data.warnings?.mossError) toast.warning(`Moss re-index failed: ${data.warnings.mossError}`);
      startTransition(() => {
        router.refresh();
        setSubmitting(false);
      });
    } catch (err) {
      toast.error((err as Error).message || "Enrich failed.", { id: toastId });
      setSubmitting(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={submitting}
      className="self-start"
    >
      {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
      Deep research with browser-use
    </Button>
  );
}
