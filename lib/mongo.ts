import { MongoClient, type Db, type Collection } from "mongodb";
import type { Appointment, Business, Conversation } from "./types";

const dbName = process.env.MONGODB_DB_NAME || "receptionist";

declare global {
  var __mongoClientPromise: Promise<MongoClient> | undefined;
}

function getClientPromise(): Promise<MongoClient> {
  if (globalThis.__mongoClientPromise) return globalThis.__mongoClientPromise;
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not set");
  }
  const promise = new MongoClient(uri).connect();
  globalThis.__mongoClientPromise = promise;
  return promise;
}

export async function getDb(): Promise<Db> {
  const client = await getClientPromise();
  return client.db(dbName);
}

let businessIndexesEnsured = false;
let appointmentIndexesEnsured = false;
let conversationIndexesEnsured = false;

export async function getBusinesses(): Promise<Collection<Business>> {
  const db = await getDb();
  const collection = db.collection<Business>("businesses");
  if (!businessIndexesEnsured) {
    businessIndexesEnsured = true;
    await Promise.all([
      collection.createIndex({ placeId: 1 }, { unique: true }),
      collection.createIndex({ ownerId: 1 }),
      collection.createIndex({ agentPhoneNumber: 1 }),
      collection.createIndex({ agentPhoneAgentId: 1 }),
    ]).catch((err) => {
      console.warn("[mongo] business index creation failed:", err);
      businessIndexesEnsured = false;
    });
  }
  return collection;
}

export async function getAppointments(): Promise<Collection<Appointment>> {
  const db = await getDb();
  const collection = db.collection<Appointment>("appointments");
  if (!appointmentIndexesEnsured) {
    appointmentIndexesEnsured = true;
    await Promise.all([
      collection.createIndex({ businessId: 1, startsAt: 1 }),
      collection.createIndex({ businessId: 1, callerPhone: 1 }),
    ]).catch((err) => {
      console.warn("[mongo] appointment index creation failed:", err);
      appointmentIndexesEnsured = false;
    });
  }
  return collection;
}

export async function getConversations(): Promise<Collection<Conversation>> {
  const db = await getDb();
  const collection = db.collection<Conversation>("conversations");
  if (!conversationIndexesEnsured) {
    conversationIndexesEnsured = true;
    await Promise.all([
      collection.createIndex({ callId: 1 }, { unique: true }),
      collection.createIndex({ businessId: 1, startedAt: -1 }),
    ]).catch((err) => {
      console.warn("[mongo] conversation index creation failed:", err);
      conversationIndexesEnsured = false;
    });
  }
  return collection;
}
