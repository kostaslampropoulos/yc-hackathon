"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ProvisioningProgress } from "./provisioning-progress";

function looksLikeMapsUrl(url: string): boolean {
  return /(google\.com\/maps|maps\.app\.goo\.gl|goo\.gl\/maps)/.test(url);
}

export function PasteUrlForm() {
  const [url, setUrl] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = url.trim();
    if (!looksLikeMapsUrl(trimmed)) {
      toast.error("That doesn't look like a Google Maps URL.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mapsUrl: trimmed }),
      });
      const data = (await res.json().catch(() => ({}))) as { businessId?: string; error?: string };

      if (!res.ok || !data.businessId) {
        toast.error(data.error || `Provisioning failed (${res.status}).`);
        setSubmitting(false);
        return;
      }

      toast.success("Receptionist provisioned. Redirecting…");
      startTransition(() => {
        router.push(`/business/${data.businessId}`);
        router.refresh();
      });
    } catch (err) {
      toast.error((err as Error).message || "Provisioning failed.");
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full max-w-120">
      <form onSubmit={onSubmit} className="flex flex-col sm:flex-row gap-3 relative">
        <Input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste a Google Maps URL…"
          disabled={submitting}
          className="flex-1 h-12 text-base rounded-full pl-5"
        />
        <Button type="submit" disabled={submitting} className="h-10 px-6 absolute right-1 top-1 rounded-full">
          {submitting ? "Provisioning…" : "Get a number"}
        </Button>
      </form>
      {submitting && <ProvisioningProgress />}
    </div>
  );
}
