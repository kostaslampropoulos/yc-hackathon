import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { after } from "next/server";
import { getBusinesses } from "@/lib/mongo";
import { runEnrichmentJob } from "@/lib/enrichment";

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

  return Response.json({ enrichment: business.enrichment ?? null });
}

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
  if (!business.website) {
    return Response.json({ error: "No website to enrich" }, { status: 400 });
  }

  await businesses.updateOne(
    { _id: oid },
    { $set: { enrichment: { status: "pending", startedAt: new Date() } } },
  );
  after(() => runEnrichmentJob(oid));
  return Response.json({ ok: true });
}
