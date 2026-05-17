import type { Db } from "mongodb";
import type { Business, Caller, Appointment } from "./types";
import { formatInBusinessTz } from "./dates";

export async function buildCallerContext(
  business: Business,
  caller: Caller,
  db: Db,
): Promise<string> {
  if (caller.callCount === 0 && !caller.name) {
    return "This is a first-time caller. Greet them warmly and ask their name when appropriate.";
  }

  const recent = await db
    .collection<Appointment>("appointments")
    .find({ callerId: caller._id, status: "booked" })
    .sort({ startTime: -1 })
    .limit(3)
    .toArray();

  const parts: string[] = ["This is a returning caller."];
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
  parts.push("Greet them by name. Use their history as context.");
  return parts.join("\n");
}
