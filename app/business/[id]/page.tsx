import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses } from "@/lib/mongo";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/copy-button";
import { RecentCalls } from "@/components/recent-calls";
import { RecentAppointments } from "@/components/recent-appointments";
import { describeHoursForPrompt } from "@/lib/hours";

export default async function BusinessPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { userId } = await auth();
  if (!userId) notFound();

  let objectId: ObjectId;
  try {
    objectId = new ObjectId(id);
  } catch {
    notFound();
  }

  const businesses = await getBusinesses();
  const business = await businesses.findOne({ _id: objectId });
  if (!business || business.ownerId !== userId) {
    notFound();
  }

  const businessIdStr = business._id.toString();

  return (
    <div className="flex flex-1 flex-col items-center px-6 py-12 sm:py-16">
      <div className="w-full max-w-6xl flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight font-heading">
            {business.name}
          </h1>
          <p className="text-muted-foreground">{business.address}</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="flex flex-col gap-6">
            <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
              <div className="text-sm text-muted-foreground">Your receptionist&apos;s phone number</div>
              <div className="flex items-center justify-between flex-wrap gap-3">
                <div className="text-2xl sm:text-3xl font-mono tracking-tight">
                  {business.agentPhoneNumber}
                </div>
                <CopyButton value={business.agentPhoneNumber} label="Copy" />
              </div>
              <p className="text-sm text-muted-foreground">
                Try calling the number. Your AI receptionist is live.
              </p>
            </Card>

            <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
              <h2 className="font-semibold">Hours ({business.timezone})</h2>
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono">
                {describeHoursForPrompt(business.hours)}
              </pre>
            </Card>

            {business.intakeQuestions && business.intakeQuestions.length > 0 && (
              <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
                <h2 className="font-semibold">Booking intake</h2>
                <p className="text-xs text-muted-foreground">
                  The receptionist asks these before booking an appointment.
                </p>
                <ol className="flex flex-col gap-1.5 text-sm">
                  {business.intakeQuestions.map((q, i) => (
                    <li key={q} className="text-muted-foreground">
                      <span className="text-foreground font-medium mr-1">{i + 1}.</span>
                      {q}
                    </li>
                  ))}
                </ol>
              </Card>
            )}
          </div>

          <RecentCalls businessId={businessIdStr} />
          <RecentAppointments businessId={businessIdStr} />
        </div>

        {business.serviceMenu.length > 0 && (
          <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
            <h2 className="font-semibold">Services we listed for you</h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-1 text-sm">
              {business.serviceMenu.map((s) => (
                <li key={s} className="text-muted-foreground">
                  • {s}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}
