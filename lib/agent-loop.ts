import type { Content, Part } from "@google/genai";
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

export async function runAgentLoop(
  business: Business,
  caller: Caller,
  conversation: Conversation,
  callerContext: string,
  db: Db,
  timer?: StepTimer,
): Promise<AgentResult> {
  const system = composeSystem(business, callerContext);
  const messages: Content[] = toGeminiMessages(conversation.messages as unknown[]);

  const ai = getGemini();
  const tools = [{ functionDeclarations: getGeminiTools() }];

  const result: AgentResult = { text: "", transfer: false, bookingMade: false };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: messages,
      config: {
        systemInstruction: system,
        tools,
        maxOutputTokens: 400,
        // Gemini 2.5 supports a "thinking budget"; voice needs sub-second so disable thinking.
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
    timer?.step(`gemini.turn${iter + 1}`);

    const candidate = response.candidates?.[0];
    const responseContent = candidate?.content;
    const parts = responseContent?.parts ?? [];

    const functionCallParts = parts.filter((p) => p.functionCall);

    if (functionCallParts.length > 0) {
      // Append model's content (text + functionCalls) to history.
      messages.push({ role: "model", parts });

      // Run each tool, build functionResponse parts.
      const toolResponseParts: Part[] = [];
      for (const p of functionCallParts) {
        const fc = p.functionCall!;
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

    // No function calls — extract text and end.
    const text = parts
      .filter((p) => typeof p.text === "string")
      .map((p) => p.text!)
      .join("")
      .trim();
    if (responseContent) {
      messages.push({ role: "model", parts });
    }
    result.text = text;
    break;
  }

  if (!result.text && result.transfer) {
    result.text = "Connecting you to a team member now.";
  }
  if (!result.text) {
    result.text = "Sorry, just a moment.";
  }

  // Save updated history back onto the conversation (typed as unknown[] in storage).
  conversation.messages = messages as unknown as Conversation["messages"];

  return result;
}

function composeSystem(business: Business, callerContext: string): string {
  const today = todayInBusinessTz(business.timezone);
  const now = nowInBusinessTz(business.timezone);
  return `${business.systemPrompt}

## Current context
- Current date: ${today}
- Current time: ${now}
- Business timezone: ${business.timezone}

## About this caller
${callerContext}`;
}
