import { requireUser } from "@/lib/auth";
import { User } from "@/lib/models";
import { fail, json, serverError } from "@/lib/http";
export async function GET(req: Request){try{const id=await requireUser();if(!id)return fail("Unauthorized",401);
 const q=(new URL(req.url).searchParams.get("search")||"").trim().slice(0,80);
 if(!q)return json({data:[]});const safe=q.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
 const data=await User.find({ _id:{$ne:id},$or:[{name:{$regex:"^"+safe,$options:"i"}},{email:{$regex:"^"+safe,$options:"i"}}]}).select("_id name email image").limit(30).lean();return json({data});
 }catch(e){return serverError(e)}}
