import sharp from "sharp";
import { requireUser, safeUser } from "@/lib/auth";
import { ProfileImage, User } from "@/lib/models";
import { fail, json, serverError } from "@/lib/http";
import { sameOrigin } from "@/lib/profile-validation";
import { notifyProfileUpdate } from "@/lib/profile-updates";

export const runtime = "nodejs";
export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return fail("Request not allowed", 403);
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    if (Number(req.headers.get("content-length")) > 2 * 1024 * 1024)
      return fail("Photo is too large", 413);
    const file = (await req.formData()).get("image");
    if (
      !(file instanceof File) ||
      !file.size ||
      file.size > 1024 * 1024 ||
      file.type !== "image/webp"
    )
      return fail("Upload a compressed WebP photo up to 1 MB");
    let data: Buffer;
    try {
      const image = sharp(Buffer.from(await file.arrayBuffer()), {
        limitInputPixels: 16_000_000,
      });
      if ((await image.metadata()).format !== "webp")
        return fail("Invalid WebP photo");
      data = await image
        .rotate()
        .resize(512, 512, { fit: "cover", withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer();
    } catch {
      return fail("This photo could not be read. Choose another image");
    }
    if (data.length > 256 * 1024)
      return fail("Photo is too detailed. Try a smaller image");
    await ProfileImage.findOneAndUpdate(
      { _id: id },
      { $set: { data } },
      { upsert: true },
    );
    const user = await User.findByIdAndUpdate(
      id,
      { $set: { image: `/api/users/${id}/avatar?v=${Date.now()}` } },
      { new: true },
    );
    if (user) await notifyProfileUpdate(id);
    return user ? json({ data: safeUser(user) }) : fail("User not found", 404);
  } catch (error) {
    return serverError(error);
  }
}
export async function DELETE(req: Request) {
  try {
    if (!sameOrigin(req)) return fail("Request not allowed", 403);
    const id = await requireUser();
    if (!id) return fail("Unauthorized", 401);
    await ProfileImage.deleteOne({ _id: id });
    const user = await User.findByIdAndUpdate(
      id,
      { $set: { image: "" } },
      { new: true },
    );
    if (user) await notifyProfileUpdate(id);
    return user ? json({ data: safeUser(user) }) : fail("User not found", 404);
  } catch (error) {
    return serverError(error);
  }
}
