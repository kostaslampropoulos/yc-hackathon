import Anthropic from "@anthropic-ai/sdk";

const apiKey = process.env.ANTHROPIC_API_KEY;

if (!apiKey) {
  throw new Error("ANTHROPIC_API_KEY is not set");
}

export const anthropic = new Anthropic({ apiKey });

// Sonnet for one-shot generation (prompt generation at provisioning).
// Haiku for the voice agent loop where every turn needs to be sub-second.
export const CLAUDE_MODEL = "claude-sonnet-4-5";
export const CLAUDE_VOICE_MODEL = "claude-haiku-4-5-20251001";
