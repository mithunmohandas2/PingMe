import mongoose from "mongoose";
const uri = process.env.MONGODB_URI;
if (!uri) console.warn("MONGODB_URI is not configured");
const globalForDb = globalThis as typeof globalThis & { _mongoose?: Promise<typeof mongoose> };
export async function connectDb() {
  if (!process.env.MONGODB_URI) throw new Error("Database not configured");
  if (!globalForDb._mongoose) globalForDb._mongoose = mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  try { return await globalForDb._mongoose; } catch (e) { globalForDb._mongoose = undefined; throw e; }
}
