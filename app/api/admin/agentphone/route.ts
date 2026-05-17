// Dev-only admin: inspect AgentPhone agents and voices.
// GET /api/admin/agentphone?action=voices
// GET /api/admin/agentphone?action=agent&id=<agentId>
// GET /api/admin/agentphone?action=business&businessId=<mongoId>   (resolves agentId from Mongo)

import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses } from "@/lib/mongo";

export const runtime = "nodejs";

const API_KEY = process.env.AGENTPHONE_API_KEY;
const BASE_URL = process.env.AGENTPHONE_BASE_URL || "https://api.agentphone.to/v1";

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
