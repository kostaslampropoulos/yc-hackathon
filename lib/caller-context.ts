import type { Db } from "mongodb";
import type { Business, Caller, Appointment } from "./types";
import { formatInBusinessTz } from "./dates";
import { recallCallerMemories } from "./supermemory";

export async function buildCallerContext(
  business: Business,
  caller: Caller,
  db: Db,
): Promise<string> {
  const [recent, memories] = await Promise.all([
    db
      .collection<Appointment>("appointments")
      .find({ callerId: caller._id, status: "booked" })
      .sort({ startTime: -1 })
      .limit(3)
      .toArray(),
    recallCallerMemories(business._id.toString(), caller.phone, caller.name || "greeting", 5).catch(
      () => [],
    ),
  ]);

  if (caller.callCount === 0 && !caller.name && memories.length === 0) {
    return "This is a first-time caller. Greet them warmly and ask their name when appropriate.";
  }

  const parts: string[] = [
    caller.callCount > 0 || caller.name ? "This is a returning caller." : "This is their first call.",
  ];
  if (caller.name) parts.push(`Name: ${caller.name}.`);
  if (caller.email) parts.push(`Email on file: ${caller.email}.`);
  if (caller.callbackPhone && caller.callbackPhone !== caller.phone) {
    parts.push(`Preferred callback number: ${caller.callbackPhone}.`);
  }
  if (caller.notes) parts.push(`Notes: ${caller.notes}.`);
  if (recent.length > 0) {
    parts.push("Recent appointments:");
    for (const a of recent) {
      parts.push(`- ${a.service} on ${formatInBusinessTz(a.startTime, business.timezone)}, status ${a.status}.`);
    }
  }
  if (memories.length > 0) {
    parts.push("Things you remember (from Supermemory — acknowledge naturally, don't list robotically):");
    for (const m of memories) {
      parts.push(`- ${m.text}`);
    }
  }
  parts.push("Greet them by name if you have it. Use their history as context.");
  return parts.join("\n");
}
