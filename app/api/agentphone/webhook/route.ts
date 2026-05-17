// Phase 1: stub webhook so test calls don't 404.
// Phase 2 will implement HMAC verification and call routing.

export async function POST(req: Request) {
  const payload = await req.json().catch(() => ({} as Record<string, unknown>));

  if (
    typeof payload === "object" &&
    payload !== null &&
    (payload as Record<string, unknown>).event === "agent.message" &&
    (payload as Record<string, unknown>).channel === "voice"
  ) {
    return Response.json({
      text: "Hi, this agent is being set up. Please call back in a few minutes.",
    });
  }

  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({ ok: true, phase: 1 });
}
