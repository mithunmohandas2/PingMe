import { NextResponse } from "next/server";
import mongoose from "mongoose";
export function json(data: unknown, status = 200) { return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } }); }
export function fail(message: string, status = 400) { return json({ message }, status); }
export function oid(id: unknown): id is string { return typeof id === "string" && mongoose.isValidObjectId(id); }
export async function body(req: Request) { try { return await req.json(); } catch { return null; } }
export function serverError(e: unknown) { console.error("PingMe API error", e); return fail("Unexpected server error", 500); }
