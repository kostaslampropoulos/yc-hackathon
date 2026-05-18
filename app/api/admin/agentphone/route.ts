// Dev-only admin: inspect and fix AgentPhone agents, and (re)index Moss knowledge bases.
// GET  /api/admin/agentphone?action=voices
// GET  /api/admin/agentphone?action=agent&id=<agentId>
// GET  /api/admin/agentphone?action=business&businessId=<mongoId>
// POST /api/admin/agentphone?action=fix-agent&businessId=<mongoId>
//      Patches the agent with a valid voice + beginMessage from the Mongo doc.
// POST /api/admin/agentphone?action=index-business&businessId=<mongoId>
//      Indexes (or re-indexes) the business's websiteMarkdown into Moss.
// POST /api/admin/agentphone?action=enrich-business&businessId=<mongoId>
//      Runs browser-use deep research, regenerates prompt/menu/intake, updates AgentPhone,
//      re-indexes Moss. Synchronous; takes 30-120s. Requires maxDuration >= 300.

import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses } from "@/lib/mongo";
import { updateAgent } from "@/lib/agentphone";
import { indexBusinessWebsite, isMossConfigured } from "@/lib/moss";
import { deepResearchBusiness, isBrowserUseConfigured } from "@/lib/browser-use";
import { generateSystemPrompt } from "@/lib/prompt";
import type { BusinessForPrompt } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 300;

const API_KEY = process.env.AGENTPHONE_API_KEY;
const BASE_URL = process.env.AGENTPHONE_BASE_URL || "https://api.agentphone.to/v1";
const DEFAULT_VOICE_ID = process.env.AGENTPHONE_DEFAULT_VOICE || "openai-Nova";

