import { notFound } from "next/navigation";
import { ObjectId } from "mongodb";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses } from "@/lib/mongo";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
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

  return (
    <div className="flex flex-1 flex-col items-center px-6 py-12 sm:py-16">
      <div className="w-full max-w-3xl flex flex-col gap-6">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight font-heading">
            {business.name}
          </h1>
          <p className="text-muted-foreground">{business.address}</p>
        </header>

        <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
          <div className="text-sm text-muted-foreground">Your receptionist&apos;s phone number</div>
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div
              className="text-3xl sm:text-4xl font-mono tracking-tight"
            >
              {business.agentPhoneNumber}
            </div>
            <CopyButton value={business.agentPhoneNumber} label="Copy number" />
          </div>
          <p className="text-sm text-muted-foreground">
            Your AI receptionist is ready. Try calling the number above.
          </p>
        </Card>

        <Card className="p-6 flex flex-col gap-4 border-0 bg-muted">
          <div className="flex items-center justify-between">
            <h2 className="font-semibold">Try a web call</h2>
            <Button variant="outline" disabled>
              Coming in Phase 2
            </Button>
          </div>
          <p className="text-sm text-muted-foreground">
            Once Phase 2 ships, you&apos;ll be able to test the receptionist directly from this page.
          </p>
        </Card>

        <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
          <h2 className="font-semibold">Hours ({business.timezone})</h2>
          <pre className="text-sm text-muted-foreground whitespace-pre-wrap font-mono">
            {describeHoursForPrompt(business.hours)}
          </pre>
        </Card>

        {business.serviceMenu.length > 0 && (
          <Card className="p-6 flex flex-col gap-3 border-0 bg-muted">
            <h2 className="font-semibold">Services we listed for you</h2>
            <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-sm">
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
