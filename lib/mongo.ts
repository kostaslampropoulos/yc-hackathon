import { MongoClient, type Db, type Collection } from "mongodb";
import type { Business, Caller, Conversation, Appointment } from "./types";

export type AppConfigDoc = {
  _id: string;
  value: string;
  updatedAt: Date;
};

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

const indexesEnsured = {
  businesses: false,
  callers: false,
  conversations: false,
  appointments: false,
};

// Simple in-process cache for `app_config` lookups so the webhook hot-path
// doesn't hit Mongo on every inbound message.
const appConfigCache = new Map<string, string>();

export async function getBusinesses(): Promise<Collection<Business>> {
  const db = await getDb();
  const collection = db.collection<Business>("businesses");
  if (!indexesEnsured.businesses) {
    indexesEnsured.businesses = true;
    await Promise.all([
      collection.createIndex({ placeId: 1 }, { unique: true }),
      collection.createIndex({ ownerId: 1 }),
    ]).catch((err) => {
      console.warn("[mongo] businesses index creation failed:", err);
      indexesEnsured.businesses = false;
    });
  }
  return collection;
}

export async function getCallers(): Promise<Collection<Caller>> {
  const db = await getDb();
  const collection = db.collection<Caller>("callers");
  if (!indexesEnsured.callers) {
    indexesEnsured.callers = true;
    await Promise.all([
      // Sparse so email-only callers (no phone yet) don't collide on null.
      collection.createIndex({ businessId: 1, phone: 1 }, { unique: true, sparse: true }),
      // Email-channel callers are looked up by (businessId, email).
      collection.createIndex({ businessId: 1, email: 1 }, { unique: true, sparse: true }),
    ]).catch((err) => {
      console.warn("[mongo] callers index creation failed:", err);
      indexesEnsured.callers = false;
    });
  }
  return collection;
}

export async function getAppConfig(): Promise<Collection<AppConfigDoc>> {
  const db = await getDb();
  return db.collection<AppConfigDoc>("app_config");
}

export async function getAppConfigValue(key: string): Promise<string | null> {
  const cached = appConfigCache.get(key);
  if (cached !== undefined) return cached;
  const col = await getAppConfig();
  const doc = await col.findOne({ _id: key });
  if (doc?.value) {
    appConfigCache.set(key, doc.value);
    return doc.value;
  }
  return null;
}

export async function setAppConfigValue(key: string, value: string): Promise<void> {
  const col = await getAppConfig();
  await col.updateOne(
    { _id: key },
    { $set: { value, updatedAt: new Date() } },
    { upsert: true },
  );
  appConfigCache.set(key, value);
}

export async function getConversations(): Promise<Collection<Conversation>> {
  const db = await getDb();
  const collection = db.collection<Conversation>("conversations");
  if (!indexesEnsured.conversations) {
    indexesEnsured.conversations = true;
    await Promise.all([
      collection.createIndex({ callId: 1 }, { unique: true }),
      collection.createIndex({ businessId: 1, startedAt: -1 }),
    ]).catch((err) => {
      console.warn("[mongo] conversations index creation failed:", err);
      indexesEnsured.conversations = false;
    });
  }
  return collection;
}

export async function getAppointments(): Promise<Collection<Appointment>> {
  const db = await getDb();
  const collection = db.collection<Appointment>("appointments");
  if (!indexesEnsured.appointments) {
    indexesEnsured.appointments = true;
    await Promise.all([
      collection.createIndex({ businessId: 1, startTime: 1 }),
      collection.createIndex({ callerId: 1, startTime: 1 }),
    ]).catch((err) => {
      console.warn("[mongo] appointments index creation failed:", err);
      indexesEnsured.appointments = false;
    });
  }
  return collection;
}
