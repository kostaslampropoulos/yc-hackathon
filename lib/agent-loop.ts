import { streamText, stepCountIs } from "ai";
import type { Db } from "mongodb";
import { getModel, GEMINI_MODEL, toModelMessages, fromResponseMessages, type StoredContent } from "./ai";
import { buildTools, type LoopState } from "./tools";
import { todayInBusinessTz, nowInBusinessTz } from "./dates";
import type { StepTimer } from "./timing";
import type { Business, Caller, Conversation } from "./types";

const MAX_ITERATIONS = 5;

export type AgentResult = {
  text: string;
  transfer: boolean;
  bookingMade: boolean;
};

export type AgentLoopOptions = {
  timer?: StepTimer;
  /** Optional callback invoked for every streamed text chunk. */
  onTextChunk?: (chunk: string) => void;
  /** Channel context: voice (default) tunes for short spoken replies; email
   * adapts the system prompt for written, slightly more structured replies. */
  channel?: "voice" | "email";
};

export async function runAgentLoop(
  business: Business,
  caller: Caller,
  conversation: Conversation,
  callerContext: string,
  db: Db,
  options: AgentLoopOptions = {},
): Promise<AgentResult> {
  const { timer, onTextChunk, channel = "voice" } = options;
  const system = composeSystem(business, callerContext, channel);
  const stored = (conversation.messages as StoredContent[]) ?? [];
  const messages = toModelMessages(stored);

  const loopState: LoopState = { transfer: false, bookingMade: false };
  const tools = buildTools({ business, caller, conversation, db }, loopState);

  const result = streamText({
    model: getModel(),
    system,
    messages,
    tools,
    stopWhen: stepCountIs(MAX_ITERATIONS),
    maxOutputTokens: 400,
    providerOptions: {
      google: { thinkingConfig: { thinkingBudget: 0 } },
    },
    experimental_telemetry: {
      isEnabled: true,
      functionId: "agent-loop",
      metadata: {
        businessId: business._id.toString(),
        callerId: caller._id.toString(),
        callId: conversation.callId,
        model: GEMINI_MODEL,
      },
    },
    onStepFinish: (step) => {
      timer?.step(`gemini.step${step.stepNumber + 1}`);
      for (const tc of step.toolCalls) {
        timer?.step(`tool.${tc.toolName}`);
      }
    },
  });

  // Drive interim text chunks from the full stream. NDJSON producer in the
  // webhook route buffers the most recent chunk and emits prior chunks as
  // `interim: true`, so each delta we forward becomes one interim line.
  for await (const ev of result.fullStream) {
    if (ev.type === "text-delta" && ev.text.length > 0) {
      onTextChunk?.(ev.text);
    }
  }

  const finalText = ((await result.text) ?? "").trim();
  const response = await result.response;
  conversation.messages = [...stored, ...fromResponseMessages(response.messages)] as Conversation["messages"];

  let text = finalText;
  if (!text && loopState.transfer) text = "Connecting you to a team member now.";
  if (!text) text = "Sorry, just a moment.";

  return { text, transfer: loopState.transfer, bookingMade: loopState.bookingMade };
}

function composeSystem(
  business: Business,
  callerContext: string,
  channel: "voice" | "email",
): string {
  const today = todayInBusinessTz(business.timezone);
  const now = nowInBusinessTz(business.timezone);

  const intake = business.intakeQuestions && business.intakeQuestions.length > 0
    ? `

## Booking intake
Before calling \`book_appointment\`, ask the caller these questions (one at a time, naturally — don't read them as a list). Wait for each answer before moving on. Only ask when the caller is actually booking, not for general inquiries.

${business.intakeQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}

When you call \`book_appointment\`, pass the answers as the \`intakeAnswers\` field, keyed by the question text exactly as written above.`
    : "";

  const channelRider = channel === "email"
    ? `

## Channel: Email
You are replying by email, not on a live phone call. Write a concise, plain-text reply — short paragraphs, no markdown formatting, no bullet lists, no signature block. Address the customer by name when known. When booking, cancelling, or modifying, ALWAYS state the appointment date/time and the REF code clearly in the body. If you need information from the customer (e.g. an intake answer), ask politely and wait for their next email — do not assume.`
    : "";

  return `${business.systemPrompt}

## Current context
- Current date: ${today}
- Current time: ${now}
- Business timezone: ${business.timezone}

## About this caller
${callerContext}${intake}${channelRider}`;
}
