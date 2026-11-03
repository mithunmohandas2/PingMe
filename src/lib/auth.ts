import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { connectDb } from "./db";
import { User } from "./models";
import mongoose from "mongoose";
export const cookieName = "pingme_session";
function secret() {
  const value = process.env.JWT_SECRET;
  if (!value || value.length < 32)
    throw new Error("JWT_SECRET must have at least 32 characters");
  return new TextEncoder().encode(value);
}
export function assertAuthConfigured() {
  secret();
}
export async function createToken(id: string, version = 0) {
  return new SignJWT({ sub: id, ver: version })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret());
}
async function decodeSession(token: string) {
  try {
    const { payload } = await jwtVerify(token, secret());
    return typeof payload.sub === "string" &&
      mongoose.isValidObjectId(payload.sub)
      ? {
          id: payload.sub,
          version: typeof payload.ver === "number" ? payload.ver : 0,
        }
      : null;
  } catch {
    return null;
  }
}
export async function decodeToken(token: string) {
  return (await decodeSession(token))?.id ?? null;
}
export async function currentUserId() {
  const jar = await cookies();
  const token = jar.get(cookieName)?.value;
  return token ? decodeToken(token) : null;
}
export async function requireUser() {
  const token = (await cookies()).get(cookieName)?.value;
  const session = token ? await decodeSession(token) : null;
  if (!session) return null;
  await connectDb();
  const version =
    session.version === 0
      ? { $or: [{ sessionVersion: 0 }, { sessionVersion: { $exists: false } }] }
      : { sessionVersion: session.version };
  return (await User.exists({ _id: session.id, ...version }))
    ? session.id
    : null;
}
export function setSession(res: NextResponse, token: string) {
  res.cookies.set(cookieName, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
}
export function safeUser(u: any) {
  return {
    _id: String(u._id),
    name: u.name,
    email: u.email,
    image: u.image || "",
    bio: u.bio || "",
  };
}
