import { requireUser } from "@/lib/auth";
import { Chat, Message } from "@/lib/models";
import { body, fail, json, oid, serverError } from "@/lib/http";
import { publishChatUpdate } from "@/lib/realtime";
export async function POST(req:Request){try{const id=await requireUser();if(!id)return fail("Unauthorized",401);const b=await body(req);
 if(!oid(b?.chatId)||typeof b?.content!=="string"||!b.content.trim()||b.content.trim().length>4000)return fail("Invalid message");
 const chat=await Chat.findOne({_id:b.chatId,users:id});if(!chat)return fail("Chat not found",404);
 const msg=await Message.create({sender:id,content:b.content.trim(),chat:chat._id});
 await Chat.updateOne({_id:chat._id},{$set:{latestMessage:msg._id}});await msg.populate("sender","name email image");
 await publishChatUpdate(String(chat._id),chat.users.map((u:unknown)=>String(u)));return json({data:msg},201);
 }catch(e){return serverError(e)}}
