import mongoose from "mongoose";
import { ensureMessageRetentionIndexes } from "./message-retention-indexes";
const uri = process.env.MONGODB_URI;
if (!uri) console.warn("MONGODB_URI is not configured");
const globalForDb = globalThis as typeof globalThis & {
  _mongoose?: Promise<typeof mongoose>;
};
export async function connectDb() {
  if (!process.env.MONGODB_URI) throw new Error("Database not configured");
  if (!globalForDb._mongoose)
    globalForDb._mongoose = mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 8000,
    });
  try {
    const connection = await globalForDb._mongoose;
    await ensureMessageRetentionIndexes();
    return connection;
  } catch (e) {
    globalForDb._mongoose = undefined;
    throw e;
  }
}
