import Link from "next/link";
import { auth } from "@clerk/nextjs/server";
import { getBusinesses } from "@/lib/mongo";
import { PasteUrlForm } from "@/components/paste-url-form";
import { Card } from "@/components/ui/card";

export default async function Home() {
  const { userId } = await auth();
  let businesses: Array<{ _id: { toString(): string }; name: string; address: string; agentPhoneNumber: string }> = [];
  if (userId) {
    try {
      businesses = (await (await getBusinesses())
        .find({ ownerId: userId }, { projection: { name: 1, address: 1, agentPhoneNumber: 1, createdAt: 1 } })
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray()) as typeof businesses;
    } catch (err) {
      console.warn("[home] could not load businesses:", (err as Error).message);
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center px-6 py-16 sm:py-24">
      <section className="w-full max-w-5xl flex flex-col items-center text-center gap-4 mb-10">
        <span className="font-mono text-sm text-primary italic">// URL to Phone</span>
        <h1
          className="text-4xl sm:text-5xl font-semibold tracking-tight"
          style={{ fontFamily: "var(--font-heading)" }}
        >
          A phone receptionist in 60 seconds.
        </h1>
        <p className="text-base text-muted-foreground max-w-xl">
          Paste a Google Maps URL. We&apos;ll read your business, design a custom AI receptionist,
          and provision a real US phone number.
        </p>
      </section>

      <PasteUrlForm />

      <section className="w-full max-w-2xl mt-16">
        <ol className="grid grid-cols-1 sm:grid-cols-3 gap-4 text-sm">
          <Step n={1} title="Paste your Maps URL" body="Any bizz with a public profile." />
          <Step n={2} title="We read everything" body="Hours, services, reviews, tone." />
          <Step n={3} title="Get a phone number" body="Live, ready to take calls." />
        </ol>
      </section>

      {businesses.length > 0 && (
        <section className="w-full max-w-2xl mt-46">
          <h2
            className="text-xl font-semibold mb-2"
            style={{ fontFamily: "var(--font-heading)" }}
          >
            Your businesses
          </h2>
          <div className="grid gap-3">
            {businesses.map((b) => (
              <Link key={b._id.toString()} href={`/business/${b._id.toString()}`}>
                <Card className="p-4 hover:bg-accent transition-no">
                  <div className="flex items-center justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{b.name}</div>
                      <div className="text-sm text-muted-foreground truncate">{b.address}</div>
                    </div>
                    <div className="font-mono text-sm shrink-0">{b.agentPhoneNumber}</div>
                  </div>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="flex flex-col gap-1 p-4 rounded-lg bg-muted">
      <span className="text-xs text-muted-foreground">Step {n}</span>
      <span className="font-medium">{title}</span>
      <span className="text-muted-foreground text-xs">{body}</span>
    </li>
  );
}
