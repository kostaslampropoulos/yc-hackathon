import type Anthropic from "@anthropic-ai/sdk";
import type { Db } from "mongodb";
import { anthropic, CLAUDE_MODEL } from "./anthropic";
import { TOOL_DEFINITIONS, executeTool } from "./tools";
import { todayInBusinessTz, nowInBusinessTz } from "./dates";
import type { Business, Caller, Conversation, AnthropicMessage } from "./types";

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
): Promise<AgentResult> {
  const system = composeSystem(business, callerContext);
  const messages: AnthropicMessage[] = [...conversation.messages];

  const result: AgentResult = { text: "", transfer: false, bookingMade: false };

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 400,
      system,
      tools: TOOL_DEFINITIONS,
      messages,
    });

    if (response.stop_reason === "tool_use") {
      // Run each tool_use block in order, collect results.
      const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== "tool_use") continue;
        const input = (block.input as Record<string, unknown>) ?? {};
        let toolOut;
        try {
          toolOut = await executeTool(block.name, input, {
            business,
            caller,
            conversation,
            db,
          });
        } catch (err) {
          toolOut = { output: `Tool ${block.name} failed: ${(err as Error).message}` };
        }

        toolResultBlocks.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: toolOut.output,
        });

        if (toolOut.transfer) result.transfer = true;
        if (toolOut.bookingMade) result.bookingMade = true;
      }

      // Append assistant's content (all blocks) and the tool results, then loop.
      messages.push({ role: "assistant", content: response.content });
      messages.push({ role: "user", content: toolResultBlocks });
      continue;
    }

    // End of turn — extract text.
    let text = "";
    for (const block of response.content) {
      if (block.type === "text") text += block.text;
    }
    messages.push({ role: "assistant", content: response.content });
    result.text = text.trim();
    break;
  }

  if (!result.text && result.transfer) {
    result.text = "Connecting you to a team member now.";
  }
  if (!result.text) {
    result.text = "Sorry, just a moment.";
  }

  // Mutate the conversation messages in place so the webhook caller can save them.
  conversation.messages = messages;

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
