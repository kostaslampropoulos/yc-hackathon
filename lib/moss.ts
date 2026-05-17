// Moss uses N-API native bindings via @moss-dev/moss-core. To avoid loading the
// binding at build time (which fails on Vercel's "collect page data" step with
// "Cannot find native binding"), the SDK is imported dynamically inside functions
// that actually need to talk to Moss. Types are imported as type-only so the
// erased import doesn't pull the module in.

import type { MossClient as MossClientType } from "@moss-dev/moss";
import type { Business } from "./types";

const projectId = process.env.MOSS_PROJECT_ID;
const projectKey = process.env.MOSS_PROJECT_KEY;

let client: MossClientType | null = null;

export function isMossConfigured(): boolean {
  return !!projectId && !!projectKey;
}

async function getClient(): Promise<MossClientType> {
  if (client) return client;
  if (!projectId || !projectKey) {
    throw new Error("MOSS_PROJECT_ID and MOSS_PROJECT_KEY are required");
  }
  const { MossClient } = await import("@moss-dev/moss");
  client = new MossClient(projectId, projectKey);
  return client;
}

export function indexNameFor(businessId: string): string {
  // Moss index names: alphanumeric + dashes work safely.
  return `business-${businessId}`;
}

/** Split website markdown into ~800-char chunks on paragraph/heading boundaries with light overlap. */
export function chunkMarkdown(markdown: string, maxChars = 800, overlap = 100): string[] {
  if (!markdown) return [];
  const blocks = markdown
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0);

  const chunks: string[] = [];
  let current = "";

  for (const block of blocks) {
    // Block alone is bigger than the limit — split it on sentence boundaries.
    if (block.length > maxChars) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      const sentences = block.split(/(?<=[.!?])\s+/);
      let buf = "";
      for (const s of sentences) {
        if ((buf + " " + s).trim().length > maxChars && buf) {
          chunks.push(buf.trim());
          buf = buf.slice(-overlap) + " " + s;
        } else {
          buf = buf ? buf + " " + s : s;
        }
      }
      if (buf.trim()) chunks.push(buf.trim());
      continue;
    }

    if ((current + "\n\n" + block).trim().length > maxChars && current) {
      chunks.push(current.trim());
      current = current.slice(-overlap) + "\n\n" + block;
    } else {
      current = current ? current + "\n\n" + block : block;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks.slice(0, 200);
}

/** Create (or recreate) a Moss index for one business. Returns number of chunks indexed. */
export async function indexBusinessWebsite(business: Pick<Business, "_id" | "websiteMarkdown" | "name">): Promise<number> {
  if (!isMossConfigured()) {
    throw new Error("Moss not configured");
  }
  if (!business.websiteMarkdown) return 0;

  const chunks = chunkMarkdown(business.websiteMarkdown);
  if (chunks.length === 0) return 0;

  const docs = chunks.map((text, i) => ({
    id: `chunk-${i}`,
    text,
  }));

  const indexName = indexNameFor(business._id.toString());
  const c = await getClient();

  // Recreate if it already exists.
  try {
    await c.deleteIndex(indexName);
  } catch {
    // If it didn't exist, deleteIndex may throw — that's fine.
  }

  await c.createIndex(indexName, docs);
  return chunks.length;
}

/** Search a business's indexed website. Returns formatted excerpts for the LLM. */
export async function searchBusinessInfo(
  business: Pick<Business, "_id" | "mossIndexedAt">,
  query: string,
  topK = 3,
): Promise<string> {
  if (!isMossConfigured()) {
    return "Search is not available right now.";
  }
  if (!business.mossIndexedAt) {
    return "We don't have website content indexed for this business yet.";
  }
  const indexName = indexNameFor(business._id.toString());

  try {
    const c = await getClient();
    const result = await c.query(indexName, query, { topK });
    if (!result.docs || result.docs.length === 0) {
      return "No relevant information found on the website.";
    }
    return result.docs
      .map((d, i) => `${i + 1}. ${d.text.replace(/\s+/g, " ").trim().slice(0, 600)}`)
      .join("\n\n");
  } catch (err) {
    return `Search failed: ${(err as Error).message.slice(0, 200)}`;
  }
}
