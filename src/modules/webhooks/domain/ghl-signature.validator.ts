import { createHmac, timingSafeEqual } from "node:crypto";

export function isValidGhlSignature(rawBody: Buffer, receivedSignature: string, secret: string): boolean {
  const normalizedSignature = receivedSignature.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalizedSignature)) return false;

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const received = Buffer.from(normalizedSignature, "hex");
  return received.length === expected.length && timingSafeEqual(expected, received);
}
