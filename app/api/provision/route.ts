import { after } from "next/server";
import { auth } from "@clerk/nextjs/server";
import { provisionRequestSchema } from "@/lib/validators";
import { resolveMapsUrlToPlaceId, getPlaceDetails, type PlaceDetails } from "@/lib/places";
import { scrapeWebsite } from "@/lib/firecrawl";
import { normalizeHours } from "@/lib/hours";
import { generateSystemPrompt } from "@/lib/prompt";
import { createAgent, provisionNumber, attachNumberToAgent, deleteAgent } from "@/lib/agentphone";
import { createBusinessInbox } from "@/lib/agentmail";
import { createBusinessWallet } from "@/lib/sponge";
import { provisionBusinessKnowledgeIndex } from "@/lib/moss";
import { runEnrichmentJob } from "@/lib/enrichment";
import { getBusinesses } from "@/lib/mongo";
import type { Business, BusinessForPrompt, TopReview } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

function toE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.startsWith("+")) return null;
  const digits = trimmed.slice(1).replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return `+${digits}`;
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Validate body.
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = provisionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues.map((i) => i.message).join("; ") },
      { status: 400 },
    );
  }
  const { mapsUrl } = parsed.data;

  // Step 1: URL → placeId
  let placeId: string;
  try {
    placeId = await resolveMapsUrlToPlaceId(mapsUrl);
  } catch (err) {
    return Response.json(
      { error: `Couldn't find that business on Google Maps. ${(err as Error).message}` },
      { status: 400 },
    );
  }

  // Idempotency: if this user already has this business, return it.
  const businesses = await getBusinesses();
  const existing = await businesses.findOne({ placeId, ownerId: userId });
  if (existing) {
    return Response.json({ businessId: existing._id.toString() });
  }

  // Step 2: place details
  let details: PlaceDetails;
  try {
    details = await getPlaceDetails(placeId);
  } catch (err) {
    return Response.json({ error: `Places lookup failed: ${(err as Error).message}` }, { status: 500 });
  }

  // Step 3: scrape website (with timeout, optional)
  let websiteMarkdown: string | null = null;
  if (details.websiteUri) {
    try {
      websiteMarkdown = await scrapeWebsite(details.websiteUri, 12000);
    } catch (err) {
      console.warn(`[provision] firecrawl failed for ${details.websiteUri}:`, (err as Error).message);
    }
  }

  // Step 4: normalize hours
  const { hours, timezone } = normalizeHours(details.regularOpeningHours, details.utcOffsetMinutes);

  const topReviews: TopReview[] = (details.reviews ?? [])
    .slice(0, 5)
    .map((r) => ({
      author: r.authorAttribution?.displayName ?? "Anonymous",
      rating: r.rating ?? 0,
      text: r.text?.text ?? "",
    }))
    .filter((r) => r.text.length > 0);

  const summary =
    details.editorialSummary?.text ||
    details.generativeSummary?.overview?.text ||
    details.generativeSummary?.description?.text ||
    null;

  const businessForPrompt: BusinessForPrompt = {
    ownerId: userId,
    placeId: details.id,
    mapsUrl,
    name: details.displayName?.text ?? "Unknown",
    address: details.formattedAddress ?? "",
    phone: toE164(details.internationalPhoneNumber) ?? toE164(details.nationalPhoneNumber),
    website: details.websiteUri ?? null,
    primaryType: details.primaryType ?? "",
    primaryTypeDisplay: details.primaryTypeDisplayName?.text ?? details.primaryType ?? "business",
    types: details.types ?? [],
    hours,
    timezone,
    rating: details.rating ?? null,
    reviewCount: details.userRatingCount ?? null,
    priceLevel: details.priceLevel ?? null,
    summary,
    topReviews,
    rawPlaceDetails: details,
    websiteMarkdown,
  };

  // Step 5: generate system prompt
  let systemPrompt: string;
  let serviceMenu: string[];
  try {
    const out = await generateSystemPrompt(businessForPrompt, websiteMarkdown);
    systemPrompt = out.systemPrompt;
    serviceMenu = out.serviceMenu;
  } catch (err) {
    return Response.json(
      { error: `System prompt generation failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  // Step 6: AgentPhone provisioning — sequential, fail loudly
  let agentId: string | null = null;
  let numberId: string | null = null;
  let phoneNumber: string | null = null;

  try {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const agent = await createAgent({
      name: businessForPrompt.name,
      transferNumber: businessForPrompt.phone,
      systemPrompt,
      webhookUrl: `${appUrl}/api/agentphone/webhook`,
    });
    agentId = agent.id;

    const number = await provisionNumber({ country: "US" });
    numberId = number.id;
    phoneNumber = number.phoneNumber;

    await attachNumberToAgent(agentId, numberId);
  } catch (err) {
    // Roll back agent if we created one.
    if (agentId) {
      await deleteAgent(agentId).catch(() => {});
    }
    return Response.json(
      { error: `AgentPhone provisioning failed: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  // Step 6b: AgentMail inbox + Sponge agent wallet (best-effort, run in parallel)
  const [inboxResult, walletResult] = await Promise.allSettled([
    createBusinessInbox({ businessId: placeId, businessName: businessForPrompt.name }),
    createBusinessWallet({
      businessName: businessForPrompt.name,
      placeId,
      dailySpendingLimitUsd: process.env.SPONGE_DEFAULT_DAILY_LIMIT_USD || "5",
    }),
  ]);

  let agentMailInboxId: string | undefined;
  let agentMailAddress: string | null | undefined;
  if (inboxResult.status === "fulfilled") {
    agentMailInboxId = inboxResult.value.inboxId;
    agentMailAddress = inboxResult.value.emailAddress;
  } else {
    console.warn(`[provision] agentmail inbox creation failed:`, inboxResult.reason);
  }

  let spongeAgentId: string | undefined;
  let spongeAgentApiKey: string | undefined;
  let spongeBaseAddress: string | null | undefined;
  let spongeSolanaAddress: string | null | undefined;
  if (walletResult.status === "fulfilled") {
    spongeAgentId = walletResult.value.agentId;
    spongeAgentApiKey = walletResult.value.agentApiKey;
    spongeBaseAddress = walletResult.value.baseAddress;
    spongeSolanaAddress = walletResult.value.solanaAddress;
  } else {
    console.warn(`[provision] sponge wallet creation failed:`, walletResult.reason);
  }

  // Step 7: insert into Mongo
  const now = new Date();
  const doc: Omit<Business, "_id"> = {
    ...businessForPrompt,
    systemPrompt,
    serviceMenu,
    agentPhoneAgentId: agentId!,
    agentPhoneNumberId: numberId!,
    agentPhoneNumber: phoneNumber!,
    agentMailInboxId,
    agentMailAddress,
    spongeAgentId,
    spongeAgentApiKey,
    spongeBaseAddress,
    spongeSolanaAddress,
    pendingBillUsd: 0,
    totalCallsCount: 0,
    enrichment: businessForPrompt.website
      ? { status: "pending", startedAt: now }
      : undefined,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const result = await businesses.insertOne(doc as Business);
    if (businessForPrompt.website) {
      after(() => runEnrichmentJob(result.insertedId));
    }
    after(() =>
      provisionBusinessKnowledgeIndex({
        placeId,
        business: {
          name: businessForPrompt.name,
          serviceMenu,
          websiteMarkdown,
          summary: businessForPrompt.summary,
          topReviews: businessForPrompt.topReviews,
        },
      }).catch((err) =>
        console.warn(`[provision] moss index creation failed:`, (err as Error).message),
      ),
    );
    return Response.json({ businessId: result.insertedId.toString() });
  } catch (err) {
    // Mongo failed — log orphans for cleanup; surfaces in error message.
    console.error(
      `[provision] mongo insert failed; orphaned AgentPhone resources agent=${agentId} number=${numberId}:`,
      err,
    );
    return Response.json(
      {
        error: `Database insert failed: ${(err as Error).message}. Orphaned AgentPhone agent ${agentId} / number ${numberId}.`,
      },
      { status: 500 },
    );
  }
}
