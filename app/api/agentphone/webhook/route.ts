import { ObjectId } from "mongodb";
import { verifyHmac } from "@/lib/webhook-auth";
import { getBusinesses, getCallers, getConversations, getDb } from "@/lib/mongo";
import { buildCallerContext } from "@/lib/caller-context";
import { runAgentLoop } from "@/lib/agent-loop";
import { StepTimer } from "@/lib/timing";
import type { Business, Caller, Conversation } from "@/lib/types";

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
  const timer = new StepTimer();
  const rawBody = await req.text();
  timer.step("readBody");

  const signature = req.headers.get("x-webhook-signature") ?? "";
  const timestamp = req.headers.get("x-webhook-timestamp") ?? "";
  const secret = process.env.AGENTPHONE_WEBHOOK_SECRET;
  const skipVerify = process.env.WEBHOOK_SKIP_VERIFY === "true";

  // Diagnostic: every incoming request, before HMAC check.
  console.log(
    `[webhook] incoming method=POST bodyLen=${rawBody.length}` +
      ` sig=${signature ? signature.slice(0, 16) + "…" : "MISSING"}` +
      ` ts=${timestamp || "MISSING"}` +
      ` skipVerify=${skipVerify}`,
  );

  if (!secret && !skipVerify) {
    console.error("[webhook] AGENTPHONE_WEBHOOK_SECRET is not set");
    return new Response("Server misconfigured", { status: 500 });
  }

  if (!skipVerify) {
    const ok = verifyHmac(rawBody, signature, timestamp, secret!);
    if (!ok) {
      // Peek at the event type even though HMAC failed, for diagnostics.
      let evt = "unknown";
      try {
        evt = (JSON.parse(rawBody) as { event?: string }).event ?? "unknown";
      } catch {
        // ignore
      }
      console.warn(
        `[webhook] HMAC FAILED for event=${evt}. Set WEBHOOK_SKIP_VERIFY=true to bypass. bodyPreview=${rawBody.slice(0, 200)}`,
      );
      return new Response("Invalid signature", { status: 401 });
    }
  } else {
    console.warn("[webhook] WEBHOOK_SKIP_VERIFY=true — HMAC NOT enforced. Dev only.");
  }
  timer.step("hmac");

  let payload: WebhookPayload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  console.log(`[webhook] event=${payload.event} channel=${payload.channel ?? "-"}`);

  try {
    if (payload.event === "agent.message" && payload.channel === "voice") {
      const data = payload.data as VoiceTurnData;
      return streamVoiceTurn(data, timer);
    }

    if (payload.event === "agent.call_ended") {
      const data = payload.data as CallEndedData;
      await handleCallEnded(data, timer);
      console.log(timer.format(`[webhook] call_ended ${data.callId}`));
      return Response.json({ ok: true });
    }

    console.log(`[webhook] unhandled event=${payload.event} channel=${payload.channel ?? "-"} — returning 200 ok`);
  } catch (err) {
    console.error("[webhook] error:", err, timer.format());
    // Always return safe text so the call doesn't die.
    return Response.json({ text: "Sorry, just a moment." });
  }

  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({ ok: true, phase: 2 });
}

function streamVoiceTurn(data: VoiceTurnData, timer: StepTimer): Response {
  const encoder = new TextEncoder();
  const requestStartedAt = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const emit = (obj: Record<string, unknown>) => {
        if (closed) return;
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // already closed
        }
      };

      try {
        const { callId, from, to, transcript } = data;
        if (!callId || !from || !to) {
          emit({ text: "I'm having trouble taking the call. Please try again in a moment." });
          close();
          return;
        }

        const businessesCol = await getBusinesses();
        const business = (await businessesCol.findOne({ agentPhoneNumber: to })) as Business | null;
        timer.step("db.findBusiness");
        if (!business) {
          console.warn(`[webhook] no business for agent number ${to}`);
          emit({ text: "This line isn't quite set up yet. Please try again later." });
          close();
          return;
        }

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
        timer.step("db.upsertCaller");
        const caller = callerUpsert as Caller | null;
        if (!caller) {
          emit({ text: "Sorry, one moment." });
          close();
          return;
        }

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
        timer.step("db.findOrCreateConversation");

        const userText = (transcript ?? "").trim();
        if (userText) {
          conversation.messages.push({ role: "user", parts: [{ text: userText }] });
          conversation.transcript.push({ role: "user", text: userText, ts: now });
        }

        const db = await getDb();
        const callerContext = await buildCallerContext(business, caller, db);
        timer.step("buildCallerContext");

        // Stream Gemini chunks as NDJSON. Hold the most recent chunk in a buffer so it can be
        // emitted as the final (non-interim) chunk per AgentPhone's NDJSON protocol.
        let buffered: string | null = null;
        let firstChunkAt: number | null = null;
        const result = await runAgentLoop(business, caller, conversation, callerContext, db, {
          timer,
          onTextChunk: (chunk) => {
            if (firstChunkAt === null) firstChunkAt = Date.now();
            if (buffered !== null) {
              emit({ text: buffered, interim: true });
            }
            buffered = chunk;
          },
        });
        timer.step("agentLoop.total");

        // Final chunk: buffered text (or fallback if nothing was streamed).
        const finalText = buffered ?? result.text;
        const finalChunk: Record<string, unknown> = { text: finalText };
        if (result.transfer) finalChunk.action = "transfer";
        emit(finalChunk);

        // Persist transcript + messages.
        const assistantTs = new Date();
        conversation.transcript.push({ role: "assistant", text: result.text, ts: assistantTs });
        const setOnSave: Partial<Conversation> = {
          messages: conversation.messages,
          transcript: conversation.transcript,
          updatedAt: assistantTs,
        };
        if (result.bookingMade) setOnSave.bookingMade = true;
        await conversationsCol.updateOne({ _id: conversation._id }, { $set: setOnSave });
        timer.step("db.saveConversation");

        const ttft = firstChunkAt !== null ? `${firstChunkAt - requestStartedAt}ms` : "n/a";
        console.log(`[webhook] voice ${callId} ttft=${ttft} replyLen=${result.text.length}`);
        console.log(timer.format(`[webhook] voice ${callId}`));

        close();
      } catch (err) {
        console.error("[webhook] streamVoiceTurn error:", err, timer.format());
        emit({ text: "Sorry, just a moment." });
        close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}

async function handleCallEnded(data: CallEndedData, timer: StepTimer): Promise<void> {
  const { callId, summary, userSentiment, durationSeconds, status } = data;
  if (!callId) return;

  const conversationsCol = await getConversations();
  const conversation = await conversationsCol.findOne({ callId });
  timer.step("db.findConversation");
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
  timer.step("db.countAppointments");
  if (apptCount > 0) {
    update.bookingMade = true;
  }

  await conversationsCol.updateOne({ _id: conversation._id }, { $set: update });
  timer.step("db.updateConversation");

  // Bump caller's callCount and lastCalledAt.
  const callersCol = await getCallers();
  await callersCol.updateOne(
    { _id: conversation.callerId },
    { $inc: { callCount: 1 }, $set: { lastCalledAt: endedAt, updatedAt: endedAt } },
  );
  timer.step("db.bumpCaller");

  console.log(`[webhook] call_ended ${callId} status=${status ?? "unknown"} bookingMade=${update.bookingMade ?? false}`);
}
