import { Message, Chat, User } from "./models";
import { DELETED_MESSAGE_RETENTION_SECONDS } from "./message-retention";
const state = globalThis as typeof globalThis & {
  _messageRetentionIndexesV2?: Promise<void>;
};
export async function ensureMessageRetentionIndexes() {
  if (!state._messageRetentionIndexesV2) {
    state._messageRetentionIndexesV2 = (async () => {
      for (const model of [Message, Chat, User])
        await model.collection.createIndex(
          { accountPurgeAt: 1 },
          { expireAfterSeconds: 0 },
        );
      await Message.collection.createIndex(
        { deletedAt: 1 },
        { expireAfterSeconds: DELETED_MESSAGE_RETENTION_SECONDS },
      );
      await Message.collection.createIndex(
        { imageExpiresAt: 1 },
        { expireAfterSeconds: DELETED_MESSAGE_RETENTION_SECONDS },
      );
    })().catch((error) => {
      state._messageRetentionIndexesV2 = undefined;
      throw error;
    });
  }
  await state._messageRetentionIndexesV2;
}
