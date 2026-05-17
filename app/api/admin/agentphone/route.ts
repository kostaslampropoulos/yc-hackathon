// Dev-only admin: inspect and fix AgentPhone agents, and (re)index Moss knowledge bases.
// GET  /api/admin/agentphone?action=voices
// GET  /api/admin/agentphone?action=agent&id=<agentId>
// GET  /api/admin/agentphone?action=business&businessId=<mongoId>
// POST /api/admin/agentphone?action=fix-agent&businessId=<mongoId>
//      Patches the agent with a valid voice + beginMessage from the Mongo doc.
// POST /api/admin/agentphone?action=index-business&businessId=<mongoId>
//      Indexes (or re-indexes) the business's websiteMarkdown into Moss.

import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses } from "@/lib/mongo";
import { updateAgent } from "@/lib/agentphone";
import { indexBusinessWebsite, isMossConfigured } from "@/lib/moss";

export const runtime = "nodejs";

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
