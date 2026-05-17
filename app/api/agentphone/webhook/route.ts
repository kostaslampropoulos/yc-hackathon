import { ObjectId } from "mongodb";
import { anthropic, CLAUDE_MODEL } from "@/lib/anthropic";
import { getAppointments, getBusinesses, getConversations } from "@/lib/mongo";
import { recallCallerMemories, rememberCallerFact } from "@/lib/supermemory";
import { sendBookingConfirmation } from "@/lib/agentmail";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

type AgentEvent = {
  event?: string;
  type?: string;
  channel?: string;
  callId?: string;
  call_id?: string;
  id?: string;
  text?: string;
  message?: string;
  content?: string;
  from?: string;
  caller?: string;
  callerPhoneNumber?: string;
  caller_phone_number?: string;
  to?: string;
  toNumber?: string;
  to_number?: string;
  agentId?: string;
  agent_id?: string;
  [k: string]: unknown;
};

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) return `+${trimmed.slice(1).replace(/\D/g, "")}`;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits ? `+${digits}` : null;
}

async function findBusinessForEvent(payload: AgentEvent): Promise<Business | null> {
  const businesses = await getBusinesses();
  const toNumber = normalizePhone(pickString(payload, "to", "toNumber", "to_number", "calledNumber", "called_number"));
  if (toNumber) {
    const byNumber = await businesses.findOne({ agentPhoneNumber: toNumber });
    if (byNumber) return byNumber;
  }
  const agentId = pickString(payload, "agentId", "agent_id");
  if (agentId) {
    const byAgent = await businesses.findOne({ agentPhoneAgentId: agentId });
    if (byAgent) return byAgent;
  }
  return null;
}

