import { ObjectId } from "mongodb";
import { getBusinesses } from "./mongo";
import { enrichBusinessFromWebsite } from "./browseruse";

export async function runEnrichmentJob(businessId: ObjectId): Promise<void> {
  const businesses = await getBusinesses();
  const business = await businesses.findOne({ _id: businessId });
  if (!business) {
    console.warn(`[enrichment] business ${businessId} not found`);
    return;
  }
  if (!business.website) {
    await businesses.updateOne(
      { _id: businessId },
      {
        $set: {
          enrichment: {
            status: "failed",
            error: "No website to enrich",
            startedAt: new Date(),
            finishedAt: new Date(),
          },
        },
      },
    );
    return;
  }

  await businesses.updateOne(
    { _id: businessId },
    { $set: { "enrichment.status": "running", "enrichment.startedAt": new Date() } },
  );

  try {
    const result = await enrichBusinessFromWebsite({
      websiteUrl: business.website,
      businessName: business.name,
      businessType: business.primaryTypeDisplay,
    });
    await businesses.updateOne(
      { _id: businessId },
      {
        $set: {
          enrichment: {
            status: "succeeded",
            services: result.services,
            bookingUrl: result.bookingUrl,
            bookingProvider: result.bookingProvider,
            notes: result.notes,
            startedAt: business.enrichment?.startedAt ?? new Date(),
            finishedAt: new Date(),
          },
          updatedAt: new Date(),
        },
      },
    );
  } catch (err) {
    console.error(`[enrichment] failed for ${businessId}:`, err);
    await businesses.updateOne(
      { _id: businessId },
      {
        $set: {
          "enrichment.status": "failed",
          "enrichment.error": (err as Error).message,
          "enrichment.finishedAt": new Date(),
        },
      },
    );
  }
}
