import Firecrawl from "@mendable/firecrawl-js";

const apiKey = process.env.FIRECRAWL_API_KEY;

let client: Firecrawl | null = null;

function getClient(): Firecrawl {
  if (!client) {
    if (!apiKey) {
      throw new Error("FIRECRAWL_API_KEY is not set");
    }
    client = new Firecrawl({ apiKey });
  }
  return client;
}

export async function scrapeWebsite(url: string, timeoutMs = 12000): Promise<string> {
  if (!apiKey) {
    throw new Error("FIRECRAWL_API_KEY is not set");
  }

  const scrapePromise = getClient().scrape(url, {
    formats: ["markdown"],
    onlyMainContent: true,
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`Firecrawl timed out after ${timeoutMs}ms`)), timeoutMs),
  );

  const doc = await Promise.race([scrapePromise, timeoutPromise]);
  const markdown = doc.markdown ?? "";
  return markdown.slice(0, 10_000);
}
