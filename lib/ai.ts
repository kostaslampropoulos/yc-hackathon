import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";

type ResponseMessage = AssistantModelMessage | ToolModelMessage;

// --- Stored conversation shape (Gemini-native Content[]) ----------------------
// Hand-rolled to drop the @google/genai dependency. Matches the structural
// subset of @google/genai's `Content` / `Part` that we persist and replay.

export type StoredPart =
  | { text: string }
  | { functionCall: { name: string; args: Record<string, unknown>; id?: string } }
  | {
      functionResponse: {
        name: string;
        response: Record<string, unknown>;
        id?: string;
      };
    }
  // Some Gemini 2.5 parts carry a `thoughtSignature` alongside other fields.
  | Record<string, unknown>;

export type StoredContent = {
  role: "user" | "model";
  parts: StoredPart[];
};

// --- Model factory -----------------------------------------------------------

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const googleProvider = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY || process.env.GEMINI_API_KEY,
});

export const getModel = () => googleProvider(GEMINI_MODEL);

// --- Translators -------------------------------------------------------------

// Synthesize a deterministic tool-call id from (name, args, index).
// Stored conversations don't carry the original toolCallId; AI SDK needs one
// to pair a tool-call with its tool-result.
function synthesizeToolCallId(name: string, args: unknown, index: number): string {
  let h = 5381;
  const s = `${name}|${JSON.stringify(args ?? {})}|${index}`;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h) ^ s.charCodeAt(i);
  return `call_${(h >>> 0).toString(36)}`;
}

function isFunctionCallPart(p: StoredPart): p is { functionCall: { name: string; args: Record<string, unknown> } } {
  return typeof p === "object" && p !== null && "functionCall" in p && !!(p as { functionCall?: unknown }).functionCall;
}

function isFunctionResponsePart(
  p: StoredPart,
): p is { functionResponse: { name: string; response: Record<string, unknown> } } {
  return (
    typeof p === "object" && p !== null && "functionResponse" in p && !!(p as { functionResponse?: unknown }).functionResponse
  );
}

function isTextPart(p: StoredPart): p is { text: string } {
  return typeof p === "object" && p !== null && "text" in p && typeof (p as { text?: unknown }).text === "string";
}

/**
 * Convert persisted Gemini Content[] into AI SDK ModelMessage[].
 *
 * Mapping:
 *  - { role: 'user', parts: [{ text }] }            → user message with text
 *  - { role: 'model', parts: [{ text }, { fc }] }   → assistant message
 *  - { role: 'user', parts: [{ functionResponse }]} → tool message
 */
export function toModelMessages(stored: StoredContent[]): ModelMessage[] {
  const out: ModelMessage[] = [];
  // Track most-recent synthesized ids per (function name) so a later
  // functionResponse can find its matching toolCallId.
  const pendingByName: Map<string, string[]> = new Map();
  let callIndex = 0;

  for (const msg of stored) {
    const parts = Array.isArray(msg.parts) ? msg.parts : [];

    if (msg.role === "model") {
      const content: NonNullable<Extract<ModelMessage, { role: "assistant" }>["content"]> = [];
      for (const p of parts) {
        if (isTextPart(p) && p.text.length > 0) {
          content.push({ type: "text", text: p.text });
        } else if (isFunctionCallPart(p)) {
          const id = synthesizeToolCallId(p.functionCall.name, p.functionCall.args, callIndex++);
          const queue = pendingByName.get(p.functionCall.name) ?? [];
          queue.push(id);
          pendingByName.set(p.functionCall.name, queue);
          content.push({
            type: "tool-call",
            toolCallId: id,
            toolName: p.functionCall.name,
            input: p.functionCall.args ?? {},
          });
        }
      }
      if (content.length > 0) out.push({ role: "assistant", content });
      continue;
    }

    // role === 'user': either a real user message or tool results from a prior turn.
    const toolResults: Extract<ModelMessage, { role: "tool" }>["content"] = [];
    const userText: Extract<ModelMessage, { role: "user" }>["content"] = [];
    for (const p of parts) {
      if (isFunctionResponsePart(p)) {
        const queue = pendingByName.get(p.functionResponse.name);
        const id = queue?.shift() ?? synthesizeToolCallId(p.functionResponse.name, p.functionResponse.response, callIndex++);
        const raw = (p.functionResponse.response as { result?: unknown })?.result;
        const value = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
        toolResults.push({
          type: "tool-result",
          toolCallId: id,
          toolName: p.functionResponse.name,
          output: { type: "text", value },
        });
      } else if (isTextPart(p) && p.text.length > 0) {
        userText.push({ type: "text", text: p.text });
      }
    }
    if (toolResults.length > 0) out.push({ role: "tool", content: toolResults });
    if (userText.length > 0) out.push({ role: "user", content: userText });
  }

  return out;
}

/**
 * Convert AI SDK response messages (assistant + tool messages) back to the
 * persisted Gemini Content[] shape so storage stays compatible with the
 * existing conversation collection.
 */
export function fromResponseMessages(messages: ResponseMessage[]): StoredContent[] {
  const out: StoredContent[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      const parts: StoredPart[] = [];
      const content = m.content;
      if (typeof content === "string") {
        if (content.length > 0) parts.push({ text: content });
      } else {
        for (const c of content) {
          if (c.type === "text" && c.text.length > 0) {
            parts.push({ text: c.text });
          } else if (c.type === "tool-call") {
            parts.push({
              functionCall: {
                name: c.toolName,
                args: (c.input as Record<string, unknown>) ?? {},
              },
            });
          }
        }
      }
      if (parts.length > 0) out.push({ role: "model", parts });
    } else if (m.role === "tool") {
      const parts: StoredPart[] = [];
      for (const c of m.content) {
        if (c.type !== "tool-result") continue;
        const out_ = c.output;
        const raw =
          out_.type === "text" || out_.type === "error-text"
            ? out_.value
            : out_.type === "json" || out_.type === "error-json"
              ? JSON.stringify(out_.value)
              : "";
        parts.push({
          functionResponse: {
            name: c.toolName,
            response: { result: raw },
          },
        });
      }
      if (parts.length > 0) out.push({ role: "user", parts });
    }
  }
  return out;
}
