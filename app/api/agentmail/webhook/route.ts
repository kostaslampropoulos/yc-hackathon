import { ObjectId } from "mongodb";
import { createHmac, timingSafeEqual } from "crypto";
import { getBusinesses, getCallers, getConversations, getDb, getAppConfigValue } from "@/lib/mongo";
import { buildCallerContext } from "@/lib/caller-context";
import { runAgentLoop } from "@/lib/agent-loop";
import { StepTimer } from "@/lib/timing";
import { parseFromHeader, replyToMessage } from "@/lib/agentmail";
import type { Business, Caller, Conversation } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const WEBHOOK_SECRET_KEY = "agentmail_webhook_secret";

type InboundMessage = {
  inbox_id: string;
  message_id: string;
  thread_id: string;
  from: string;
  to?: string[];
  subject?: string;
  text?: string;
  html?: string;
  extracted_text?: string;
  extracted_html?: string;
  in_reply_to?: string | null;
  references?: string[];
  [k: string]: unknown;
};

type WebhookEnvelope = {
  type?: string;
  event_type?: string;
  message?: InboundMessage;
  [k: string]: unknown;
};

function verifySvix(rawBody: string, svixId: string, svixTimestamp: string, signatureHeader: string, secret: string): boolean {
  if (!svixId || !svixTimestamp || !signatureHeader || !secret) return false;
  const signedContent = `${svixId}.${svixTimestamp}.${rawBody}`;
  const rawSecret = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(rawSecret, "base64");
  } catch {
    return false;
  }
  const expected = createHmac("sha256", key).update(signedContent).digest("base64");
  // Header may contain multiple space-separated `v1,<sig>` entries.
  const candidates = signatureHeader.split(" ");
  for (const c of candidates) {
    const idx = c.indexOf(",");
    if (idx < 0) continue;
    const sig = c.slice(idx + 1);
    try {
      if (sig.length === expected.length && timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
        return true;
      }
    } catch {
      // ignore length mismatches
    }
  }
  return false;
}

export async function POST(req: Request) {
  const timer = new StepTimer();
  const rawBody = await req.text();
  timer.step("readBody");

  const svixId = req.headers.get("svix-id") ?? "";
  const svixTimestamp = req.headers.get("svix-timestamp") ?? "";
  const svixSignature = req.headers.get("svix-signature") ?? "";
  const skipVerify = process.env.WEBHOOK_SKIP_VERIFY === "true";

  console.log(
    `[agentmail] incoming bodyLen=${rawBody.length} svixId=${svixId || "MISSING"} ts=${svixTimestamp || "MISSING"} sig=${svixSignature ? svixSignature.slice(0, 20) + "…" : "MISSING"} skipVerify=${skipVerify}`,
  );

  if (!skipVerify) {
    const secret = process.env.AGENTMAIL_WEBHOOK_SECRET || (await getAppConfigValue(WEBHOOK_SECRET_KEY));
    if (!secret) {
      console.error("[agentmail] webhook secret not configured. POST /api/admin/agentmail?action=register-webhook to set it.");
      return new Response("Server misconfigured", { status: 500 });
    }
    const ok = verifySvix(rawBody, svixId, svixTimestamp, svixSignature, secret);
    if (!ok) {
      console.warn(`[agentmail] svix verification failed. bodyPreview=${rawBody.slice(0, 200)}`);
      return new Response("Invalid signature", { status: 401 });
    }
  } else {
    console.warn("[agentmail] WEBHOOK_SKIP_VERIFY=true — Svix NOT enforced. Dev only.");
  }
  timer.step("svix.verify");

  let envelope: WebhookEnvelope;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  if (envelope.event_type !== "message.received") {
    console.log(`[agentmail] ignoring event_type=${envelope.event_type ?? "?"}`);
    return Response.json({ ok: true, ignored: true });
  }

  const msg = envelope.message;
  if (!msg || !msg.inbox_id || !msg.message_id || !msg.thread_id || !msg.from) {
    console.warn("[agentmail] malformed message payload");
    return new Response("Bad request", { status: 400 });
  }

  try {
    await handleIncoming(msg, timer);
  } catch (err) {
    console.error("[agentmail] handler error:", err, timer.format());
    return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
  }

  console.log(timer.format(`[agentmail] msg ${msg.message_id}`));
  return Response.json({ ok: true });
}

