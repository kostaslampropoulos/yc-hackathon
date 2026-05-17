import { anthropic, CLAUDE_MODEL } from "./anthropic";
import { describeHoursForPrompt } from "./hours";
import type { BusinessForPrompt } from "./types";

export type PromptGenerationResult = {
  systemPrompt: string;
  serviceMenu: string[];
  intakeQuestions: string[];
};

export async function generateSystemPrompt(
  business: BusinessForPrompt,
  websiteMarkdown: string | null,
): Promise<PromptGenerationResult> {
  const hoursText = describeHoursForPrompt(business.hours);
  const reviewsText = business.topReviews
    .slice(0, 5)
    .map((r) => `- (${r.rating}/5) ${r.author}: ${r.text.slice(0, 400)}`)
    .join("\n");

  const websiteSection = websiteMarkdown
    ? `WEBSITE MARKDOWN (truncated):\n${websiteMarkdown.slice(0, 8000)}`
    : "WEBSITE MARKDOWN: (not available — base your prompt on Places data only)";

  const userContent = `Generate a receptionist system prompt, service menu, and booking intake questions for this business.

BUSINESS:
- Name: ${business.name}
- Type: ${business.primaryTypeDisplay} (raw: ${business.primaryType})
- All types: ${business.types.join(", ")}
- Address: ${business.address}
- Phone: ${business.phone ?? "unknown"}
- Website: ${business.website ?? "none"}
- Rating: ${business.rating ?? "n/a"} (${business.reviewCount ?? 0} reviews)
- Price level: ${business.priceLevel ?? "n/a"}
- Editorial summary: ${business.summary ?? "(none)"}

HOURS (timezone ${business.timezone}):
${hoursText}

TOP REVIEWS:
${reviewsText || "(none)"}

${websiteSection}

INSTRUCTIONS:
Return ONLY a single JSON object with this exact shape and no other text:
{
  "systemPrompt": "<400-700 words, see rules below>",
  "serviceMenu": ["<service 1>", "<service 2>", ...],
  "intakeQuestions": ["<question 1>", "<question 2>", ...]
}

systemPrompt rules:
1. Open: "You are the receptionist for ${business.name}, a ${business.primaryTypeDisplay} located at ${business.address}."
2. Include hours naturally ("We are open Monday through Friday from 9 AM to 6 PM...").
3. List services inferred from reviews + website + business type.
4. Calibrate tone to the business type (clinical for dental, warm for salon, brisk for pizza takeout).
5. Behavioral rules to embed verbatim:
   - Keep replies under 2 sentences for voice.
   - Never invent services or prices not in this prompt.
   - Spell back names and phone numbers to confirm.
   - Ask for a callback number if the caller is calling from a different one.
   - For requests outside the listed services, offer to take a message.
6. Mention these tools are available (no schemas needed): check_availability, book_appointment, lookup_caller, update_caller_info, transfer_to_human.
7. End with: "If the caller insists on speaking to a human, use the transfer_to_human tool."

serviceMenu rules:
- Array of 5-15 short strings.
- Each string is a concrete service (e.g. "Haircut", "Beard trim", "Color"), not a category.
- Infer from reviews, website, and business type. Be specific.

intakeQuestions rules:
- Array of 2-5 short questions a real receptionist for THIS business type would ask before booking.
- Tailor to the business — examples:
  - Vet: ["What kind of pet?", "What is the issue?", "How old is the pet?"]
  - Plumber: ["What's the issue?", "Where in the house?", "How urgent is it?"]
  - Dentist: ["Is this a checkup or a specific concern?", "Are you a current patient?", "When did you last visit?"]
  - Hair salon: ["What service?", "Hair length and color?", "Any allergies?"]
  - Restaurant reservation: ["How many people?", "Any dietary restrictions?", "Indoor or outdoor seating?"]
  - Quick takeout / retail / no-appointment business: return empty array []
- Each question is one sentence, plain conversational English, easy to answer on a voice call.
- Do NOT include obvious things already collected separately: caller name, phone number, date, time.
- Skip if the business doesn't take appointments at all (return []).`;

  const resp = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: userContent,
      },
    ],
  });

  let text = "";
  for (const block of resp.content) {
    if (block.type === "text") {
      text += block.text;
    }
  }

  const parsed = extractJson(text);
  if (!parsed || typeof parsed.systemPrompt !== "string" || !Array.isArray(parsed.serviceMenu)) {
    throw new Error(`Claude did not return valid JSON: ${text.slice(0, 500)}`);
  }

  const intakeQuestions = Array.isArray(parsed.intakeQuestions)
    ? parsed.intakeQuestions.filter((q: unknown): q is string => typeof q === "string" && q.trim().length > 0).slice(0, 5)
    : [];

  return {
    systemPrompt: parsed.systemPrompt,
    serviceMenu: parsed.serviceMenu.filter((s: unknown): s is string => typeof s === "string"),
    intakeQuestions,
  };
}

function extractJson(text: string): {
  systemPrompt: string;
  serviceMenu: string[];
  intakeQuestions?: string[];
} | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  for (let end = text.lastIndexOf("}"); end > start; end = text.lastIndexOf("}", end - 1)) {
    const candidate = text.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // keep trying
    }
  }
  return null;
}
