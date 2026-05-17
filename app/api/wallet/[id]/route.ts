import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses } from "@/lib/mongo";
import { getBusinessWalletBalance } from "@/lib/sponge";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
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
    return Response.json({
      configured: false,
      pendingBillUsd: business.pendingBillUsd ?? 0,
      totalCallsCount: business.totalCallsCount ?? 0,
    });
  }

  let balance: { baseUsdc: number; solanaUsdc: number; totalUsdc: number } | null = null;
  let balanceError: string | null = null;
  try {
    balance = await getBusinessWalletBalance({
      agentApiKey: business.spongeAgentApiKey,
      agentId: business.spongeAgentId,
    });
  } catch (err) {
    balanceError = (err as Error).message;
  }

  return Response.json({
    configured: true,
    baseAddress: business.spongeBaseAddress ?? null,
    solanaAddress: business.spongeSolanaAddress ?? null,
    balance,
    balanceError,
    pendingBillUsd: business.pendingBillUsd ?? 0,
    totalCallsCount: business.totalCallsCount ?? 0,
  });
}
