import { z } from "zod";

export const profileSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  bio: z.string().trim().max(160).default(""),
  currentPassword: z.string().max(128).optional(),
});
export const passwordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z
    .string()
    .min(8)
    .max(128)
    .refine((value) => new TextEncoder().encode(value).length <= 72),
});
export function sameOrigin(req: Request) {
  const origin = req.headers.get("origin");
  return !origin || origin === new URL(req.url).origin;
}
