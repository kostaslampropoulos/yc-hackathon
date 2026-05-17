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
