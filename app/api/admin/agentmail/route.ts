// Dev/ops endpoint: AgentMail webhook registration + inbox backfill.
//
// POST /api/admin/agentmail?action=register-webhook
//   Calls AgentMail's POST /v0/webhooks for `message.received` events with the
//   app's public webhook URL, stores the returned signing secret in Mongo's
//   `app_config` collection under the key `agentmail_webhook_secret`.
//
// POST /api/admin/agentmail?action=backfill[&businessId=<mongoId>]
//   Issues an AgentMail inbox to any business owned by the caller that does
//   not have `agentMailInboxId` set yet. If `businessId` is provided, only
//   that one is processed.
//
// GET /api/admin/agentmail?action=status
//   Reports whether the webhook secret is set and the configured public URL.

import { auth } from "@clerk/nextjs/server";
import { ObjectId } from "mongodb";
import { createInbox, registerWebhook } from "@/lib/agentmail";
import { getAppConfigValue, getBusinesses, setAppConfigValue } from "@/lib/mongo";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

const WEBHOOK_SECRET_KEY = "agentmail_webhook_secret";
const WEBHOOK_ID_KEY = "agentmail_webhook_id";

function webhookUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return `${appUrl}/api/agentmail/webhook`;
}

function slugForInbox(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const suffix = Date.now().toString(36).slice(-5);
  return `${slug || "inbox"}-${suffix}`;
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

  if (action === "backfill") {
    if (!process.env.AGENTMAIL_API_KEY) {
      return Response.json({ error: "AGENTMAIL_API_KEY is not set" }, { status: 500 });
    }
    const businessesCol = await getBusinesses();
    const businessIdParam = url.searchParams.get("businessId");
    const query: Record<string, unknown> = {
      ownerId: userId,
      $or: [{ agentMailInboxId: { $exists: false } }, { agentMailInboxId: null }, { agentMailInboxId: "" }],
    };
    if (businessIdParam) {
      try {
        query._id = new ObjectId(businessIdParam);
      } catch {
        return Response.json({ error: "businessId is not a valid ObjectId" }, { status: 400 });
      }
    }
    const targets = (await businessesCol.find(query).limit(50).toArray()) as Business[];
    const results: Array<{ businessId: string; name: string; email?: string; error?: string }> = [];
    for (const b of targets) {
      try {
        const inbox = await createInbox({
          username: slugForInbox(b.name),
          displayName: b.name,
          clientId: b.placeId,
        });
        await businessesCol.updateOne(
          { _id: b._id },
          { $set: { agentMailInboxId: inbox.inboxId, agentMailEmail: inbox.email, updatedAt: new Date() } },
        );
        results.push({ businessId: b._id.toString(), name: b.name, email: inbox.email });
      } catch (err) {
        results.push({ businessId: b._id.toString(), name: b.name, error: (err as Error).message });
      }
    }
    return Response.json({ ok: true, processed: results.length, results });
  }

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
