import { z } from "zod";
import bcrypt from "bcryptjs";
import { connectDb } from "@/lib/db";
import { User } from "@/lib/models";
import { createToken, safeUser, setSession } from "@/lib/auth";
import { body, fail, json, serverError } from "@/lib/http";
const schema = z.object({ email: z.email(), password: z.string() });
export async function POST(req: Request) {
  try {
    const p = schema.safeParse(await body(req));
    if (!p.success) return fail("Invalid credentials", 401);
    await connectDb();
    const u = await User.findOne({ email: p.data.email.trim().toLowerCase() });
    if (!u || !(await bcrypt.compare(p.data.password, u.password)))
      return fail("Invalid credentials", 401);
    const res = json({ data: safeUser(u) });
    setSession(res, await createToken(String(u._id), u.sessionVersion || 0));
    return res;
  } catch (e) {
    return serverError(e);
  }
}
