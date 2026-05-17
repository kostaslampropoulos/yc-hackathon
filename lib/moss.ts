import { MossClient } from "@moss-dev/moss";
import type { Business, EnrichedService } from "./types";

const projectId = process.env.MOSS_PROJECT_ID;
const projectKey = process.env.MOSS_PROJECT_KEY;

let client: MossClient | null = null;
const loadedIndexes = new Set<string>();

function getClient(): MossClient {
  if (!projectId || !projectKey) throw new Error("MOSS_PROJECT_ID/MOSS_PROJECT_KEY not set");
  if (!client) client = new MossClient(projectId, projectKey);
  return client;
}

export function isMossConfigured(): boolean {
  return !!projectId && !!projectKey;
}

export function indexNameForBusiness(placeId: string): string {
  return `biz_${placeId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60)}`;
}

type MossDoc = {
  id: string;
  text: string;
  metadata?: Record<string, string>;
};

function stringifyMeta(m: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(m)) {
    if (v === null || v === undefined) continue;
    out[k] = String(v);
  }
  return out;
}

function chunkMarkdown(md: string, maxChars = 1200): string[] {
  if (!md) return [];
  const blocks = md.split(/\n\s*\n+/).map((b) => b.trim()).filter(Boolean);
  const out: string[] = [];
  let current = "";
  for (const b of blocks) {
    if ((current + "\n\n" + b).length > maxChars) {
      if (current) out.push(current);
      if (b.length <= maxChars) {
        current = b;
      } else {
        for (let i = 0; i < b.length; i += maxChars) {
          out.push(b.slice(i, i + maxChars));
        }
        current = "";
      }
    } else {
      current = current ? `${current}\n\n${b}` : b;
    }
  }
  if (current) out.push(current);
  return out;
}

function docsFromBusiness(business: {
  name: string;
  serviceMenu: string[];
  websiteMarkdown: string | null;
  summary: string | null;
  topReviews: { author: string; rating: number; text: string }[];
}): MossDoc[] {
  const docs: MossDoc[] = [];
  if (business.summary) {
    docs.push({ id: "summary", text: business.summary, metadata: stringifyMeta({ source: "summary" }) });
  }
  if (business.serviceMenu.length) {
    docs.push({
      id: "services",
      text: `Services we offer: ${business.serviceMenu.join(", ")}`,
      metadata: stringifyMeta({ source: "service-menu" }),
    });
  }
  for (let i = 0; i < business.topReviews.length; i++) {
    const r = business.topReviews[i];
    docs.push({
      id: `review_${i}`,
      text: `Review by ${r.author} (${r.rating}/5): ${r.text}`,
      metadata: stringifyMeta({ source: "review", rating: r.rating }),
    });
  }
  if (business.websiteMarkdown) {
    const chunks = chunkMarkdown(business.websiteMarkdown);
    for (let i = 0; i < chunks.length; i++) {
      docs.push({ id: `web_${i}`, text: chunks[i], metadata: stringifyMeta({ source: "website" }) });
    }
  }
  return docs;
}

export async function provisionBusinessKnowledgeIndex(input: {
  placeId: string;
  business: {
    name: string;
    serviceMenu: string[];
    websiteMarkdown: string | null;
    summary: string | null;
    topReviews: { author: string; rating: number; text: string }[];
  };
}): Promise<{ indexName: string; docCount: number } | null> {
  if (!isMossConfigured()) return null;
  const indexName = indexNameForBusiness(input.placeId);
  const docs = docsFromBusiness(input.business);
  if (docs.length === 0) return null;
  try {
    await getClient().createIndex(indexName, docs);
    loadedIndexes.delete(indexName);
    return { indexName, docCount: docs.length };
  } catch (err) {
    // Index may already exist — fall back to upsert.
    try {
      await getClient().addDocs(indexName, docs, { upsert: true });
      loadedIndexes.delete(indexName);
      return { indexName, docCount: docs.length };
    } catch (inner) {
      console.warn(
        `[moss] createIndex+addDocs both failed for ${indexName}:`,
        (err as Error).message,
        "/",
        (inner as Error).message,
      );
      return null;
    }
  }
}

export async function upsertEnrichedServices(input: {
  placeId: string;
  services: EnrichedService[];
  bookingUrl?: string | null;
  bookingProvider?: string | null;
  notes?: string | null;
}): Promise<void> {
  if (!isMossConfigured()) return;
  const indexName = indexNameForBusiness(input.placeId);
  const docs: MossDoc[] = [];
  for (const s of input.services) {
    const priceText = s.priceUsd != null ? ` priced at $${s.priceUsd}` : "";
    const durationText = s.durationMinutes ? ` (about ${s.durationMinutes} minutes)` : "";
    docs.push({
      id: `enriched_${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40)}`,
      text: `${s.name}${priceText}${durationText}.`,
      metadata: stringifyMeta({ source: "enriched-pricing", priceUsd: s.priceUsd ?? -1 }),
    });
  }
  if (input.bookingUrl) {
    docs.push({
      id: "booking_url",
      text: `Online booking: ${input.bookingUrl}${input.bookingProvider ? ` (powered by ${input.bookingProvider})` : ""}.`,
      metadata: stringifyMeta({ source: "booking" }),
    });
  }
  if (input.notes) {
    docs.push({
      id: "enriched_notes",
      text: input.notes,
      metadata: stringifyMeta({ source: "enriched-notes" }),
    });
  }
  if (docs.length === 0) return;
  try {
    await getClient().addDocs(indexName, docs, { upsert: true });
    loadedIndexes.delete(indexName);
  } catch (err) {
    console.warn(`[moss] upsertEnrichedServices failed:`, (err as Error).message);
  }
}

export type MossSearchHit = { text: string; score: number; source: string };

export async function searchBusinessKnowledge(
  business: Business,
  query: string,
  topK = 3,
): Promise<MossSearchHit[]> {
  if (!isMossConfigured()) return [];
  const indexName = indexNameForBusiness(business.placeId);
  const c = getClient();
  if (!loadedIndexes.has(indexName)) {
    try {
      await c.loadIndex(indexName);
      loadedIndexes.add(indexName);
    } catch (err) {
      console.warn(`[moss] loadIndex(${indexName}) failed:`, (err as Error).message);
      return [];
    }
  }
  try {
    const res = await c.query(indexName, query, { topK });
    return (res.docs ?? []).map((d) => ({
      text: d.text ?? "",
      score: typeof d.score === "number" ? d.score : 0,
      source: (d.metadata?.source as string) ?? "unknown",
    }));
  } catch (err) {
    console.warn(`[moss] query(${indexName}) failed:`, (err as Error).message);
    return [];
  }
}
