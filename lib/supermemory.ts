import Supermemory from "supermemory";

const apiKey = process.env.SUPERMEMORY_API_KEY;

let client: Supermemory | null = null;

function getClient(): Supermemory {
  if (!apiKey) throw new Error("SUPERMEMORY_API_KEY is not set");
  if (!client) client = new Supermemory({ apiKey });
  return client;
}

export function callerTag(businessId: string, callerPhone: string): string {
  const phone = callerPhone.replace(/\D/g, "");
  return `caller_${businessId}_${phone}`;
}

export async function rememberCallerFact(
  businessId: string,
  callerPhone: string,
  content: string,
  metadata?: Record<string, string | number | boolean>,
): Promise<void> {
  if (!apiKey) return;
  await getClient().add({
    content,
    containerTag: callerTag(businessId, callerPhone),
    metadata: { businessId, callerPhone, savedAt: new Date().toISOString(), ...metadata },
  });
}

export type CallerMemoryHit = {
  text: string;
  score: number;
};

export async function recallCallerMemories(
  businessId: string,
  callerPhone: string,
  query: string,
  limit = 5,
): Promise<CallerMemoryHit[]> {
  if (!apiKey) return [];
  const tag = callerTag(businessId, callerPhone);
  try {
    const resp = await getClient().search.memories({ q: query, containerTag: tag, limit });
    const hits: CallerMemoryHit[] = [];
    for (const r of resp.results ?? []) {
      const rec = r as unknown as Record<string, unknown>;
      const memory = rec.memory as Record<string, unknown> | undefined;
      const chunk = rec.chunk as Record<string, unknown> | undefined;
      const text =
        (typeof memory?.memory === "string" && memory.memory) ||
        (typeof memory?.content === "string" && memory.content) ||
        (typeof chunk?.content === "string" && chunk.content) ||
        (typeof rec.content === "string" && rec.content) ||
        null;
      const score = typeof rec.score === "number" ? rec.score : 0;
      if (text) hits.push({ text, score });
    }
    return hits;
  } catch (err) {
    console.warn(`[supermemory] recall failed for ${tag}:`, (err as Error).message);
    return [];
  }
}