const ANTHROPIC_TOOLS = [
  {
    name: "check_availability",
    description:
      "Check whether a requested time slot is available. Use this BEFORE confirming any booking. Pass an ISO 8601 datetime.",
    input_schema: {
      type: "object" as const,
      properties: {
        startsAt: { type: "string", description: "Requested start time in ISO 8601 (e.g. 2026-05-20T14:30:00-07:00)" },
        service: { type: "string", description: "Service the caller wants" },
      },
      required: ["startsAt", "service"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book the appointment after the caller has confirmed name, time, service, and provided an email for confirmation. Only call once per booking. This automatically sends a confirmation email if an email was provided.",
    input_schema: {
      type: "object" as const,
      properties: {
        customerName: { type: "string" },
        customerEmail: { type: ["string", "null"] as unknown as string, description: "Email for confirmation, or null if caller declined" },
        service: { type: "string" },
        startsAt: { type: "string", description: "ISO 8601 start time" },
        notes: { type: ["string", "null"] as unknown as string },
      },
      required: ["customerName", "service", "startsAt"],
    },
  },
  {
    name: "remember_about_caller",
    description:
      "Save a short fact about this caller that future calls should know (preferences, allergies, usual stylist, kid's name, etc). Don't save PII you weren't volunteered.",
    input_schema: {
      type: "object" as const,
      properties: {
        fact: { type: "string", description: "Single short sentence." },
      },
      required: ["fact"],
    },
  },
  {
    name: "transfer_to_human",
    description: "Hand the call off to the business's transfer number. Use only when the caller insists or the request is out of scope.",
    input_schema: { type: "object" as const, properties: {}, required: [] },
  },
];

type ToolResult = { ok: boolean; data?: unknown; error?: string };

async function runTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { business: Business; callerPhone: string | null; callId: string },
): Promise<ToolResult> {
  switch (name) {
    case "check_availability": {
      const startsAt = String(input.startsAt ?? "");
      const when = new Date(startsAt);
      if (isNaN(when.getTime())) return { ok: false, error: "Invalid startsAt" };
      const appts = await getAppointments();
      const windowStart = new Date(when.getTime() - 30 * 60_000);
      const windowEnd = new Date(when.getTime() + 30 * 60_000);
      const conflict = await appts.findOne({
        businessId: ctx.business._id,
        startsAt: { $gte: windowStart, $lt: windowEnd },
      });
      return { ok: true, data: { available: !conflict, requested: when.toISOString() } };
    }
    case "book_appointment": {
      if (!ctx.callerPhone) return { ok: false, error: "No caller phone on this call." };
      const startsAt = new Date(String(input.startsAt ?? ""));
      if (isNaN(startsAt.getTime())) return { ok: false, error: "Invalid startsAt" };
      const customerName = String(input.customerName ?? "").trim() || "Unknown";
      const service = String(input.service ?? "").trim() || "Appointment";
      const customerEmail =
        typeof input.customerEmail === "string" && input.customerEmail.includes("@")
          ? input.customerEmail
          : null;
      const notes = typeof input.notes === "string" ? input.notes : null;

      const appts = await getAppointments();
      const insertion = await appts.insertOne({
        _id: new ObjectId(),
        businessId: ctx.business._id,
        callerPhone: ctx.callerPhone,
        customerName,
        customerEmail,
        service,
        startsAt,
        notes,
        source: "voice",
        callId: ctx.callId,
        createdAt: new Date(),
      });

      let emailMessageId: string | null = null;
      let emailError: string | null = null;
      if (customerEmail && ctx.business.agentMailInboxId) {
        try {
          const resp = await sendBookingConfirmation({
            inboxId: ctx.business.agentMailInboxId,
            to: customerEmail,
            businessName: ctx.business.name,
            customerName,
            service,
            startsAt: startsAt.toLocaleString("en-US", {
              dateStyle: "full",
              timeStyle: "short",
              timeZone: ctx.business.timezone,
            }),
            notes: notes ?? undefined,
            businessAddress: ctx.business.address,
            businessPhone: ctx.business.phone,
          });
          emailMessageId = resp.messageId;
          await getAppointments().then((c) =>
            c.updateOne(
              { _id: insertion.insertedId },
              { $set: { confirmationEmailMessageId: emailMessageId } },
            ),
          );
        } catch (err) {
          emailError = (err as Error).message;
          console.warn(`[webhook] agentmail send failed:`, emailError);
        }
      }

      await rememberCallerFact(
        ctx.business._id.toString(),
        ctx.callerPhone,
        `Booked ${service} on ${startsAt.toISOString()} for ${customerName}${customerEmail ? ` (${customerEmail})` : ""}.`,
        { kind: "booking" },
      ).catch(() => {});

      return {
        ok: true,
        data: {
          booked: true,
          startsAt: startsAt.toISOString(),
          emailSent: !!emailMessageId,
          emailError: emailError ?? undefined,
        },
      };
    }
    case "remember_about_caller": {
      if (!ctx.callerPhone) return { ok: false, error: "No caller phone on this call." };
      const fact = String(input.fact ?? "").trim();
      if (!fact) return { ok: false, error: "Empty fact" };
      await rememberCallerFact(ctx.business._id.toString(), ctx.callerPhone, fact, { kind: "note" });
      return { ok: true, data: { saved: true } };
    }
    case "transfer_to_human": {
      return {
        ok: true,
        data: { transferNumber: ctx.business.phone, instruction: "Transfer the caller now." },
      };
    }
    default:
      return { ok: false, error: `Unknown tool ${name}` };
  }
}

function buildSystem(business: Business, memories: string[]): string {
  const memorySection = memories.length
    ? `\n\nWHAT YOU REMEMBER ABOUT THIS CALLER:\n${memories.map((m) => `- ${m}`).join("\n")}\n\nAcknowledge what you remember naturally if relevant; do not list it back robotically.`
    : `\n\nThis caller is new — there are no prior memories.`;
  const services = business.serviceMenu.length
    ? `\n\nSERVICES YOU OFFER (only quote these):\n${business.serviceMenu.map((s) => `- ${s}`).join("\n")}`
    : "";
  const enriched = business.enrichment?.services?.length
    ? `\n\nLIVE PRICES (from the booking page):\n${business.enrichment.services
        .map((s) => `- ${s.name}${s.priceUsd ? ` $${s.priceUsd}` : ""}${s.durationMinutes ? ` (${s.durationMinutes}m)` : ""}`)
        .join("\n")}`
    : "";
  return `${business.systemPrompt}${services}${enriched}${memorySection}\n\nCurrent date/time: ${new Date().toISOString()} (business timezone ${business.timezone}). Keep replies under 2 sentences for voice. Always confirm names and emails by spelling them back.`;
}

async function handleVoiceMessage(payload: AgentEvent): Promise<Response> {
  const business = await findBusinessForEvent(payload);
  if (!business) {
    return Response.json({
      text: "I'm sorry, this number isn't connected yet. Please try again in a few minutes.",
    });
  }
  const callId =
    pickString(payload, "callId", "call_id", "id") ?? `synthetic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const callerPhone = normalizePhone(pickString(payload, "from", "caller", "callerPhoneNumber", "caller_phone_number"));
  const userText = pickString(payload, "text", "message", "content") ?? "";

  const conversations = await getConversations();
  const now = new Date();
  await conversations.updateOne(
    { callId },
    {
      $setOnInsert: {
        callId,
        businessId: business._id,
        callerPhone,
        startedAt: now,
        turns: [],
      },
      $set: { updatedAt: now },
    },
    { upsert: true },
  );

  const convo = await conversations.findOne({ callId });
  const priorTurns = convo?.turns ?? [];

  let memories: string[] = [];
  if (callerPhone && priorTurns.length === 0) {
    const hits = await recallCallerMemories(business._id.toString(), callerPhone, userText || "greeting", 5);
    memories = hits.map((h) => h.text);
  } else if (callerPhone && userText) {
    const hits = await recallCallerMemories(business._id.toString(), callerPhone, userText, 3);
    memories = hits.map((h) => h.text);
  }

  const system = buildSystem(business, memories);
  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
    | { type: "tool_result"; tool_use_id: string; content: string };
  const messages: { role: "user" | "assistant"; content: string | ContentBlock[] }[] = [];
  for (const t of priorTurns) {
    messages.push({ role: t.role, content: t.content });
  }
  messages.push({ role: "user", content: userText || "(caller said nothing audible)" });

  let finalText = "";
  let shouldTransfer = false;

  for (let step = 0; step < 5; step++) {
    const resp = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system,
      tools: ANTHROPIC_TOOLS,
      messages: messages as Parameters<typeof anthropic.messages.create>[0]["messages"],
    });

    const toolUses: { id: string; name: string; input: Record<string, unknown> }[] = [];
    let textOut = "";
    for (const block of resp.content) {
      if (block.type === "text") textOut += block.text;
      if (block.type === "tool_use")
        toolUses.push({ id: block.id, name: block.name, input: (block.input as Record<string, unknown>) ?? {} });
    }
    if (textOut) finalText = textOut.trim();

    if (toolUses.length === 0) break;

    messages.push({ role: "assistant", content: resp.content as unknown as ContentBlock[] });

    const toolResults: ContentBlock[] = [];
    for (const tu of toolUses) {
      const result = await runTool(tu.name, tu.input, { business, callerPhone, callId });
      if (tu.name === "transfer_to_human" && result.ok) shouldTransfer = true;
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: "user", content: toolResults });

    if (resp.stop_reason !== "tool_use") break;
  }

  await conversations.updateOne(
    { callId },
    {
      $push: {
        turns: {
          $each: [
            { role: "user", content: userText, ts: now },
            { role: "assistant", content: finalText, ts: new Date() },
          ],
        },
      },
      $set: { updatedAt: new Date() },
    },
  );

  if (shouldTransfer && business.phone) {
    return Response.json({
      text: finalText || "I'll transfer you now.",
      action: "transfer",
      transfer: { number: business.phone },
      transferNumber: business.phone,
    });
  }

  return Response.json({ text: finalText || "Could you repeat that?" });
}

export async function POST(req: Request) {
  let payload: AgentEvent;
  try {
    payload = (await req.json()) as AgentEvent;
  } catch {
    return Response.json({ ok: true });
  }

  const evt = (payload.event ?? payload.type ?? "").toString();
  const channel = (payload.channel ?? "voice").toString();
  const isVoiceMessage =
    channel === "voice" &&
    (evt === "agent.message" || evt === "message" || evt === "user.message" || evt === "transcript");

  if (isVoiceMessage) {
    try {
      return await handleVoiceMessage(payload);
    } catch (err) {
      console.error(`[webhook] voice handler failed:`, err);
      return Response.json({
        text: "Sorry, I'm having trouble. Please try calling back in a moment.",
      });
    }
  }

  if (evt === "call.ended" || evt === "agent.call.ended") {
    const callId = pickString(payload, "callId", "call_id", "id");
    if (callId) {
      const conversations = await getConversations();
      const convo = await conversations.findOneAndUpdate(
        { callId },
        { $set: { endedAt: new Date() } },
        { returnDocument: "after" },
      );
      if (convo) {
        const durationSec = Math.max(
          1,
          Math.round((new Date().getTime() - new Date(convo.startedAt).getTime()) / 1000),
        );
        const ratePerMin = Number.parseFloat(process.env.BILLING_RATE_USD_PER_MIN || "0.15");
        const minimum = Number.parseFloat(process.env.BILLING_MINIMUM_USD || "0.05");
        const cost = Math.max(minimum, (durationSec / 60) * ratePerMin);
        const businesses = await getBusinesses();
        await businesses.updateOne(
          { _id: convo.businessId },
          {
            $inc: { pendingBillUsd: cost, totalCallsCount: 1 },
            $set: { updatedAt: new Date() },
          },
        );
      }
    }
  }

  return Response.json({ ok: true });
}

export async function GET() {
  return Response.json({ ok: true, phase: 2 });
}
