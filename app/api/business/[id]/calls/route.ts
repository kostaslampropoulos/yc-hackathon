import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses, getConversations } from "@/lib/mongo";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/calls">) {
  const { userId } = await auth();
  if (!userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await ctx.params;
  let businessId: ObjectId;
  try {
    businessId = new ObjectId(id);
  } catch {
    return Response.json({ error: "Invalid business id" }, { status: 400 });
  }

  const businesses = await getBusinesses();
  const business = await businesses.findOne({ _id: businessId });
  if (!business || business.ownerId !== userId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const conversations = await getConversations();
  const calls = await conversations
    .find({ businessId })
    .sort({ startedAt: -1 })
    .limit(10)
    .project({
      callId: 1,
      callerPhone: 1,
      status: 1,
      startedAt: 1,
      endedAt: 1,
      summary: 1,
      durationSeconds: 1,
      bookingMade: 1,
      transcript: 1,
    })
    .toArray();

  return Response.json({
    calls: calls.map((c) => ({
      id: c._id.toString(),
      callId: c.callId,
      callerPhone: c.callerPhone,
      status: c.status,
      startedAt: c.startedAt,
      endedAt: c.endedAt ?? null,
      summary: c.summary ?? null,
      durationSeconds: c.durationSeconds ?? null,
      bookingMade: c.bookingMade ?? false,
      lastUtterance: lastUtterance(c.transcript),
    })),
  });
}

function lastUtterance(
  transcript: Array<{ role: string; text: string }> | undefined,
): { role: string; text: string } | null {
  if (!transcript || transcript.length === 0) return null;
  const last = transcript[transcript.length - 1];
  return { role: last.role, text: last.text };
}
