export async function compressImage(
  file: File,
  options?: {
    maxWidth?: number;
    quality?: number;
    outputFormat?: string;
    thresholdKB?: number;
  },
): Promise<File> {
  const {
    maxWidth = 1200,
    quality = 0.7,
    outputFormat = "image/webp",
    thresholdKB = 300,
  } = options || {};
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("Choose a JPEG, PNG or WebP photo");
  if (file.size > 12 * 1024 * 1024)
    throw new Error("Choose a photo smaller than 12 MB");
  if (outputFormat !== "image/webp")
    throw new Error("Profile photos must use WebP");
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxWidth / Math.max(bitmap.width, bitmap.height));
    // Small JPEG/PNG files must still be converted to WebP.
    if (
      scale === 1 &&
      file.type === outputFormat &&
      file.size <= thresholdKB * 1024
    )
      return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Your browser could not process this photo");
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (result) => {
          if (!result || result.type !== outputFormat)
            reject(new Error("Your browser could not create a WebP photo"));
          else resolve(result);
        },
        outputFormat,
        quality,
      ),
    );
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".webp", {
      type: outputFormat,
    });
  } finally {
    bitmap.close();
  }
}
