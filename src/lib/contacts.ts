export type ContactUser = {
  _id: string;
  name: string;
  email: string;
  image?: string;
  bio?: string;
};
export function contactLink(origin: string, userId: string) {
  if (!/^[a-f\d]{24}$/i.test(userId)) throw new Error("Invalid contact ID");
  const url = new URL("/", origin);
  url.searchParams.set("connect", userId);
  return url.toString();
}
export function parseContactLink(value: string, origin: string): string | null {
  try {
    const url = new URL(value.trim(), origin);
    const id = url.searchParams.get("connect");
    return url.origin === new URL(origin).origin &&
      url.pathname === "/" &&
      id &&
      /^[a-f\d]{24}$/i.test(id)
      ? id.toLowerCase()
      : null;
  } catch {
    return null;
  }
}
