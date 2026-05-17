import type { ObjectId } from "mongodb";

export type DayHours = Array<{ open: string; close: string }>;

export type WeekHours = {
  monday: DayHours;
  tuesday: DayHours;
  wednesday: DayHours;
  thursday: DayHours;
  friday: DayHours;
  saturday: DayHours;
  sunday: DayHours;
};

export type TopReview = { author: string; rating: number; text: string };

export type EnrichedService = {
  name: string;
  priceUsd: number | null;
  durationMinutes: number | null;
};

export type Enrichment = {
  status: "pending" | "running" | "succeeded" | "failed";
  services?: EnrichedService[];
  bookingUrl?: string | null;
  bookingProvider?: string | null;
  notes?: string | null;
  error?: string;
  startedAt?: Date;
  finishedAt?: Date;
};

export type Business = {
  _id: ObjectId;
  ownerId: string;

  placeId: string;
  mapsUrl: string;
  name: string;
  address: string;
  phone: string | null;
  website: string | null;

  primaryType: string;
  primaryTypeDisplay: string;
  types: string[];

  hours: WeekHours | null;
  timezone: string;

  rating: number | null;
  reviewCount: number | null;
  priceLevel: string | null;
  summary: string | null;
  topReviews: TopReview[];

  systemPrompt: string;
  serviceMenu: string[];

  agentPhoneAgentId: string;
  agentPhoneNumberId: string;
  agentPhoneNumber: string;

  agentMailInboxId?: string;
  agentMailAddress?: string | null;

  spongeAgentId?: string;
  spongeAgentApiKey?: string;
  spongeBaseAddress?: string | null;
  spongeSolanaAddress?: string | null;
  pendingBillUsd?: number;
  totalCallsCount?: number;

  enrichment?: Enrichment;

  rawPlaceDetails: object;
  websiteMarkdown: string | null;

  createdAt: Date;
  updatedAt: Date;
};

export type Appointment = {
  _id: ObjectId;
  businessId: ObjectId;
  callerPhone: string;
  customerName: string;
  customerEmail: string | null;
  service: string;
  startsAt: Date;
  endsAt?: Date | null;
  notes?: string | null;
  source: "voice" | "web" | "manual";
  callId?: string | null;
  confirmationEmailMessageId?: string | null;
  createdAt: Date;
};

export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
  ts: Date;
};

export type Conversation = {
  _id: ObjectId;
  businessId: ObjectId;
  callId: string;
  callerPhone: string | null;
  turns: ConversationTurn[];
  startedAt: Date;
  updatedAt: Date;
  endedAt?: Date | null;
};

export type BusinessForPrompt = Omit<
  Business,
  | "systemPrompt"
  | "serviceMenu"
  | "agentPhoneAgentId"
  | "agentPhoneNumberId"
  | "agentPhoneNumber"
  | "_id"
  | "createdAt"
  | "updatedAt"
>;
