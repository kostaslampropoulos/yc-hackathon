import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { provisionRequestSchema } from "@/lib/validators";
import { resolveMapsUrlToPlaceId, getPlaceDetails, type PlaceDetails } from "@/lib/places";
import { scrapeWebsite } from "@/lib/firecrawl";
import { normalizeHours } from "@/lib/hours";
import { generateSystemPrompt } from "@/lib/prompt";
import { createAgent, provisionNumber, attachNumberToAgent, deleteAgent } from "@/lib/agentphone";
import { createInbox } from "@/lib/agentmail";
import { getBusinesses } from "@/lib/mongo";
import { indexBusinessWebsite, isMossConfigured } from "@/lib/moss";
import type { Business, BusinessForPrompt, TopReview } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

function slugForInbox(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  // Suffix a short timestamp so collisions across two same-named businesses don't fail.
  const suffix = Date.now().toString(36).slice(-5);
  return `${slug || "inbox"}-${suffix}`;
}

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

  // Step 5: generate system prompt, service menu, and intake questions
  let systemPrompt: string;
  let serviceMenu: string[];
  let intakeQuestions: string[];
  try {
    const out = await generateSystemPrompt(businessForPrompt, websiteMarkdown);
    systemPrompt = out.systemPrompt;
    serviceMenu = out.serviceMenu;
    intakeQuestions = out.intakeQuestions;
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
    const beginMessage = `Hi, thanks for calling ${businessForPrompt.name}. How can I help you today?`;
    const agent = await createAgent({
      name: businessForPrompt.name,
      transferNumber: businessForPrompt.phone,
      systemPrompt,
      webhookUrl: `${appUrl}/api/agentphone/webhook`,
      beginMessage,
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

  // Step 6b: AgentMail inbox. Non-fatal: if it fails the business still gets a
  // voice agent; the inbox can be re-attempted later.
  let agentMailInboxId: string | undefined;
  let agentMailEmail: string | undefined;
  if (process.env.AGENTMAIL_API_KEY) {
    try {
      const username = slugForInbox(businessForPrompt.name);
      const inbox = await createInbox({
        username,
        displayName: businessForPrompt.name,
        clientId: businessForPrompt.placeId,
      });
      agentMailInboxId = inbox.inboxId;
      agentMailEmail = inbox.email;
    } catch (err) {
      console.warn(`[provision] AgentMail inbox creation failed for ${businessForPrompt.name}:`, (err as Error).message);
    }
  }

  // Step 7: insert into Mongo
  const now = new Date();
  const doc: Omit<Business, "_id"> = {
    ...businessForPrompt,
    systemPrompt,
    serviceMenu,
    intakeQuestions,
    agentPhoneAgentId: agentId!,
    agentPhoneNumberId: numberId!,
    agentPhoneNumber: phoneNumber!,
    agentMailInboxId,
    agentMailEmail,
    createdAt: now,
    updatedAt: now,
  };

  let insertedId: string;
  try {
    const result = await businesses.insertOne(doc as Business);
    insertedId = result.insertedId.toString();
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

  // Step 8: index website content into Moss for in-call search.
  // Awaited so the knowledge base is ready by the time the user lands on /business/[id].
  // Failure is non-fatal: provisioning still succeeds, the dashboard exposes a "Re-index" button.
  if (isMossConfigured() && doc.websiteMarkdown) {
    const businessOid = new ObjectId(insertedId);
    const startedAt = Date.now();
    try {
      const chunkCount = await indexBusinessWebsite({
        _id: businessOid,
        websiteMarkdown: doc.websiteMarkdown,
        name: doc.name,
      });
      if (chunkCount > 0) {
        await businesses.updateOne(
          { _id: businessOid },
          { $set: { mossIndexedAt: new Date(), mossChunkCount: chunkCount } },
        );
        console.log(
          `[provision] moss indexed ${chunkCount} chunks for business ${insertedId} in ${Date.now() - startedAt}ms`,
        );
      }
    } catch (err) {
      console.warn(
        `[provision] moss indexing failed for business ${insertedId} after ${Date.now() - startedAt}ms:`,
        (err as Error).message,
      );
    }
  }

  return Response.json({ businessId: insertedId });
}
