import { ObjectId, type Db } from "mongodb";
import { tool } from "ai";
import { z } from "zod";
import type { Business, Caller, Conversation, Appointment } from "./types";
import { getAvailableSlots, findNextOpenSlots, isSlotAvailable } from "./availability";
import {
  toBusinessDateTime,
  toBusinessDate,
  formatInBusinessTz,
  todayInBusinessTz,
  addDaysToDateStr,
  minutesOfDayInTz,
} from "./dates";
import { buildCallerContext } from "./caller-context";
import { searchBusinessInfo } from "./moss";

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

/** Mutable signals captured during a single agent-loop run. */
export type LoopState = {
  transfer: boolean;
  bookingMade: boolean;
};

/**
 * Build the AI-SDK tool set for one request. Tools are closure-built so each
 * `execute` can reach the request-scoped `ctx` and mutate `loopState` (which
 * carries the `transfer` / `bookingMade` signals back to the caller).
 */
export function buildTools(ctx: ToolContext, loopState: LoopState) {
  const run = async (name: string, input: Record<string, unknown>): Promise<string> => {
    let r: ToolExecutionResult;
    try {
      r = await executeToolImpl(name, input, ctx);
    } catch (err) {
      return `Tool ${name} failed: ${(err as Error).message}`;
    }
    if (r.transfer) loopState.transfer = true;
    if (r.bookingMade) loopState.bookingMade = true;
    return r.output;
  };

  return {
    check_availability: tool({
      description:
        "Check available appointment slots for a specific date. Always call this before book_appointment. Returns open time slots in the business's local timezone.",
      inputSchema: z.object({
        date: z
          .string()
          .describe(
            "The date to check in YYYY-MM-DD format. Use today's date from the context if the caller says 'today', tomorrow's date if they say 'tomorrow', etc.",
          ),
        durationMinutes: z.number().describe("Appointment length in minutes. Default 60.").optional(),
      }),
      execute: async (input) => run("check_availability", input as Record<string, unknown>),
    }),

    book_appointment: tool({
      description:
        "Book an appointment for the caller. ALWAYS call check_availability first. ALWAYS spell back the caller's name to confirm before calling this. If the system prompt's 'Booking intake' section lists questions, collect ALL of those answers and pass them via the `intakeAnswers` field. Returns a confirmation string.",
      inputSchema: z.object({
        startTime: z
          .string()
          .describe(
            "ISO datetime in business local time, e.g. 2026-05-23T11:00:00. Do NOT include a timezone suffix; the system will apply the business timezone.",
          ),
        durationMinutes: z.number().describe("Length of appointment. Default 60.").optional(),
        service: z.string().describe("The service being booked. Must be from the business's service menu."),
        callerName: z.string().describe("Full name of the caller, confirmed verbally."),
        callerEmail: z.string().describe("Optional email if the caller offered one.").optional(),
        intakeAnswers: z
          .record(z.string(), z.string())
          .describe(
            "Answers to the business's intake questions (defined under 'Booking intake' in the system prompt). Keys are the exact question text; values are the caller's verbal answer. Omit if no intake questions are configured.",
          )
          .optional(),
      }),
      execute: async (input) => run("book_appointment", input as Record<string, unknown>),
    }),

    lookup_caller: tool({
      description: "Look up what we know about the current caller. Useful for confirming details mid-call.",
      inputSchema: z.object({}),
      execute: async (input) => run("lookup_caller", input as Record<string, unknown>),
    }),

    update_caller_info: tool({
      description:
        "Update what we know about the caller. Use after they tell you their name, email, or any preference you should remember for next time.",
      inputSchema: z.object({
        name: z.string().optional(),
        email: z.string().optional(),
        notes: z
          .string()
          .describe("Free text about preferences, like 'allergic to ammonia' or 'prefers Mishi as stylist'.")
          .optional(),
        callbackPhone: z.string().describe("E.164 number if different from the calling number.").optional(),
      }),
      execute: async (input) => run("update_caller_info", input as Record<string, unknown>),
    }),

    transfer_to_human: tool({
      description:
        "Transfer the call to a human at the business. Use only if the caller specifically asks for a human OR the request is clearly outside what you can handle.",
      inputSchema: z.object({}),
      execute: async (input) => run("transfer_to_human", input as Record<string, unknown>),
    }),

    cancel_appointment: tool({
      description:
        "Cancel one of the caller's existing upcoming appointments. If you don't already know which appointment they mean, call lookup_caller first to see their upcoming bookings (with REF codes). If multiple appointments could match, ASK the caller to clarify before calling this — don't guess. Pass appointmentReference (the 6-character REF code from lookup_caller) when you have it; otherwise pass date/time/service criteria to disambiguate.",
      inputSchema: z.object({
        appointmentReference: z
          .string()
          .describe("6-character REF code from lookup_caller, e.g. 'A1B2C3'. Preferred when available.")
          .optional(),
        date: z
          .string()
          .describe("YYYY-MM-DD of the appointment to cancel. Use only if you don't have the REF code.")
          .optional(),
        time: z.string().describe("Time the caller specified, e.g. '2:00 PM' or '14:00'. Use only to disambiguate.").optional(),
        service: z.string().describe("Service name on the appointment. Use only to disambiguate.").optional(),
      }),
      execute: async (input) => run("cancel_appointment", input as Record<string, unknown>),
    }),

    modify_appointment: tool({
      description:
        "Reschedule one of the caller's existing upcoming appointments to a new time. ALWAYS call check_availability for the new slot first. To change the service, cancel the appointment and book a new one instead — this tool only moves an appointment in time. Identify the existing appointment with appointmentReference if known, otherwise with date/time/service criteria.",
      inputSchema: z.object({
        appointmentReference: z.string().describe("6-character REF code from lookup_caller. Preferred when available.").optional(),
        date: z
          .string()
          .describe("YYYY-MM-DD of the EXISTING appointment (for disambiguation, not the new date).")
          .optional(),
        time: z.string().describe("Time of the EXISTING appointment, e.g. '2:00 PM'. For disambiguation only.").optional(),
        service: z.string().describe("Service name of the EXISTING appointment. For disambiguation only.").optional(),
        newStartTime: z
          .string()
          .describe(
            "New start time as ISO local datetime, e.g. 2026-05-23T16:00:00. No timezone suffix; the business timezone is applied.",
          ),
        newDurationMinutes: z
          .number()
          .describe("New length in minutes. Optional; defaults to the existing appointment's duration.")
          .optional(),
      }),
      execute: async (input) => run("modify_appointment", input as Record<string, unknown>),
    }),

    search_business_info: tool({
      description:
        "Search the business's website for specific information the caller asked about — products, policies, pricing, services not covered in the system prompt. Use ONLY for specific factual questions you can't already answer. Do NOT use for greetings, the booking flow, hours, or anything already in the system prompt.",
      inputSchema: z.object({
        query: z.string().describe("The caller's question or key search terms."),
      }),
      execute: async (input) => run("search_business_info", input as Record<string, unknown>),
    }),
  };
}

