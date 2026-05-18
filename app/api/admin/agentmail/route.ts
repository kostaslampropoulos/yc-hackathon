// Dev/ops endpoint: one-shot AgentMail webhook registration.
//
// POST /api/admin/agentmail?action=register-webhook
//   Calls AgentMail's POST /v0/webhooks for `message.received` events with the
//   app's public webhook URL, stores the returned signing secret in Mongo's
//   `app_config` collection under the key `agentmail_webhook_secret`, and
//   returns the secret in the JSON response so it can also be pasted into
//   Vercel env vars if desired.
//
// GET /api/admin/agentmail?action=status
//   Reports whether the webhook secret is set and the configured public URL.

import { auth } from "@clerk/nextjs/server";
import { registerWebhook } from "@/lib/agentmail";
import { getAppConfigValue, setAppConfigValue } from "@/lib/mongo";

export const runtime = "nodejs";

const WEBHOOK_SECRET_KEY = "agentmail_webhook_secret";
const WEBHOOK_ID_KEY = "agentmail_webhook_id";

function webhookUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${appUrl}/api/agentmail/webhook`;
}

export async function GET(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "status") {
    const secret = await getAppConfigValue(WEBHOOK_SECRET_KEY);
    const id = await getAppConfigValue(WEBHOOK_ID_KEY);
    return Response.json({
      webhookUrl: webhookUrl(),
      configured: !!secret,
      webhookId: id ?? null,
    });
  }

  return Response.json({ error: "Unknown action. Use ?action=status." }, { status: 400 });
}

export async function POST(req: Request) {
  const { userId } = await auth();
  if (!userId) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  if (action === "register-webhook") {
    if (!process.env.AGENTMAIL_API_KEY) {
      return Response.json({ error: "AGENTMAIL_API_KEY is not set" }, { status: 500 });
    }
    try {
      const wh = await registerWebhook({
        url: webhookUrl(),
        eventTypes: ["message.received"],
      });
      await setAppConfigValue(WEBHOOK_SECRET_KEY, wh.signingSecret);
      await setAppConfigValue(WEBHOOK_ID_KEY, wh.webhookId);
      return Response.json({
        ok: true,
        webhookId: wh.webhookId,
        webhookUrl: webhookUrl(),
        note: "Secret stored in app_config. Optionally set AGENTMAIL_WEBHOOK_SECRET env to override.",
      });
    } catch (err) {
      return Response.json(
        { error: `register-webhook failed: ${(err as Error).message}` },
        { status: 500 },
      );
    }
  }

  return Response.json({ error: "Unknown action. Use ?action=register-webhook." }, { status: 400 });
}
