import { connectDb } from "@/lib/db";
import { ProfileImage } from "@/lib/models";
import { fail, oid, serverError } from "@/lib/http";

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  try {
    const { userId } = await params;
    if (!oid(userId)) return fail("Photo not found", 404);
    await connectDb();
    const image = await ProfileImage.findById(userId);
    if (!image) return fail("Photo not found", 404);
    return new Response(new Uint8Array(image.data), {
      headers: {
        "Content-Type": "image/webp",
        "Cache-Control": "public, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return serverError(error);
  }
}