// Kept exported for any debug/inspection callers; no longer the source of truth
// for the model's view of tools (that's `buildTools`).
export const TOOL_NAMES = [
  "check_availability",
  "book_appointment",
  "lookup_caller",
  "update_caller_info",
  "transfer_to_human",
  "cancel_appointment",
  "modify_appointment",
  "search_business_info",
] as const;

async function executeToolImpl(
  name: string,
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  switch (name) {
    case "check_availability":
      return checkAvailability(input, ctx);
    case "book_appointment":
      return bookAppointment(input, ctx);
    case "cancel_appointment":
      return cancelAppointment(input, ctx);
    case "modify_appointment":
      return modifyAppointment(input, ctx);
    case "lookup_caller":
      return lookupCaller(ctx);
    case "update_caller_info":
      return updateCallerInfo(input, ctx);
    case "transfer_to_human":
      return { output: "Transferring now.", transfer: true };
    case "search_business_info":
      return searchBusinessInfoTool(input, ctx);
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
  const intakeAnswers = sanitizeIntakeAnswers(input.intakeAnswers);

  if (!startTimeStr || !service || !callerName) {
    return { output: "Missing startTime, service, or callerName. Please collect them and try again." };
  }

  // Nudge the model to gather intake first.
  const required = ctx.business.intakeQuestions ?? [];
  if (required.length > 0) {
    const missing = required.filter((q) => !intakeAnswers || !intakeAnswers[q]);
    if (missing.length > 0) {
      return {
        output:
          `Missing intake answers for: ${missing.map((m) => `"${m}"`).join(", ")}. ` +
          `Ask the caller these questions one at a time, then retry book_appointment with intakeAnswers populated using each question text as the key.`,
      };
    }
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
    callerEmail: callerEmail ?? ctx.caller.email,
    service,
    startTime,
    endTime,
    durationMinutes,
    status: "booked",
    source: ctx.conversation.channel === "email" ? "email" : "voice",
    intakeAnswers: intakeAnswers && Object.keys(intakeAnswers).length > 0 ? intakeAnswers : undefined,
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
  return {
    output: `Booked. Confirmation: ${service} for ${callerName} on ${readable}. Reference: ${insertResult.insertedId.toString().slice(-6).toUpperCase()}.`,
    bookingMade: true,
    callerUpdated: callerUpdate,
  };
}

type ResolveInput = {
  appointmentReference?: string;
  date?: string;
  time?: string;
  service?: string;
};

function refOf(id: Appointment["_id"]): string {
  return id.toString().slice(-6).toUpperCase();
}

function parseTimeToMinutes(t: string): number | null {
  const m = t.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3];
  if (ampm === "pm" && h < 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

async function resolveCallerAppointment(
  ctx: ToolContext,
  input: ResolveInput,
): Promise<{ appointment: Appointment } | { error: string }> {
  const appointments = ctx.db.collection<Appointment>("appointments");
  const upcoming = await appointments
    .find({
      callerId: ctx.caller._id,
      businessId: ctx.business._id,
      status: "booked",
      startTime: { $gte: new Date() },
    })
    .sort({ startTime: 1 })
    .limit(20)
    .toArray();

  if (upcoming.length === 0) {
    return { error: "No upcoming appointments on file for this caller." };
  }

  let matches = upcoming;

  const ref = typeof input.appointmentReference === "string" ? input.appointmentReference.trim().toUpperCase() : "";
  if (ref) {
    matches = matches.filter((a) => refOf(a._id) === ref);
  } else {
    if (typeof input.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date)) {
      const dayStart = toBusinessDate(input.date, ctx.business.timezone);
      const dayEnd = new Date(dayStart.getTime() + 24 * 60 * 60_000);
      matches = matches.filter((a) => a.startTime >= dayStart && a.startTime < dayEnd);
    }
    if (typeof input.time === "string" && input.time.trim()) {
      const targetMin = parseTimeToMinutes(input.time);
      if (targetMin !== null) {
        matches = matches.filter((a) => minutesOfDayInTz(a.startTime, ctx.business.timezone) === targetMin);
      }
    }
    if (typeof input.service === "string" && input.service.trim()) {
      const s = input.service.trim().toLowerCase();
      matches = matches.filter((a) => a.service.toLowerCase().includes(s));
    }
  }

  if (matches.length === 0) {
    const list = upcoming
      .map((a) => `[REF ${refOf(a._id)}] ${a.service} on ${formatInBusinessTz(a.startTime, ctx.business.timezone)}`)
      .join("; ");
    return {
      error: `No upcoming appointment matches that. The caller has: ${list}. Ask the caller which one they mean.`,
    };
  }
  if (matches.length > 1) {
    const list = matches
      .map((a) => `[REF ${refOf(a._id)}] ${a.service} on ${formatInBusinessTz(a.startTime, ctx.business.timezone)}`)
      .join("; ");
    return { error: `Multiple matches: ${list}. Ask the caller which one they mean.` };
  }
  return { appointment: matches[0] };
}

async function cancelAppointment(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const resolved = await resolveCallerAppointment(ctx, {
    appointmentReference: typeof input.appointmentReference === "string" ? input.appointmentReference : undefined,
    date: typeof input.date === "string" ? input.date : undefined,
    time: typeof input.time === "string" ? input.time : undefined,
    service: typeof input.service === "string" ? input.service : undefined,
  });
  if ("error" in resolved) return { output: resolved.error };
  const a = resolved.appointment;

  const appointments = ctx.db.collection<Appointment>("appointments");
  await appointments.updateOne({ _id: a._id }, { $set: { status: "cancelled" } });

  const readable = formatInBusinessTz(a.startTime, ctx.business.timezone);
  return { output: `Cancelled. ${a.service} on ${readable} is no longer booked.` };
}

async function modifyAppointment(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const newStartTimeStr = typeof input.newStartTime === "string" ? input.newStartTime : null;
  if (!newStartTimeStr) {
    return {
      output: "Missing newStartTime. Provide it as YYYY-MM-DDTHH:MM:SS in business local time (no timezone suffix).",
    };
  }

  const resolved = await resolveCallerAppointment(ctx, {
    appointmentReference: typeof input.appointmentReference === "string" ? input.appointmentReference : undefined,
    date: typeof input.date === "string" ? input.date : undefined,
    time: typeof input.time === "string" ? input.time : undefined,
    service: typeof input.service === "string" ? input.service : undefined,
  });
  if ("error" in resolved) return { output: resolved.error };
  const a = resolved.appointment;

  let newStart: Date;
  try {
    newStart = toBusinessDateTime(newStartTimeStr, ctx.business.timezone);
  } catch {
    return { output: `Could not parse newStartTime "${newStartTimeStr}". Expected YYYY-MM-DDTHH:MM:SS.` };
  }
  const newDuration =
    typeof input.newDurationMinutes === "number" && input.newDurationMinutes > 0
      ? input.newDurationMinutes
      : a.durationMinutes;
  const newEnd = new Date(newStart.getTime() + newDuration * 60_000);

  const appointments = ctx.db.collection<Appointment>("appointments");
  const free = await isSlotAvailable(ctx.business, newStart, newEnd, appointments, a._id);
  if (!free) {
    return { output: "That slot was just taken. Please offer the caller another time." };
  }

  await appointments.updateOne(
    { _id: a._id },
    { $set: { startTime: newStart, endTime: newEnd, durationMinutes: newDuration } },
  );

  const readable = formatInBusinessTz(newStart, ctx.business.timezone);
  return { output: `Rescheduled. ${a.service} now on ${readable}.` };
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
  return { output: "Updated.", callerUpdated: set };
}

async function searchBusinessInfoTool(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolExecutionResult> {
  const query = typeof input.query === "string" ? input.query.trim() : "";
  if (!query) {
    return { output: "Please provide a search query." };
  }
  const text = await searchBusinessInfo(ctx.business, query);
  return { output: text };
}

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function sanitizeIntakeAnswers(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || !k.trim()) continue;
    if (typeof v !== "string" || !v.trim()) continue;
    out[k.trim()] = v.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
