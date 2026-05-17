import { ObjectId } from "mongodb";
import { verifyHmac } from "@/lib/webhook-auth";
import { getBusinesses, getCallers, getConversations, getDb } from "@/lib/mongo";
import { buildCallerContext } from "@/lib/caller-context";
import { runAgentLoop } from "@/lib/agent-loop";
import type { Business, Caller, Conversation, TranscriptEntry } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

type VoiceTurnData = {
  callId: string;
  agentId?: string;
  from: string;
  to: string;
  transcript: string;
  numberId?: string;
  confidence?: number;
  direction?: string;
  status?: string;
};

type CallEndedData = {
  callId: string;
  transcript?: string;
  summary?: string;
  userSentiment?: string;
  durationSeconds?: number;
  status?: string;
};

type WebhookPayload = {
  event: string;
  channel?: string;
  agentId?: string;
  data: VoiceTurnData | CallEndedData | Record<string, unknown>;
};

export async function POST(req: Request) {
  const startedAt = Date.now();
  const rawBody = await req.text();
  const signature = req.headers.get("x-webhook-signature") ?? "";
  const timestamp = req.headers.get("x-webhook-timestamp") ?? "";
  const secret = process.env.AGENTPHONE_WEBHOOK_SECRET;

  if (!secret) {
    console.error("[webhook] AGENTPHONE_WEBHOOK_SECRET is not set");
    return new Response("Server misconfigured", { status: 500 });
  }

  if (!verifyHmac(rawBody, signature, timestamp, secret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  try {
    if (payload.event === "agent.message" && payload.channel === "voice") {
      const reply = await handleVoiceTurn(payload.data as VoiceTurnData);
      const latencyMs = Date.now() - startedAt;
      console.log(`[webhook] voice turn ${(payload.data as VoiceTurnData).callId} in ${latencyMs}ms`);
      return Response.json(reply);
    }

    if (payload.event === "agent.call_ended") {
      await handleCallEnded(payload.data as CallEndedData);
      return Response.json({ ok: true });
    }
  } catch (err) {
    console.error("[webhook] error:", err);
    // Always return safe text so the call doesn't die.
    return Response.json({ text: "Sorry, just a moment." });
  }

  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({ ok: true, phase: 2 });
}

async function handleVoiceTurn(
  data: VoiceTurnData,
): Promise<{ text: string; action?: "transfer" | "hangup" }> {
  const { callId, from, to, transcript } = data;
  if (!callId || !from || !to) {
    return { text: "I'm having trouble taking the call. Please try again in a moment." };
  }

  const businessesCol = await getBusinesses();
  const business = (await businessesCol.findOne({ agentPhoneNumber: to })) as Business | null;
  if (!business) {
    console.warn(`[webhook] no business for agent number ${to}`);
    return { text: "This line isn't quite set up yet. Please try again later." };
  }

  // Upsert caller atomically.
  const callersCol = await getCallers();
  const now = new Date();
  const callerUpsert = await callersCol.findOneAndUpdate(
    { businessId: business._id, phone: from },
    {
      $setOnInsert: {
        businessId: business._id,
        phone: from,
        appointmentCount: 0,
        callCount: 0,
        createdAt: now,
      },
      $set: { updatedAt: now },
    },
    { upsert: true, returnDocument: "after" },
  );
  const caller = callerUpsert as Caller | null;
  if (!caller) {
    return { text: "Sorry, one moment." };
  }

  // Find or create conversation.
  const conversationsCol = await getConversations();
  let conversation = (await conversationsCol.findOne({ callId })) as Conversation | null;
  if (!conversation) {
    const doc: Conversation = {
      _id: new ObjectId(),
      callId,
      businessId: business._id,
      callerId: caller._id,
      callerPhone: from,
      toNumber: to,
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

  // Append the user's utterance.
  const userText = (transcript ?? "").trim();
  if (userText) {
    conversation.messages.push({ role: "user", content: userText });
    conversation.transcript.push({ role: "user", text: userText, ts: now });
  }

  // Build caller context fresh each turn.
  const callerContext = await buildCallerContext(business, caller, await getDb());

  // Run the agent loop.
  const db = await getDb();
  const result = await runAgentLoop(business, caller, conversation, callerContext, db);

  // Append assistant reply to display transcript (messages already pushed in agent loop).
  const assistantTs = new Date();
  const display: TranscriptEntry = { role: "assistant", text: result.text, ts: assistantTs };
  conversation.transcript.push(display);

  // Save full conversation state.
  const setOnSave: Partial<Conversation> = {
    messages: conversation.messages,
    transcript: conversation.transcript,
    updatedAt: assistantTs,
  };
  if (result.bookingMade) setOnSave.bookingMade = true;
  await conversationsCol.updateOne({ _id: conversation._id }, { $set: setOnSave });

  if (result.transfer) {
    return { text: result.text || "Connecting you now.", action: "transfer" };
  }
  return { text: result.text };
}

async function handleCallEnded(data: CallEndedData): Promise<void> {
  const { callId, summary, userSentiment, durationSeconds, status } = data;
  if (!callId) return;

  const conversationsCol = await getConversations();
  const conversation = await conversationsCol.findOne({ callId });
  if (!conversation) {
    console.warn(`[webhook] call_ended for unknown callId ${callId}`);
    return;
  }

  const endedAt = new Date();
  const update: Partial<Conversation> = {
    status: "ended",
    endedAt,
    updatedAt: endedAt,
  };
  if (summary) update.summary = summary;
  if (userSentiment) update.userSentiment = userSentiment;
  if (typeof durationSeconds === "number") update.durationSeconds = durationSeconds;

  // Recompute bookingMade by checking for an actual appointment doc.
  const db = await getDb();
  const apptCount = await db
    .collection("appointments")
    .countDocuments({ conversationId: conversation._id });
  if (apptCount > 0) {
    update.bookingMade = true;
  }

  await conversationsCol.updateOne({ _id: conversation._id }, { $set: update });

  // Bump caller's callCount and lastCalledAt.
  const callersCol = await getCallers();
  await callersCol.updateOne(
    { _id: conversation.callerId },
    { $inc: { callCount: 1 }, $set: { lastCalledAt: endedAt, updatedAt: endedAt } },
  );

  console.log(`[webhook] call_ended ${callId} status=${status ?? "unknown"} bookingMade=${update.bookingMade ?? false}`);
}
