import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses } from "@/lib/mongo";
import { transferFromBusinessToPlatform } from "@/lib/sponge";

export const runtime = "nodejs";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await ctx.params;

  let oid: ObjectId;
  try {
    oid = new ObjectId(id);
  } catch {
    return Response.json({ error: "Invalid id" }, { status: 400 });
  }

  const businesses = await getBusinesses();
  const business = await businesses.findOne({ _id: oid });
  if (!business || business.ownerId !== userId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (!business.spongeAgentId || !business.spongeAgentApiKey) {
    return Response.json({ error: "Sponge wallet not provisioned" }, { status: 400 });
  }
  const platformAddress = process.env.SPONGE_PLATFORM_RECEIVE_ADDRESS;
  if (!platformAddress) {
    return Response.json({ error: "SPONGE_PLATFORM_RECEIVE_ADDRESS not set on server" }, { status: 500 });
  }
  const amount = Number(business.pendingBillUsd ?? 0);
  if (amount < 0.01) {
    return Response.json({ error: "Nothing to settle" }, { status: 400 });
  }

  try {
    const tx = await transferFromBusinessToPlatform({
      agentApiKey: business.spongeAgentApiKey,
      agentId: business.spongeAgentId,
      amountUsdc: amount.toFixed(2),
      toAddress: platformAddress,
      chain: "base",
    });
    await businesses.updateOne(
      { _id: oid },
      { $set: { pendingBillUsd: 0, updatedAt: new Date() } },
    );
    return Response.json({ ok: true, txHash: tx.txHash, explorerUrl: tx.explorerUrl, settled: amount });
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
}
