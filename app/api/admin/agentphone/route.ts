// Dev-only admin: inspect AgentPhone agents and voices.
// GET /api/admin/agentphone?action=voices
// GET /api/admin/agentphone?action=agent&id=<agentId>

import { auth } from "@clerk/nextjs/server";

export const runtime = "nodejs";

const API_KEY = process.env.AGENTPHONE_API_KEY;
const BASE_URL = process.env.AGENTPHONE_BASE_URL || "https://api.agentphone.to/v1";

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  if (!API_KEY) return Response.json({ error: "AGENTPHONE_API_KEY not set" }, { status: 500 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action") ?? "voices";
  const agentId = url.searchParams.get("id");

  let path: string;
  if (action === "voices") {
    path = "/agents/voices";
  } else if (action === "agent") {
    if (!agentId) return Response.json({ error: "missing id" }, { status: 400 });
    path = `/agents/${agentId}`;
  } else {
    return Response.json({ error: `unknown action ${action}` }, { status: 400 });
  }

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
  return Response.json({ status: res.status, path, body });
}
