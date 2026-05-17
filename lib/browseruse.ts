import { BrowserUse } from "browser-use-sdk/v3";
import { z } from "zod";

const apiKey = process.env.BROWSER_USE_API_KEY;

let client: BrowserUse | null = null;

function getClient(): BrowserUse {
  if (!apiKey) throw new Error("BROWSER_USE_API_KEY is not set");
  if (!client) client = new BrowserUse({ apiKey });
  return client;
}

export const EnrichmentSchema = z.object({
  services: z
    .array(
      z.object({
        name: z.string().describe("Concrete service name, e.g. 'Men's haircut'"),
        priceUsd: z.number().nullable().describe("Price in USD, or null if not listed"),
        durationMinutes: z.number().nullable().describe("Duration in minutes, or null"),
      }),
    )
    .describe("Up to 15 specific services with real prices where available"),
  bookingUrl: z
    .string()
    .nullable()
    .describe("Direct URL to the online booking page (Square / Vagaro / Booksy / Calendly / etc) if discoverable, else null"),
  bookingProvider: z
    .string()
    .nullable()
    .describe("Name of the booking platform if obvious (e.g. 'Square Appointments'), else null"),
  notes: z
    .string()
    .nullable()
    .describe("Anything else a receptionist should know: parking, cash-only, walk-ins welcome, etc. 1-2 sentences max."),
});

export type EnrichmentResult = z.infer<typeof EnrichmentSchema>;

export async function enrichBusinessFromWebsite(input: {
  websiteUrl: string;
  businessName: string;
  businessType: string;
}): Promise<EnrichmentResult> {
  const c = getClient();
  const task = `You are researching a local business so an AI phone receptionist can answer caller questions accurately.

Business: ${input.businessName}
Type: ${input.businessType}
Website: ${input.websiteUrl}

Steps:
1. Start at the website above.
2. Find the services/menu/pricing page. Click into it.
3. If there is an online booking widget (Square Appointments, Vagaro, Booksy, Calendly, Mindbody, OpenTable, Resy, Tock, GlossGenius, Fresha), capture its direct URL.
4. Extract specific services with prices and durations where listed. Do NOT invent prices.
5. Note anything else useful for a receptionist (parking, cash-only, walk-ins, deposit policy).

Return at most 15 services. Real names only — no generic categories.`;

  const result = await c.run(task, {
    schema: EnrichmentSchema,
    model: "bu-max",
    maxCostUsd: 0.75,
  });

  return result.output;
}
