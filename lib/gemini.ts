import { GoogleGenAI, type Content, type FunctionDeclaration, type Part } from "@google/genai";
import type Anthropic from "@anthropic-ai/sdk";
import { TOOL_DEFINITIONS } from "./tools";

const apiKey = process.env.GEMINI_API_KEY;

let client: GoogleGenAI | null = null;

export function getGemini(): GoogleGenAI {
  if (client) return client;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  client = new GoogleGenAI({ apiKey });
  return client;
}

export const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

/**
 * Convert our Anthropic-style tool definitions to Gemini FunctionDeclaration[].
 * Our tools already use JSON Schema for input_schema, so we use `parametersJsonSchema`.
 */
export function getGeminiTools(): FunctionDeclaration[] {
  return TOOL_DEFINITIONS.map((t) => ({
    name: t.name,
    description: t.description,
    parametersJsonSchema: t.input_schema,
  }));
}

/**
 * Storage type for conversation messages. Gemini native — Content[].
 */
export type StoredMessage = Content;

/**
 * If the conversation was previously stored in Anthropic's MessageParam format,
 * convert it to Gemini Content[]. Best-effort; if shapes are unknown, returns [].
 */
export function toGeminiMessages(messages: unknown[]): Content[] {
  if (!Array.isArray(messages)) return [];
  const out: Content[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    // Already Gemini shape.
    if ("parts" in m && Array.isArray((m as Content).parts)) {
      const role = (m as Content).role;
      out.push({
        role: role === "model" ? "model" : "user",
        parts: (m as Content).parts,
      });
      continue;
    }
    // Anthropic MessageParam shape: { role: "user" | "assistant", content: string | block[] }
    if ("role" in m && "content" in m) {
      const a = m as Anthropic.MessageParam;
      const role = a.role === "assistant" ? "model" : "user";
      const parts: Part[] = [];
      if (typeof a.content === "string") {
        parts.push({ text: a.content });
      } else if (Array.isArray(a.content)) {
        for (const block of a.content) {
          if (!block || typeof block !== "object") continue;
          if (block.type === "text") {
            parts.push({ text: block.text });
          } else if (block.type === "tool_use") {
            parts.push({
              functionCall: {
                name: block.name,
                args: (block.input as Record<string, unknown>) ?? {},
              },
            });
          } else if (block.type === "tool_result") {
            const content = typeof block.content === "string" ? block.content : JSON.stringify(block.content ?? "");
            parts.push({
              functionResponse: {
                // Tool name is lost in tool_result; use a placeholder.
                name: "unknown_tool",
                response: { result: content },
              },
            });
          }
        }
      }
      if (parts.length > 0) out.push({ role, parts });
    }
  }
  return out;
}
