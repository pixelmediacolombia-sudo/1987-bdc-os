import { createHmac, timingSafeEqual } from "node:crypto";

export function isValidMetaWebhookSignature(rawBody: Buffer, signature: string, appSecret: string): boolean {
  if (!signature.startsWith("sha256=") || !appSecret) return false;
  const provided = Buffer.from(signature.slice("sha256=".length), "hex");
  const expected = createHmac("sha256", appSecret).update(rawBody).digest();
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