async function handleIncoming(msg: InboundMessage, timer: StepTimer): Promise<void> {
  const userText = (msg.extracted_text ?? msg.text ?? "").trim();
  if (!userText) {
    console.log(`[agentmail] empty body for msg=${msg.message_id}, skipping`);
    return;
  }

  // 1. Resolve business from inbox id.
  const businessesCol = await getBusinesses();
  const business = (await businessesCol.findOne({ agentMailInboxId: msg.inbox_id })) as Business | null;
  timer.step("db.findBusiness");
  if (!business) {
    console.warn(`[agentmail] no business for inbox ${msg.inbox_id}`);
    return;
  }

  // 2. Parse sender + find-or-create caller by email.
  const parsed = parseFromHeader(msg.from);
  if (!parsed.email) {
    console.warn(`[agentmail] could not parse from header: ${msg.from}`);
    return;
  }
  const callersCol = await getCallers();
  const now = new Date();
  const callerUpsert = await callersCol.findOneAndUpdate(
    { businessId: business._id, email: parsed.email },
    {
      $setOnInsert: {
        businessId: business._id,
        email: parsed.email,
        ...(parsed.name ? { name: parsed.name } : {}),
        appointmentCount: 0,
        callCount: 0,
        createdAt: now,
      },
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: "after" },
  );
  const caller = callerUpsert as Caller | null;
  timer.step("db.upsertCaller");
  if (!caller) {
    console.error(`[agentmail] upsert returned no caller for ${parsed.email}`);
    return;
  }

  // 3. Resolve or create conversation by thread id. We persist the thread id
  //    in `callId` so the existing unique index on conversations.callId works
  //    for both voice and email channels.
  const conversationsCol = await getConversations();
  let conversation = (await conversationsCol.findOne({ callId: msg.thread_id })) as Conversation | null;
  if (!conversation) {
    const doc: Conversation = {
      _id: new ObjectId(),
      callId: msg.thread_id,
      channel: "email",
      threadId: msg.thread_id,
      businessId: business._id,
      callerId: caller._id,
      callerPhone: caller.phone,
      toNumber: business.agentMailEmail ?? "",
      messages: [],
      transcript: [],
      status: "active",
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await conversationsCol.insertOne(doc);
    conversation = doc;
  }
  timer.step("db.findOrCreateConversation");

  // 4. Append inbound user email as a model message + transcript entry.
  conversation.messages.push({ role: "user", parts: [{ text: userText }] });
  conversation.transcript.push({ role: "user", text: userText, ts: now });

  const db = await getDb();
  const callerContext = await buildCallerContext(business, caller, db);
  timer.step("buildCallerContext");

  // 5. Run agent loop in email-channel mode (no streaming).
  const result = await runAgentLoop(business, caller, conversation, callerContext, db, {
    timer,
    channel: "email",
  });
  timer.step("agentLoop.total");

  const replyText = (result.text || "").trim() || "Thanks for your message. We'll get back to you shortly.";

  // 6. Send the reply via AgentMail.
  let replySent = false;
  try {
    await replyToMessage({
      inboxId: msg.inbox_id,
      messageId: msg.message_id,
      text: replyText,
      replyAll: false,
    });
    replySent = true;
  } catch (err) {
    console.error("[agentmail] replyToMessage failed:", err);
  }
  timer.step("agentmail.reply");

  // 7. Persist the transcript + messages.
  const assistantTs = new Date();
  conversation.transcript.push({ role: "assistant", text: replyText, ts: assistantTs });
  const setOnSave: Partial<Conversation> = {
    messages: conversation.messages,
    transcript: conversation.transcript,
    updatedAt: assistantTs,
  };
  if (result.bookingMade) setOnSave.bookingMade = true;
  await conversationsCol.updateOne({ _id: conversation._id }, { $set: setOnSave });
  timer.step("db.saveConversation");

  console.log(`[agentmail] msg=${msg.message_id} from=${parsed.email} reply=${replySent ? "ok" : "FAILED"} len=${replyText.length}`);
}

export async function GET() {
  return Response.json({ ok: true, channel: "email" });
}
