import mongoose, { Schema, models, model } from "mongoose";
const options = { timestamps: true };
const UserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 80 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String, required: true },
    image: { type: String, default: "" },
    bio: { type: String, default: "", maxlength: 160 },
    sessionVersion: { type: Number, default: 0 },
  },
  options,
);
const ChatSchema = new Schema(
  {
    chatName: { type: String, trim: true, maxlength: 100 },
    isGroup: { type: Boolean, default: false },
    users: [{ type: Schema.Types.ObjectId, ref: "User" }],
    latestMessage: { type: Schema.Types.ObjectId, ref: "Message" },
    groupAdmin: { type: Schema.Types.ObjectId, ref: "User" },
  },
  options,
);
const MessageSchema = new Schema(
  {
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, trim: true, required: true, maxlength: 4000 },
    chat: { type: Schema.Types.ObjectId, ref: "Chat", required: true },
  },
  options,
);
MessageSchema.index({ chat: 1, createdAt: -1 });
// Extend an already-cached development model when these fields are added by HMR.
if (models.User && !models.User.schema.path("sessionVersion")) {
  models.User.schema.add({
    bio: { type: String, default: "", maxlength: 160 },
    sessionVersion: { type: Number, default: 0 },
  });
}
export const User = models.User || model("User", UserSchema);
export const ProfileImage =
  models.ProfileImage ||
  model(
    "ProfileImage",
    new Schema(
      {
        _id: { type: Schema.Types.ObjectId, required: true },
        data: { type: Buffer, required: true },
      },
      options,
    ),
  );
export const Chat = models.Chat || model("Chat", ChatSchema);
export const Message = models.Message || model("Message", MessageSchema);
export const publicUser = "_id name email image";
