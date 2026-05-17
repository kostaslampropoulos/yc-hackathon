import type { ObjectId } from "mongodb";
import type { Content } from "@google/genai";

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
  // 2-5 short questions the receptionist should ask before booking an appointment.
  // Tailored to the business type (vet → "what kind of pet", plumber → "what's the issue", etc.).
  // Empty array if the business type doesn't need intake (e.g. quick takeout).
  intakeQuestions: string[];

  agentPhoneAgentId: string;
  agentPhoneNumberId: string;
  agentPhoneNumber: string;

  rawPlaceDetails: object;
  websiteMarkdown: string | null;

  createdAt: Date;
  updatedAt: Date;
};

export type BusinessForPrompt = Omit<
  Business,
  | "systemPrompt"
  | "serviceMenu"
  | "intakeQuestions"
  | "agentPhoneAgentId"
  | "agentPhoneNumberId"
  | "agentPhoneNumber"
  | "_id"
  | "createdAt"
  | "updatedAt"
>;

// Voice agent uses Gemini; messages stored in Gemini's native Content shape.
export type AgentMessage = Content;

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
  messages: AgentMessage[];
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
  // Answers to Business.intakeQuestions, keyed by the question text the agent asked.
  intakeAnswers?: Record<string, string>;
  createdAt: Date;
};
