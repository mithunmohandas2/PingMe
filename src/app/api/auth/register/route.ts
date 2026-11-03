import { z } from "zod";
import bcrypt from "bcryptjs";
import { connectDb } from "@/lib/db";
import { User } from "@/lib/models";
import {
  assertAuthConfigured,
  createToken,
  safeUser,
  setSession,
} from "@/lib/auth";
import { body, fail, json, serverError } from "@/lib/http";
const schema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  password: z.string().min(8).max(128),
});
export async function POST(req: Request) {
  try {
    const parsed = schema.safeParse(await body(req));
    if (!parsed.success)
      return fail(
        "Provide a valid name, email and password (minimum 8 characters)",
      );
    assertAuthConfigured();
    await connectDb();
    const { name, email, password } = parsed.data;
    if (await User.exists({ email }))
      return fail("Email is already registered", 409);
    const user = await User.create({
      name,
      email,
      password: await bcrypt.hash(password, 12),
    });
    const res = json({ data: safeUser(user) }, 201);
    setSession(res, await createToken(String(user._id)));
    return res;
  } catch (e: any) {
    if (e?.code === 11000) return fail("Email is already registered", 409);
    return serverError(e);
  }
}
