import type { ObjectId } from "mongodb";
import type Anthropic from "@anthropic-ai/sdk";

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

export type AnthropicMessage = Anthropic.MessageParam;

export type Caller = {
  _id: ObjectId;
  businessId: ObjectId;
  phone: string;
  callbackPhone?: string;
  name?: string;
  email?: string;
  notes?: string;
  appointmentCount: number;
  callCount: number;
  lastCalledAt?: Date;
  createdAt: Date;
  updatedAt: Date;
};

export type TranscriptEntry = { role: "user" | "assistant"; text: string; ts: Date };

export type Conversation = {
  _id: ObjectId;
  callId: string;
  businessId: ObjectId;
  callerId: ObjectId;
  callerPhone: string;
  toNumber: string;
  messages: AnthropicMessage[];
  transcript: TranscriptEntry[];
  status: "active" | "ended";
  startedAt: Date;
  endedAt?: Date;
  summary?: string;
  userSentiment?: string;
  durationSeconds?: number;
  bookingMade?: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type Appointment = {
  _id: ObjectId;
  businessId: ObjectId;
  callerId: ObjectId;
  conversationId: ObjectId;
  callerName: string;
  callerPhone: string;
  callerEmail?: string;
  service: string;
  startTime: Date;
  endTime: Date;
  durationMinutes: number;
  status: "booked" | "cancelled";
  source: "voice";
  confirmationEmailMessageId?: string | null;
  createdAt: Date;
};
