import { requireUser } from "@/lib/auth";
import { Chat, Message } from "@/lib/models";
import { fail, json, oid, serverError } from "@/lib/http";
export async function GET(_req:Request,{params}:{params:Promise<{chatId:string}>}){try{const id=await requireUser();if(!id)return fail("Unauthorized",401);const {chatId}=await params;if(!oid(chatId))return fail("Invalid chat");
 if(!(await Chat.exists({_id:chatId,users:id})))return fail("Chat not found",404);
 const messages=await Message.find({chat:chatId}).sort({createdAt:-1}).limit(200).populate("sender","name email image").lean();return json({data:messages.reverse()});
 }catch(e){return serverError(e)}}
