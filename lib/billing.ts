import type { ObjectId } from "mongodb";
import { getBusinesses } from "./mongo";

export async function accrueCallCost(businessId: ObjectId, durationSeconds: number): Promise<number> {
  const ratePerMin = Number.parseFloat(process.env.BILLING_RATE_USD_PER_MIN || "0.15");
  const minimum = Number.parseFloat(process.env.BILLING_MINIMUM_USD || "0.05");
  const cost = Math.max(minimum, (durationSeconds / 60) * ratePerMin);
  const businesses = await getBusinesses();
  await businesses.updateOne(
    { _id: businessId },
    {
      $inc: { pendingBillUsd: cost, totalCallsCount: 1 },
      $set: { updatedAt: new Date() },
    },
  );
  return cost;
}
