import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const PARAMETERS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashScryptPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, 64, PARAMETERS, (error, key) => {
      if (error) reject(error);
      else resolve(key as Buffer);
    });
  });
  return `scrypt$32768$8$1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyScryptPassword(password: string, encodedHash: string): Promise<boolean> {
  const parts = encodedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== "32768" || parts[2] !== "8" || parts[3] !== "1") {
    return false;
  }

  try {
    const salt = Buffer.from(parts[4]!, "base64url");
    const expected = Buffer.from(parts[5]!, "base64url");
    if (salt.length < 16 || expected.length !== 64) return false;
    const actual = await new Promise<Buffer>((resolve, reject) => {
      scryptCallback(password, salt, expected.length, PARAMETERS, (error, derived) => {
        if (error) reject(error);
        else resolve(derived as Buffer);
      });
    });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
