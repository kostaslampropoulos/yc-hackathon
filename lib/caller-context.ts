import type { Db } from "mongodb";
import type { Business, Caller, Appointment } from "./types";
import { formatInBusinessTz } from "./dates";

function refOf(id: Appointment["_id"]): string {
  return id.toString().slice(-6).toUpperCase();
}

export async function buildCallerContext(
  business: Business,
  caller: Caller,
  db: Db,
): Promise<string> {
  if (caller.callCount === 0 && !caller.name) {
    return "This is a first-time caller. Greet them warmly and ask their name when appropriate.";
  }

  const now = new Date();
  const appointments = db.collection<Appointment>("appointments");
  const [upcoming, recent] = await Promise.all([
    appointments
      .find({ callerId: caller._id, status: "booked", startTime: { $gte: now } })
      .sort({ startTime: 1 })
      .limit(5)
      .toArray(),
    appointments
      .find({ callerId: caller._id, status: "booked", startTime: { $lt: now } })
      .sort({ startTime: -1 })
      .limit(2)
      .toArray(),
  ]);

  const parts: string[] = ["This is a returning caller."];
  if (caller.name) parts.push(`Name: ${caller.name}.`);
  if (caller.email) parts.push(`Email on file: ${caller.email}.`);
  if (caller.callbackPhone && caller.callbackPhone !== caller.phone) {
    parts.push(`Preferred callback number: ${caller.callbackPhone}.`);
  }
  if (caller.notes) parts.push(`Notes: ${caller.notes}.`);
  if (upcoming.length > 0) {
    parts.push("Upcoming appointments (quote the REF code when calling cancel_appointment or modify_appointment):");
    for (const a of upcoming) {
      parts.push(`- [REF: ${refOf(a._id)}] ${a.service} on ${formatInBusinessTz(a.startTime, business.timezone)}.`);
    }
  }
  if (recent.length > 0) {
    parts.push("Recent past appointments:");
    for (const a of recent) {
      parts.push(`- ${a.service} on ${formatInBusinessTz(a.startTime, business.timezone)}.`);
    }
  }
  parts.push("Greet them by name. Use their history as context.");
  return parts.join("\n");
}
