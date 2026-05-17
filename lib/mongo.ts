import { MongoClient, type Db, type Collection } from "mongodb";
import type { Business, Caller, Conversation, Appointment } from "./types";

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

export async function getBusinesses(): Promise<Collection<Business>> {
  const db = await getDb();
  const collection = db.collection<Business>("businesses");
  if (!indexesEnsured.businesses) {
    indexesEnsured.businesses = true;
    await Promise.all([
      collection.createIndex({ placeId: 1 }, { unique: true }),
      collection.createIndex({ ownerId: 1 }),
      collection.createIndex({ agentPhoneNumber: 1 }),
      collection.createIndex({ agentPhoneAgentId: 1 }),
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
    await collection
      .createIndex({ businessId: 1, phone: 1 }, { unique: true })
      .catch((err) => {
        console.warn("[mongo] callers index creation failed:", err);
        indexesEnsured.callers = false;
      });
  }
  return collection;
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
