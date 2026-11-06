import mongoose, { Schema, models, model } from "mongoose";
import { DELETED_MESSAGE_RETENTION_SECONDS } from "./message-retention";
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
    deletedAt: { type: Date, default: null },
    accountPurgeAt: { type: Date, default: null },
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
    blockedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
    accountPurgeAt: { type: Date, default: null },
  },
  options,
);
const MessageSchema = new Schema(
  {
    sender: { type: Schema.Types.ObjectId, ref: "User", required: true },
    content: { type: String, trim: true, required: true, maxlength: 4000 },
    kind: {
      type: String,
      enum: ["text", "image", "group-rename"],
      default: "text",
    },
    imageExpiresAt: { type: Date, default: null },
    accountPurgeAt: { type: Date, default: null },
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    chat: { type: Schema.Types.ObjectId, ref: "Chat", required: true },
  },
  options,
);
UserSchema.index({ accountPurgeAt: 1 }, { expireAfterSeconds: 0 });
ChatSchema.index({ accountPurgeAt: 1 }, { expireAfterSeconds: 0 });
MessageSchema.index({ accountPurgeAt: 1 }, { expireAfterSeconds: 0 });
MessageSchema.index({ chat: 1, createdAt: -1 });
MessageSchema.index(
  { deletedAt: 1 },
  { expireAfterSeconds: DELETED_MESSAGE_RETENTION_SECONDS },
);
MessageSchema.index(
  { imageExpiresAt: 1 },
  { expireAfterSeconds: DELETED_MESSAGE_RETENTION_SECONDS },
);
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
if (models.Message) {
  for (const field of ["editedAt", "deletedAt"]) {
    if (!models.Message.schema.path(field))
      models.Message.schema.add({ [field]: { type: Date, default: null } });
  }
}
export const Message = models.Message || model("Message", MessageSchema);
if (models.Message) {
  if (!models.Message.schema.path("kind"))
    models.Message.schema.add({
      kind: {
        type: String,
        enum: ["text", "image", "group-rename"],
        default: "text",
      },
    });
  if (!models.Message.schema.path("imageExpiresAt"))
    models.Message.schema.add({
      imageExpiresAt: { type: Date, default: null },
    });
}
const ChatImageSchema = new Schema({
  _id: { type: Schema.Types.ObjectId, required: true },
  data: { type: Buffer, required: true },
  expiresAt: { type: Date, required: true },
});
ChatImageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
export const ChatImage =
  models.ChatImage || model("ChatImage", ChatImageSchema);
for (const name of ["User", "Chat", "Message"]) {
  if (models[name] && !models[name].schema.path("accountPurgeAt"))
    models[name].schema.add({ accountPurgeAt: { type: Date, default: null } });
}
if (models.User && !models.User.schema.path("deletedAt"))
  models.User.schema.add({ deletedAt: { type: Date, default: null } });
export const publicUser = "_id name email image deletedAt";

const ChatPreferenceSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "User", required: true },
    chat: { type: Schema.Types.ObjectId, ref: "Chat", required: true },
    clearedAt: { type: Date, default: null },
    accountPurgeAt: { type: Date, default: null },
  },
  options,
);
ChatPreferenceSchema.index({ user: 1, chat: 1 }, { unique: true });
ChatPreferenceSchema.index({ accountPurgeAt: 1 }, { expireAfterSeconds: 0 });
export const ChatPreference =
  models.ChatPreference || model("ChatPreference", ChatPreferenceSchema);
const UserBlockSchema = new Schema(
  {
    blocker: { type: Schema.Types.ObjectId, ref: "User", required: true },
    blocked: { type: Schema.Types.ObjectId, ref: "User", required: true },
  },
  options,
);
UserBlockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
UserBlockSchema.index({ blocked: 1 });
export const UserBlock =
  models.UserBlock || model("UserBlock", UserBlockSchema);
if (models.Chat && !models.Chat.schema.path("blockedBy"))
  models.Chat.schema.add({
    blockedBy: [{ type: Schema.Types.ObjectId, ref: "User" }],
  });

const messageKindPath = models.Message?.schema.path("kind") as
  | (mongoose.Schema.Types.String & { enumValues: string[] })
  | undefined;
if (messageKindPath && !messageKindPath.enumValues.includes("group-rename"))
  messageKindPath.enum("group-rename");
