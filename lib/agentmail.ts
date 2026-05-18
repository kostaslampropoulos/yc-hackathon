const API_KEY = process.env.AGENTMAIL_API_KEY;
const BASE_URL = process.env.AGENTMAIL_BASE_URL || "https://api.agentmail.to/v0";

function requireKey(): string {
  if (!API_KEY) throw new Error("AGENTMAIL_API_KEY is not set");
  return API_KEY;
}

type AgentMailFetchOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

async function amFetch<T>(path: string, opts: AgentMailFetchOptions = {}): Promise<T> {
  const { method = "GET", body } = opts;
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${requireKey()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    next: { revalidate: 0 },
  });
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    throw new Error(`AgentMail ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
  }
  return parsed as T;
}

export type CreatedInbox = {
  inboxId: string;
  email: string;
};

export async function createInbox(input: {
  username?: string;
  domain?: string;
  displayName?: string;
  clientId?: string;
}): Promise<CreatedInbox> {
  const body: Record<string, unknown> = {};
  if (input.username) body.username = input.username;
  if (input.domain) body.domain = input.domain;
  if (input.displayName) body.display_name = input.displayName;
  if (input.clientId) body.client_id = input.clientId;

  const data = await amFetch<{
    inbox_id?: string;
    email?: string;
    [k: string]: unknown;
  }>("/inboxes", { method: "POST", body });

  if (!data.inbox_id || !data.email) {
    throw new Error(`AgentMail create inbox: missing inbox_id/email: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { inboxId: data.inbox_id, email: data.email };
}

export type RegisteredWebhook = {
  webhookId: string;
  signingSecret: string;
};

export async function registerWebhook(input: {
  url: string;
  eventTypes?: string[];
}): Promise<RegisteredWebhook> {
  const data = await amFetch<{
    webhook_id?: string;
    id?: string;
    signing_secret?: string;
    secret?: string;
    [k: string]: unknown;
  }>("/webhooks", {
    method: "POST",
    body: {
      url: input.url,
      event_types: input.eventTypes ?? ["message.received"],
    },
  });
  const webhookId = data.webhook_id || data.id;
  const signingSecret = data.signing_secret || data.secret;
  if (!webhookId || !signingSecret) {
    throw new Error(`AgentMail register webhook: missing id/secret: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { webhookId, signingSecret };
}

export async function replyToMessage(input: {
  inboxId: string;
  messageId: string;
  text: string;
  replyAll?: boolean;
}): Promise<{ messageId?: string; threadId?: string }> {
  const data = await amFetch<{ message_id?: string; thread_id?: string }>(
    `/inboxes/${encodeURIComponent(input.inboxId)}/messages/${encodeURIComponent(input.messageId)}/reply`,
    {
      method: "POST",
      body: {
        text: input.text,
        reply_all: input.replyAll ?? false,
      },
    },
  );
  return { messageId: data.message_id, threadId: data.thread_id };
}

/** Parse an RFC-5322 From header value like `"Sarah Smith <sarah@x.com>"`. */
export function parseFromHeader(from: string): { name: string | null; email: string | null } {
  if (!from) return { name: null, email: null };
  const trimmed = from.trim();
  const angle = trimmed.match(/^(.*?)<([^>]+)>\s*$/);
  if (angle) {
    const rawName = angle[1].trim().replace(/^"|"$/g, "").trim();
    return { name: rawName || null, email: angle[2].trim().toLowerCase() || null };
  }
  // No display name — bare email.
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
    return { name: null, email: trimmed.toLowerCase() };
  }
  return { name: null, email: null };
}
