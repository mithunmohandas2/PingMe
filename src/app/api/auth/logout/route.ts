import { json } from "@/lib/http";
import { cookieName } from "@/lib/auth";
export async function POST(){const res=json({message:"Signed out"});res.cookies.set(cookieName,"",{path:"/",maxAge:0,httpOnly:true,secure:process.env.NODE_ENV==="production",sameSite:"lax"});return res}