async function callAgentPhone(path: string) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    cache: "no-store",
  });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: res.status, path, body };
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!API_KEY) return Response.json({ error: "AGENTPHONE_API_KEY not set" }, { status: 500 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "voices";

  if (action === "voices") {
    return Response.json(await callAgentPhone("/agents/voices"));
  }

  if (action === "agent") {
    const agentId = url.searchParams.get("id");
    if (!agentId) return Response.json({ error: "missing id" }, { status: 400 });
    return Response.json(await callAgentPhone(`/agents/${agentId}`));
  }

  if (action === "business") {
    const businessId = url.searchParams.get("businessId");
    if (!businessId) return Response.json({ error: "missing businessId" }, { status: 400 });
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(businessId);
    } catch {
      return Response.json({ error: "invalid businessId" }, { status: 400 });
    }
    const businesses = await getBusinesses();
    const business = await businesses.findOne({ _id: objectId });
    if (!business || business.ownerId !== userId) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    const agentInfo = await callAgentPhone(`/agents/${business.agentPhoneAgentId}`);
    return Response.json({
      mongo: {
        agentPhoneAgentId: business.agentPhoneAgentId,
        agentPhoneNumberId: business.agentPhoneNumberId,
        agentPhoneNumber: business.agentPhoneNumber,
        transferNumber: business.phone,
      },
      agentphone: agentInfo,
    });
  }

  return Response.json({ error: `unknown action ${action}` }, { status: 400 });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!API_KEY) return Response.json({ error: "AGENTPHONE_API_KEY not set" }, { status: 500 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "fix-agent") {
    const businessId = url.searchParams.get("businessId");
    if (!businessId) return Response.json({ error: "missing businessId" }, { status: 400 });
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(businessId);
    } catch {
      return Response.json({ error: "invalid businessId" }, { status: 400 });
    }

    const businesses = await getBusinesses();
    const business = await businesses.findOne({ _id: objectId });
    if (!business || business.ownerId !== userId) {
      return Response.json({ error: "not found" }, { status: 404 });
    }

    const beginMessage = `Hi, thanks for calling ${business.name}. How can I help you today?`;
    try {
      const result = await updateAgent(business.agentPhoneAgentId, {
        voice: DEFAULT_VOICE_ID,
        beginMessage,
      });
      return Response.json({
        patched: { voice: DEFAULT_VOICE_ID, beginMessage },
        agent: result,
      });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  if (action === "enrich-business") {
    if (!isBrowserUseConfigured()) {
      return Response.json({ error: "BROWSER_USE_API_KEY not set" }, { status: 500 });
    }
    const businessId = url.searchParams.get("businessId");
    if (!businessId) return Response.json({ error: "missing businessId" }, { status: 400 });
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(businessId);
    } catch {
      return Response.json({ error: "invalid businessId" }, { status: 400 });
    }

    const businesses = await getBusinesses();
    const business = await businesses.findOne({ _id: objectId });
    if (!business || business.ownerId !== userId) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (!business.website) {
      return Response.json({ error: "business has no website to research" }, { status: 400 });
    }

    let newMarkdown: string;
    try {
      newMarkdown = await deepResearchBusiness({
        name: business.name,
        websiteUri: business.website,
        primaryTypeDisplay: business.primaryTypeDisplay,
      });
    } catch (err) {
      return Response.json({ error: `browser-use failed: ${(err as Error).message}` }, { status: 500 });
    }
    if (!newMarkdown.trim()) {
      return Response.json({ error: "browser-use returned empty content" }, { status: 500 });
    }

    const businessForPrompt: BusinessForPrompt = {
      ownerId: business.ownerId,
      placeId: business.placeId,
      mapsUrl: business.mapsUrl,
      name: business.name,
      address: business.address,
      phone: business.phone,
      website: business.website,
      primaryType: business.primaryType,
      primaryTypeDisplay: business.primaryTypeDisplay,
      types: business.types,
      hours: business.hours,
      timezone: business.timezone,
      rating: business.rating,
      reviewCount: business.reviewCount,
      priceLevel: business.priceLevel,
      summary: business.summary,
      topReviews: business.topReviews,
      rawPlaceDetails: business.rawPlaceDetails,
      websiteMarkdown: newMarkdown,
      mossIndexedAt: business.mossIndexedAt,
      mossChunkCount: business.mossChunkCount,
    };

    let regenerated;
    try {
      regenerated = await generateSystemPrompt(businessForPrompt, newMarkdown);
    } catch (err) {
      return Response.json(
        { error: `prompt regeneration failed: ${(err as Error).message}` },
        { status: 500 },
      );
    }

    await businesses.updateOne(
      { _id: business._id },
      {
        $set: {
          websiteMarkdown: newMarkdown,
          systemPrompt: regenerated.systemPrompt,
          serviceMenu: regenerated.serviceMenu,
          intakeQuestions: regenerated.intakeQuestions,
          updatedAt: new Date(),
        },
      },
    );

    let agentPatched = false;
    let agentError: string | null = null;
    try {
      await updateAgent(business.agentPhoneAgentId, { systemPrompt: regenerated.systemPrompt });
      agentPatched = true;
    } catch (err) {
      agentError = (err as Error).message;
    }

    let mossChunkCount: number | null = null;
    let mossError: string | null = null;
    if (isMossConfigured()) {
      try {
        mossChunkCount = await indexBusinessWebsite({
          _id: business._id,
          websiteMarkdown: newMarkdown,
          name: business.name,
        });
        await businesses.updateOne(
          { _id: business._id },
          { $set: { mossIndexedAt: new Date(), mossChunkCount } },
        );
      } catch (err) {
        mossError = (err as Error).message;
      }
    }

    return Response.json({
      enriched: true,
      markdownChars: newMarkdown.length,
      serviceCount: regenerated.serviceMenu.length,
      intakeCount: regenerated.intakeQuestions.length,
      mossChunkCount,
      agentPatched,
      warnings: { agentError, mossError },
    });
  }

  if (action === "index-business") {
    if (!isMossConfigured()) {
      return Response.json({ error: "MOSS_PROJECT_ID/MOSS_PROJECT_KEY not set" }, { status: 500 });
    }
    const businessId = url.searchParams.get("businessId");
    if (!businessId) return Response.json({ error: "missing businessId" }, { status: 400 });
    let objectId: ObjectId;
    try {
      objectId = new ObjectId(businessId);
    } catch {
      return Response.json({ error: "invalid businessId" }, { status: 400 });
    }

    const businesses = await getBusinesses();
    const business = await businesses.findOne({ _id: objectId });
    if (!business || business.ownerId !== userId) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    if (!business.websiteMarkdown) {
      return Response.json({ error: "business has no websiteMarkdown to index" }, { status: 400 });
    }

    try {
      const chunkCount = await indexBusinessWebsite(business);
      await businesses.updateOne(
        { _id: business._id },
        { $set: { mossIndexedAt: new Date(), mossChunkCount: chunkCount } },
      );
      return Response.json({ indexed: { chunkCount, businessId } });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  return Response.json({ error: `unknown POST action ${action}` }, { status: 400 });
}
