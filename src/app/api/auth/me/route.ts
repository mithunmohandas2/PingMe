import { requireUser, safeUser } from "@/lib/auth";
import { User } from "@/lib/models";
import { fail, json, serverError } from "@/lib/http";
export async function GET(){try{const id=await requireUser();if(!id)return fail("Unauthorized",401);const u=await User.findById(id);return u?json({data:safeUser(u)}):fail("Unauthorized",401)}catch(e){return serverError(e)}}
