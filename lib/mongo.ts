import { MongoClient, type Db, type Collection } from "mongodb";
import type { Business } from "./types";

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
  if (process.env.NODE_ENV !== "production") {
    globalThis.__mongoClientPromise = promise;
  } else {
    globalThis.__mongoClientPromise = promise;
  }
  return promise;
}

export async function getDb(): Promise<Db> {
  const client = await getClientPromise();
  return client.db(dbName);
}

let indexesEnsured = false;

export async function getBusinesses(): Promise<Collection<Business>> {
  const db = await getDb();
  const collection = db.collection<Business>("businesses");
  if (!indexesEnsured) {
    indexesEnsured = true;
    await Promise.all([
      collection.createIndex({ placeId: 1 }, { unique: true }),
      collection.createIndex({ ownerId: 1 }),
    ]).catch((err) => {
      console.warn("[mongo] index creation failed (will retry next call):", err);
      indexesEnsured = false;
    });
  }
  return collection;
}
