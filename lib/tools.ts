import type Anthropic from "@anthropic-ai/sdk";
import { ObjectId, type Db } from "mongodb";
import type { Business, Caller, Conversation, Appointment } from "./types";
import { getAvailableSlots, findNextOpenSlots, isSlotAvailable } from "./availability";
import {
  toBusinessDateTime,
  formatInBusinessTz,
  todayInBusinessTz,
  addDaysToDateStr,
} from "./dates";
import { buildCallerContext } from "./caller-context";
import { rememberCallerFact } from "./supermemory";
import { sendBookingConfirmation } from "./agentmail";
import { searchBusinessKnowledge } from "./moss";

export type ToolContext = {
  business: Business;
  caller: Caller;
  conversation: Conversation;
  db: Db;
};

export type ToolExecutionResult = {
  output: string;
  transfer?: boolean;
  bookingMade?: boolean;
  callerUpdated?: Partial<Caller>;
};

export const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "check_availability",
    description:
      "Check available appointment slots for a specific date. Always call this before book_appointment. Returns open time slots in the business's local timezone.",
    input_schema: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description:
            "The date to check in YYYY-MM-DD format. Use today's date from the context if the caller says 'today', tomorrow's date if they say 'tomorrow', etc.",
        },
        durationMinutes: {
          type: "number",
          description: "Appointment length in minutes. Default 60.",
        },
      },
      required: ["date"],
    },
  },
  {
    name: "book_appointment",
    description:
      "Book an appointment for the caller. ALWAYS call check_availability first. ALWAYS spell back the caller's name to confirm before calling this. Returns a confirmation string.",
    input_schema: {
      type: "object",
      properties: {
        startTime: {
          type: "string",
          description:
            "ISO datetime in business local time, e.g. 2026-05-23T11:00:00. Do NOT include a timezone suffix; the system will apply the business timezone.",
        },
        durationMinutes: {
          type: "number",
          description: "Length of appointment. Default 60.",
        },
        service: {
          type: "string",
          description: "The service being booked. Must be from the business's service menu.",
        },
        callerName: {
          type: "string",
          description: "Full name of the caller, confirmed verbally.",
        },
        callerEmail: {
          type: "string",
          description: "Optional email if the caller offered one.",
        },
      },
      required: ["startTime", "service", "callerName"],
    },
  },
  {
    name: "lookup_caller",
    description: "Look up what we know about the current caller. Useful for confirming details mid-call.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "update_caller_info",
    description:
      "Update what we know about the caller. Use after they tell you their name, email, or any preference you should remember for next time.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        email: { type: "string" },
        notes: {
          type: "string",
          description: "Free text about preferences, like 'allergic to ammonia' or 'prefers Mishi as stylist'.",
        },
        callbackPhone: {
          type: "string",
          description: "E.164 number if different from the calling number.",
        },
      },
      required: [],
    },
  },
  {
    name: "lookup_business_info",
    description:
      "Semantic-search the business's own knowledge base (website, service menu, reviews, enriched pricing) to answer an off-script question accurately. Use whenever the caller asks something not directly covered by your system prompt — e.g. 'do you have parking?', 'are you kid-friendly?', 'what's your cancellation policy?'. Returns the top 3 relevant snippets.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The caller's question, phrased as a search query.",
        },
      },
      required: ["question"],
    },
  },
  {
    name: "transfer_to_human",
    description:
      "Transfer the call to a human at the business. Use only if the caller specifically asks for a human OR the request is clearly outside what you can handle.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

export async function executeTool(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  switch (name) {
    case "check_availability":
      return checkAvailability(input, ctx);
    case "book_appointment":
      return bookAppointment(input, ctx);
    case "lookup_caller":
      return lookupCaller(ctx);
    case "update_caller_info":
      return updateCallerInfo(input, ctx);
    case "lookup_business_info":
      return lookupBusinessInfo(input, ctx);
    case "transfer_to_human":
      return { output: "Transferring now.", transfer: true };
    default:
      return { output: `Unknown tool: ${name}` };
  }
}

async function checkAvailability(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const date = typeof input.date === "string" ? input.date : todayInBusinessTz(ctx.business.timezone);
  const durationMinutes = typeof input.durationMinutes === "number" ? input.durationMinutes : 60;

  const appointments = ctx.db.collection<Appointment>("appointments");

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { output: `Date format must be YYYY-MM-DD. Got "${date}".` };
  }

  const { dayKey, slots, isClosed } = await getAvailableSlots(
    ctx.business,
    date,
    durationMinutes,
    appointments,
  );

  if (isClosed) {
    const next = await findNextOpenSlots(
      ctx.business,
      addDaysToDateStr(date, 1),
      3,
      durationMinutes,
      appointments,
    );
    const nextStr = next
      .map((n) => `${n.date} (${cap(n.dayKey)}): ${n.slots.join(", ")}`)
      .join("; ");
    return {
      output: `We are closed ${cap(dayKey)} ${date}. Next available: ${nextStr || "none in the next two weeks"}.`,
    };
  }

  if (slots.length === 0) {
    const next = await findNextOpenSlots(
      ctx.business,
      addDaysToDateStr(date, 1),
      3,
      durationMinutes,
      appointments,
    );
    const nextStr = next
      .map((n) => `${n.date} (${cap(n.dayKey)}): ${n.slots.join(", ")}`)
      .join("; ");
    return {
      output: `No availability on ${cap(dayKey)} ${date}. Next available: ${nextStr || "none in the next two weeks"}.`,
    };
  }

  return {
    output: `Available ${cap(dayKey)} ${date}: ${slots.join(", ")}.`,
  };
}

