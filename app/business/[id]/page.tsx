import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses } from "@/lib/mongo";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/copy-button";
import { IndexBusinessButton } from "@/components/index-business-button";
import { EnrichBusinessButton } from "@/components/enrich-business-button";
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
  const browserUseEnabled = !!process.env.BROWSER_USE_API_KEY;

  return (
    <div className="flex flex-1 flex-col items-center px-6 py-12 sm:py-16">
      <div className="w-full max-w-6xl flex flex-col gap-5">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight font-heading">
            {business.name}
          </h1>
          <p className="text-muted-foreground">{business.address}</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          <div className="flex flex-col gap-5">
            <Card className="p-5 flex flex-col gap-3">
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

            <Card className="p-5 flex flex-col gap-3">
              <h2 className="font-semibold">Hours ({business.timezone})</h2>
              <pre className="text-xs text-muted-foreground whitespace-pre-wrap font-mono">
                {describeHoursForPrompt(business.hours)}
              </pre>
            </Card>

            {business.intakeQuestions && business.intakeQuestions.length > 0 && (
              <Card className="p-5 flex flex-col gap-3">
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

            <Card className="p-5 flex flex-col gap-3">
              <h2 className="font-semibold">Knowledge base</h2>
              {business.mossIndexedAt && business.mossChunkCount ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Indexed {business.mossChunkCount} chunks from the website. The receptionist
                    can search this during calls.
                  </p>
                  <IndexBusinessButton businessId={businessIdStr} alreadyIndexed />
                </>
              ) : business.websiteMarkdown ? (
                <>
                  <p className="text-xs text-muted-foreground">
                    Website scraped but not indexed yet.
                  </p>
                  <IndexBusinessButton businessId={businessIdStr} alreadyIndexed={false} />
                </>
              ) : (
                <p className="text-xs text-muted-foreground">
                  No website content available to index.
                </p>
              )}
              {browserUseEnabled && business.website && (
                <>
                  <div className="h-px bg-border my-1" />
                  <p className="text-xs text-muted-foreground">
                    Deeper multi-page research via browser-use. Regenerates the receptionist&apos;s
                    prompt, services, and intake questions, and re-indexes the knowledge base.
                    Takes ~1-2 minutes and overwrites the curated content.
                  </p>
                  <EnrichBusinessButton businessId={businessIdStr} />
                </>
              )}
            </Card>
          </div>

          <RecentCalls businessId={businessIdStr} />
          <RecentAppointments businessId={businessIdStr} />
        </div>

        {business.serviceMenu.length > 0 && (
          <Card className="p-5 flex flex-col gap-3">
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
