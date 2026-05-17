import { AgentMailClient } from "agentmail";

const apiKey = process.env.AGENTMAIL_API_KEY;
const domain = process.env.AGENTMAIL_DOMAIN || undefined;

let client: AgentMailClient | null = null;

function getClient(): AgentMailClient {
  if (!apiKey) throw new Error("AGENTMAIL_API_KEY is not set");
  if (!client) client = new AgentMailClient({ apiKey });
  return client;
}

export type CreatedInbox = {
  inboxId: string;
  emailAddress: string | null;
};

function slugForUsername(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32) || "reception";
}

export async function createBusinessInbox(input: {
  businessId: string;
  businessName: string;
}): Promise<CreatedInbox> {
  const c = getClient();
  const username = `${slugForUsername(input.businessName)}-${input.businessId.slice(-6)}`;
  const resp = await c.inboxes.create({
    username,
    domain,
    displayName: input.businessName,
    clientId: `business_${input.businessId}`,
  });
  const inbox = resp as unknown as { inboxId?: string; emailAddress?: string; address?: string };
  const inboxId = inbox.inboxId;
  if (!inboxId) throw new Error(`AgentMail inbox create: missing inboxId`);
  return {
    inboxId,
    emailAddress: inbox.emailAddress ?? inbox.address ?? null,
  };
}

export async function sendBookingConfirmation(input: {
  inboxId: string;
  to: string;
  businessName: string;
  customerName: string;
  service: string;
  startsAt: string;
  notes?: string;
  businessAddress?: string;
  businessPhone?: string | null;
}): Promise<{ messageId: string | null }> {
  const c = getClient();
  const subject = `Booking confirmed — ${input.service} at ${input.businessName}`;
  const lines = [
    `Hi ${input.customerName},`,
    ``,
    `Your appointment at ${input.businessName} is confirmed.`,
    ``,
    `Service: ${input.service}`,
    `When: ${input.startsAt}`,
    input.businessAddress ? `Where: ${input.businessAddress}` : null,
    input.businessPhone ? `Reschedule: ${input.businessPhone}` : null,
    input.notes ? `\nNotes: ${input.notes}` : null,
    ``,
    `— ${input.businessName}`,
  ].filter(Boolean) as string[];
  const text = lines.join("\n");
  const html = `<div style="font-family:system-ui,sans-serif;max-width:520px;line-height:1.5">
  <p>Hi ${escapeHtml(input.customerName)},</p>
  <p>Your appointment at <strong>${escapeHtml(input.businessName)}</strong> is confirmed.</p>
  <table style="border-collapse:collapse">
    <tr><td style="padding:4px 8px;color:#666">Service</td><td style="padding:4px 8px"><strong>${escapeHtml(input.service)}</strong></td></tr>
    <tr><td style="padding:4px 8px;color:#666">When</td><td style="padding:4px 8px"><strong>${escapeHtml(input.startsAt)}</strong></td></tr>
    ${input.businessAddress ? `<tr><td style="padding:4px 8px;color:#666">Where</td><td style="padding:4px 8px">${escapeHtml(input.businessAddress)}</td></tr>` : ""}
    ${input.businessPhone ? `<tr><td style="padding:4px 8px;color:#666">Reschedule</td><td style="padding:4px 8px">${escapeHtml(input.businessPhone)}</td></tr>` : ""}
  </table>
  ${input.notes ? `<p><em>${escapeHtml(input.notes)}</em></p>` : ""}
  <p>— ${escapeHtml(input.businessName)}</p>
</div>`;

  const resp = await c.inboxes.messages.send(input.inboxId, {
    to: input.to,
    subject,
    text,
    html,
  });
  const r = resp as unknown as { messageId?: string };
  return { messageId: r.messageId ?? null };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