async function bookAppointment(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const startTimeStr = typeof input.startTime === "string" ? input.startTime : null;
  const durationMinutes = typeof input.durationMinutes === "number" ? input.durationMinutes : 60;
  const service = typeof input.service === "string" ? input.service : null;
  const callerName = typeof input.callerName === "string" ? input.callerName : null;
  const callerEmail = typeof input.callerEmail === "string" ? input.callerEmail : undefined;

  if (!startTimeStr || !service || !callerName) {
    return { output: "Missing startTime, service, or callerName. Please collect them and try again." };
  }

  let startTime: Date;
  try {
    startTime = toBusinessDateTime(startTimeStr, ctx.business.timezone);
  } catch {
    return { output: `Could not parse startTime "${startTimeStr}". Expected YYYY-MM-DDTHH:MM:SS.` };
  }
  const endTime = new Date(startTime.getTime() + durationMinutes * 60_000);

  const appointments = ctx.db.collection<Appointment>("appointments");
  const free = await isSlotAvailable(ctx.business, startTime, endTime, appointments);
  if (!free) {
    return { output: "That slot was just taken. Please offer the caller another time." };
  }

  const doc: Omit<Appointment, "_id"> = {
    businessId: ctx.business._id,
    callerId: ctx.caller._id,
    conversationId: ctx.conversation._id,
    callerName,
    callerPhone: ctx.caller.phone,
    callerEmail,
    service,
    startTime,
    endTime,
    durationMinutes,
    status: "booked",
    source: "voice",
    createdAt: new Date(),
  };
  const insertResult = await appointments.insertOne({
    ...doc,
    _id: new ObjectId(),
  } as Appointment);

  // Update caller profile.
  const callerUpdate: Partial<Caller> = {
    name: callerName,
    updatedAt: new Date(),
  };
  if (callerEmail) callerUpdate.email = callerEmail;
  await ctx.db.collection<Caller>("callers").updateOne(
    { _id: ctx.caller._id },
    {
      $set: callerUpdate,
      $inc: { appointmentCount: 1 },
    },
  );

  const readable = formatInBusinessTz(startTime, ctx.business.timezone);

  // Send AgentMail confirmation if we have an email + inbox (best-effort).
  let emailLine = "";
  const sendableEmail = callerEmail || ctx.caller.email;
  if (sendableEmail && ctx.business.agentMailInboxId) {
    try {
      const resp = await sendBookingConfirmation({
        inboxId: ctx.business.agentMailInboxId,
        to: sendableEmail,
        businessName: ctx.business.name,
        customerName: callerName,
        service,
        startsAt: readable,
        businessAddress: ctx.business.address,
        businessPhone: ctx.business.phone,
      });
      await appointments.updateOne(
        { _id: insertResult.insertedId },
        { $set: { confirmationEmailMessageId: resp.messageId } },
      );
      emailLine = ` Confirmation email sent to ${sendableEmail}.`;
    } catch (err) {
      console.warn(`[tools] AgentMail send failed:`, (err as Error).message);
    }
  }

  // Save a Supermemory fact for next call (best-effort).
  await rememberCallerFact(
    ctx.business._id.toString(),
    ctx.caller.phone,
    `Booked ${service} on ${readable} for ${callerName}${sendableEmail ? ` (${sendableEmail})` : ""}.`,
    { kind: "booking" },
  ).catch(() => {});

  return {
    output: `Booked. Confirmation: ${service} for ${callerName} on ${readable}.${emailLine} Reference: ${insertResult.insertedId.toString().slice(-6).toUpperCase()}.`,
    bookingMade: true,
    callerUpdated: callerUpdate,
  };
}

async function lookupCaller(ctx: ToolContext): Promise<ToolExecutionResult> {
  const text = await buildCallerContext(ctx.business, ctx.caller, ctx.db);
  return { output: text };
}

async function updateCallerInfo(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const set: Partial<Caller> = { updatedAt: new Date() };
  if (typeof input.name === "string" && input.name.trim()) set.name = input.name.trim();
  if (typeof input.email === "string" && input.email.trim()) set.email = input.email.trim();
  if (typeof input.notes === "string" && input.notes.trim()) set.notes = input.notes.trim();
  if (typeof input.callbackPhone === "string" && input.callbackPhone.trim()) {
    set.callbackPhone = input.callbackPhone.trim();
  }

  if (Object.keys(set).length === 1) {
    return { output: "Nothing to update." };
  }

  await ctx.db.collection<Caller>("callers").updateOne({ _id: ctx.caller._id }, { $set: set });

  // Mirror freeform notes + new identifying info into Supermemory so semantic recall works next call.
  const factParts: string[] = [];
  if (set.name) factParts.push(`Name: ${set.name}`);
  if (set.email) factParts.push(`Email: ${set.email}`);
  if (set.callbackPhone) factParts.push(`Callback: ${set.callbackPhone}`);
  if (set.notes) factParts.push(set.notes);
  if (factParts.length > 0) {
    await rememberCallerFact(
      ctx.business._id.toString(),
      ctx.caller.phone,
      factParts.join(". "),
      { kind: "note" },
    ).catch(() => {});
  }
  return { output: "Updated.", callerUpdated: set };
}

async function lookupBusinessInfo(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const question = typeof input.question === "string" ? input.question.trim() : "";
  if (!question) return { output: "No question provided." };
  const hits = await searchBusinessKnowledge(ctx.business, question, 3);
  if (hits.length === 0) {
    return {
      output: "No information in the business knowledge base for that question. Take a message if appropriate.",
    };
  }
  const formatted = hits
    .map((h, i) => `[${i + 1}] (${h.source}, score ${h.score.toFixed(2)}) ${h.text.slice(0, 500)}`)
    .join("\n");
  return { output: `Knowledge base hits:\n${formatted}` };
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}
