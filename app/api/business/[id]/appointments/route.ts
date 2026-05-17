import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses, getAppointments } from "@/lib/mongo";

export const runtime = "nodejs";

export async function GET(_req: Request, ctx: RouteContext<"/api/business/[id]/appointments">) {
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

  const appointments = await getAppointments();
  const upcoming = await appointments
    .find({ businessId, status: "booked" })
    .sort({ startTime: 1 })
    .limit(20)
    .toArray();

  return Response.json({
    timezone: business.timezone,
    appointments: upcoming.map((a) => ({
      id: a._id.toString(),
      callerName: a.callerName,
      callerPhone: a.callerPhone,
      service: a.service,
      startTime: a.startTime,
      durationMinutes: a.durationMinutes,
      status: a.status,
      intakeAnswers: a.intakeAnswers ?? null,
    })),
  });
}
