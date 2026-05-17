import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses } from "@/lib/mongo";
import { createTopUpLink } from "@/lib/sponge";

export const runtime = "nodejs";

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => ({}))) as { amountUsd?: string | number };
  const amount = String(body.amountUsd ?? "20");

  const businesses = await getBusinesses();
  const business = await businesses.findOne({ _id: oid });
  if (!business || business.ownerId !== userId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (!business.spongeAgentId || !business.spongeAgentApiKey || !business.spongeBaseAddress) {
    return Response.json({ error: "Sponge wallet not provisioned for this business" }, { status: 400 });
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL || new URL(req.url).origin;
  try {
    const url = await createTopUpLink({
      agentApiKey: business.spongeAgentApiKey,
      agentId: business.spongeAgentId,
      walletAddress: business.spongeBaseAddress,
      fiatAmountUsd: amount,
      redirectUrl: `${appUrl}/business/${id}`,
    });
    return Response.json({ url });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
