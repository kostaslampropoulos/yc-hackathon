const API_KEY = process.env.AGENTPHONE_API_KEY;
const BASE_URL = process.env.AGENTPHONE_BASE_URL || "https://api.agentphone.to/v1";

function requireKey(): string {
  if (!API_KEY) throw new Error("AGENTPHONE_API_KEY is not set");
  return API_KEY;
}

type AgentPhoneFetchOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
};

async function apFetch<T>(path: string, opts: AgentPhoneFetchOptions = {}): Promise<T> {
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
    throw new Error(`AgentPhone ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
  }
  return parsed as T;
}

// Voice id default. Must match an id from GET /v1/agents/voices.
// "openai-Nova" is American female, widely deployable.
const DEFAULT_VOICE_ID = process.env.AGENTPHONE_DEFAULT_VOICE || "openai-Nova";

export type AgentPhoneAgentResponse = {
  id: string;
  [k: string]: unknown;
};

export type AgentPhoneNumberResponse = {
  id: string;
  phoneNumber?: string;
  phone_number?: string;
  number?: string;
  [k: string]: unknown;
};

export async function createAgent(input: {
  name: string;
  transferNumber: string | null;
  voice?: string;
  systemPrompt?: string;
  webhookUrl?: string;
  beginMessage?: string;
}): Promise<{ id: string }> {
  const body: Record<string, unknown> = {
    name: input.name,
    voice: input.voice ?? DEFAULT_VOICE_ID,
  };
  if (input.transferNumber) {
    body.transferNumber = input.transferNumber;
    body.transfer_number = input.transferNumber;
  }
  if (input.systemPrompt) {
    body.systemPrompt = input.systemPrompt;
    body.system_prompt = input.systemPrompt;
    body.instructions = input.systemPrompt;
  }
  if (input.webhookUrl) {
    body.webhookUrl = input.webhookUrl;
    body.webhook_url = input.webhookUrl;
  }
  if (input.beginMessage) {
    body.beginMessage = input.beginMessage;
    body.begin_message = input.beginMessage;
  }

  const data = await apFetch<AgentPhoneAgentResponse>("/agents", {
    method: "POST",
    body,
  });
  if (!data.id) throw new Error(`AgentPhone agent create: missing id in response: ${JSON.stringify(data).slice(0, 300)}`);
  return { id: data.id };
}

export async function updateAgent(
  agentId: string,
  patch: {
    voice?: string;
    beginMessage?: string;
    systemPrompt?: string;
    transferNumber?: string | null;
  },
): Promise<AgentPhoneAgentResponse> {
  const body: Record<string, unknown> = {};
  if (patch.voice !== undefined) body.voice = patch.voice;
  if (patch.beginMessage !== undefined) {
    body.beginMessage = patch.beginMessage;
    body.begin_message = patch.beginMessage;
  }
  if (patch.systemPrompt !== undefined) {
    body.systemPrompt = patch.systemPrompt;
    body.system_prompt = patch.systemPrompt;
    body.instructions = patch.systemPrompt;
  }
  if (patch.transferNumber !== undefined) {
    body.transferNumber = patch.transferNumber;
    body.transfer_number = patch.transferNumber;
  }
  return apFetch<AgentPhoneAgentResponse>(`/agents/${agentId}`, {
    method: "PATCH",
    body,
  });
}

export async function provisionNumber(input: { country: "US" | "CA" }): Promise<{ id: string; phoneNumber: string }> {
  const data = await apFetch<AgentPhoneNumberResponse>("/numbers", {
    method: "POST",
    body: { country: input.country },
  });

  const id = data.id;
  const phoneNumber = data.phoneNumber || data.phone_number || data.number;
  if (!id || !phoneNumber) {
    throw new Error(`AgentPhone provision number: missing id/phoneNumber: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return { id, phoneNumber };
}

export async function attachNumberToAgent(agentId: string, numberId: string): Promise<void> {
  // The docs commonly expose either:
  //   POST /agents/{id}/numbers with { numberId } body
  //   POST /agents/{id}/numbers/{numberId}
  //   PATCH /numbers/{numberId} with { agentId }
  // We try them in order until one succeeds.
  const attempts: Array<{ path: string; method: "POST" | "PATCH"; body?: unknown }> = [
    { path: `/agents/${agentId}/numbers`, method: "POST", body: { numberId } },
    { path: `/agents/${agentId}/numbers/${numberId}`, method: "POST" },
    { path: `/numbers/${numberId}`, method: "PATCH", body: { agentId } },
  ];

  let lastError: unknown = null;
  for (const a of attempts) {
    try {
      await apFetch<unknown>(a.path, { method: a.method, body: a.body });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`AgentPhone attachNumberToAgent failed: ${(lastError as Error)?.message ?? "unknown"}`);
}

export async function deleteAgent(agentId: string): Promise<void> {
  try {
    await apFetch<unknown>(`/agents/${agentId}`, { method: "DELETE" });
  } catch (err) {
    console.error(`[agentphone] deleteAgent failed for ${agentId}:`, err);
  }
}

export async function listVoices(): Promise<unknown> {
  return apFetch<unknown>("/agents/voices", { method: "GET" });
}
