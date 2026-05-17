"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function IndexBusinessButton({
  businessId,
  alreadyIndexed,
}: {
  businessId: string;
  alreadyIndexed: boolean;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function onClick() {
    setSubmitting(true);
    try {
      const res = await fetch(
        `/api/admin/agentphone?action=index-business&businessId=${encodeURIComponent(businessId)}`,
        { method: "POST" },
      );
      const data = (await res.json().catch(() => ({}))) as {
        indexed?: { chunkCount: number };
        error?: string;
      };
      if (!res.ok || !data.indexed) {
        toast.error(data.error || `Indexing failed (${res.status}).`);
        setSubmitting(false);
        return;
      }
      toast.success(`Indexed ${data.indexed.chunkCount} chunks.`);
      startTransition(() => {
        router.refresh();
        setSubmitting(false);
      });
    } catch (err) {
      toast.error((err as Error).message || "Indexing failed.");
      setSubmitting(false);
    }
  }

  return (
    <Button
      type="button"
      size="sm"
      variant={alreadyIndexed ? "outline" : "default"}
      onClick={onClick}
      disabled={submitting}
      className="self-start"
    >
      {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin mr-1.5" />}
      {alreadyIndexed ? "Re-index" : "Index now"}
    </Button>
  );
}
