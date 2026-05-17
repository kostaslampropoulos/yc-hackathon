import type { Content, FunctionCall, Part } from "@google/genai";
import type { Db } from "mongodb";
import { getGemini, GEMINI_MODEL, getGeminiTools, toGeminiMessages } from "./gemini";
import { executeTool } from "./tools";
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
};

export async function runAgentLoop(
  business: Business,
  caller: Caller,
  conversation: Conversation,
  callerContext: string,
  db: Db,
  options: AgentLoopOptions = {},
): Promise<AgentResult> {
  const { timer, onTextChunk } = options;
  const system = composeSystem(business, callerContext);
  const messages: Content[] = toGeminiMessages(conversation.messages as unknown[]);

  const ai = getGemini();
  const tools = [{ functionDeclarations: getGeminiTools() }];

  const result: AgentResult = { text: "", transfer: false, bookingMade: false };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const stream = await ai.models.generateContentStream({
      model: GEMINI_MODEL,
      contents: messages,
      config: {
        systemInstruction: system,
        tools,
        maxOutputTokens: 400,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });

    // Accumulate streamed parts into a single assistant turn.
    let turnText = "";
    const functionCalls: FunctionCall[] = [];
    const accumulatedParts: Part[] = [];

    for await (const chunk of stream) {
      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const part of parts) {
        if (typeof part.text === "string" && part.text.length > 0) {
          turnText += part.text;
          // Stream to caller (e.g., NDJSON to AgentPhone) as soon as available.
          onTextChunk?.(part.text);
        }
        if (part.functionCall) {
          functionCalls.push(part.functionCall);
        }
        // Preserve the entire part — keeps `thoughtSignature` (Gemini 2.5 requires it
        // on functionCall parts when replayed in the next turn).
        accumulatedParts.push(part);
      }
    }
    timer?.step(`gemini.turn${iter + 1}`);

    if (accumulatedParts.length > 0) {
      messages.push({ role: "model", parts: accumulatedParts });
    }

    if (functionCalls.length > 0) {
      // Run all tool calls in order, append their responses, loop again.
      const toolResponseParts: Part[] = [];
      for (const fc of functionCalls) {
        const name = fc.name ?? "";
        const input = (fc.args as Record<string, unknown>) ?? {};
        let toolOut;
        try {
          toolOut = await executeTool(name, input, {
            business,
            caller,
            conversation,
            db,
          });
        } catch (err) {
          toolOut = { output: `Tool ${name} failed: ${(err as Error).message}` };
        }
        timer?.step(`tool.${name}`);

        toolResponseParts.push({
          functionResponse: {
            name,
            response: { result: toolOut.output },
          },
        });

        if (toolOut.transfer) result.transfer = true;
        if (toolOut.bookingMade) result.bookingMade = true;
      }
      messages.push({ role: "user", parts: toolResponseParts });
      continue;
    }

    // No function calls — final turn. Capture text and stop.
    result.text = turnText.trim();
    break;
  }

  if (!result.text && result.transfer) {
    result.text = "Connecting you to a team member now.";
  }
  if (!result.text) {
    result.text = "Sorry, just a moment.";
  }

  conversation.messages = messages as unknown as Conversation["messages"];

  return result;
}

function composeSystem(business: Business, callerContext: string): string {
  const today = todayInBusinessTz(business.timezone);
  const now = nowInBusinessTz(business.timezone);

  const intake = business.intakeQuestions && business.intakeQuestions.length > 0
    ? `

## Booking intake
Before calling \`book_appointment\`, ask the caller these questions (one at a time, naturally — don't read them as a list). Wait for each answer before moving on. Only ask when the caller is actually booking, not for general inquiries.

${business.intakeQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}

When you call \`book_appointment\`, pass the answers as the \`intakeAnswers\` field, keyed by the question text exactly as written above.`
    : "";

  return `${business.systemPrompt}

## Current context
- Current date: ${today}
- Current time: ${now}
- Business timezone: ${business.timezone}

## About this caller
${callerContext}${intake}`;
}
