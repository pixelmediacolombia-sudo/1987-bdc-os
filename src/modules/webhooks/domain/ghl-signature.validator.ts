import { createVerify, verify as verifyEd25519 } from "node:crypto";

export const GHL_ED25519_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAi2HR1srL4o18O8BRa7gVJY7G7bupbN3H9AwJrHCDiOg=
-----END PUBLIC KEY-----`;

export const GHL_LEGACY_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEAokvo/r9tVgcfZ5DysOSC
Frm602qYV0MaAiNnX9O8KxMbiyRKWeL9JpCpVpt4XHIcBOK4u3cLSqJGOLaPuXw6
dO0t6Q/ZVdAV5Phz+ZtzPL16iCGeK9po6D6JHBpbi989mmzMryUnQJezlYJ3DVfB
csedpinheNnyYeFXolrJvcsjDtfAeRx5ByHQmTnSdFUzuAnC9/GepgLT9SM4nCpv
uxmZMxrJt5Rw+VUaQ9B8JSvbMPpez4peKaJPZHBbU3OdeCVx5klVXXZQGNHOs8gF
3kvoV5rTnXV0IknLBXlcKKAQLZcY/Q9rG6Ifi9c+5vqlvHPCUJFT5XUGG5RKgOKU
J062fRtN+rLYZUV+BjafxQauvC8wSWeYja63VSUruvmNj8xkx2zE/Juc+yjLjTXp
IocmaiFeAO6fUtNjDeFVkhf5LNb59vECyrHD2SQIrhgXpO4Q3dVNA5rw576PwTzN
h/AMfHKIjE4xQA1SZuYJmNnmVZLIZBlQAF9Ntd03rfadZ+yDiOXCCs9FkHibELhC
HULgCsnuDJHcrGNd5/Ddm5hxGQ0ASitgHeMZ0kcIOwKDOzOU53lDza6/Y09T7sYJ
PQe7z0cvj7aE4B+Ax1ZoZGPzpJlZtGXCsu9aTEGEnKzmsFqwcSsnw3JB31IGKAyk
T1hhTiaCeIY/OwwwNUY2yvcCAwEAAQ==
-----END PUBLIC KEY-----`;

function decodeBase64Signature(value: string): Buffer | undefined {
  const normalized = value.trim();
  if (!normalized || normalized === "N/A" || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return undefined;
  try {
    const decoded = Buffer.from(normalized, "base64");
    return decoded.length > 0 ? decoded : undefined;
  } catch {
    return undefined;
  }
}

export function isValidGhlSignature(
  rawBody: Buffer,
  receivedSignature: string,
  header: "x-ghl-signature" | "x-wh-signature",
  keys: { ed25519PublicKey: string; legacyRsaPublicKey: string },
): boolean {
  const signature = decodeBase64Signature(receivedSignature);
  if (!signature) return false;

  try {
    if (header === "x-ghl-signature") {
      return verifyEd25519(null, rawBody, keys.ed25519PublicKey, signature);
    }

    const verifier = createVerify("SHA256");
    verifier.update(rawBody);
    verifier.end();
    return verifier.verify(keys.legacyRsaPublicKey, signature);
  } catch {
    return false;
  }
}
