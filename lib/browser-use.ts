import { BrowserUse } from "browser-use-sdk/v3";

const apiKey = process.env.BROWSER_USE_API_KEY;

let client: BrowserUse | null = null;

function getClient(): BrowserUse {
  if (!client) {
    if (!apiKey) throw new Error("BROWSER_USE_API_KEY is not set");
    client = new BrowserUse({ apiKey });
  }
  return client;
}

export function isBrowserUseConfigured(): boolean {
  return !!apiKey;
}

// Kicks off an agentic browse, polls until done. Typical latency: 30-120s. Cost: $0.05-$1 per call.
// Returns markdown capped at 10k chars (matches scrapeWebsite contract).
export async function deepResearchBusiness(input: {
  name: string;
  websiteUri: string;
  primaryTypeDisplay: string;
}): Promise<string> {
  const task = `Research the business "${input.name}" (${input.primaryTypeDisplay}) starting from ${input.websiteUri}.
Visit the homepage, services/menu page, about page, FAQ, and pricing page if they exist (max 6 pages total).
Return a single markdown document covering:
- Full list of services offered, with descriptions
- Pricing if visible (per service)
- Policies (cancellation, payment, accessibility, etc.)
- Anything unique that would help a phone receptionist answer caller questions
Do NOT include nav menus, footers, or boilerplate. Maximum 8000 characters.`;

  const result = await getClient().run(task);
  const out = typeof result.output === "string" ? result.output : String(result.output ?? "");
  return out.slice(0, 10_000);
}
