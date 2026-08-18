import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import type { SecretCryptor } from "@/features/ghl-oauth/application/ports/secret-cryptor.port";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const KEY_SALT = "1987-bdc-os:oauth-token-key:v1";

export class Aes256GcmTokenCryptor implements SecretCryptor {
  private readonly key: Buffer;

  constructor(encryptionSecret: string) {
    this.key = scryptSync(encryptionSecret, KEY_SALT, KEY_BYTES);
  }

  encrypt(plaintext: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return ["v1", iv.toString("base64url"), authTag.toString("base64url"), ciphertext.toString("base64url")].join(".");
  }

  decrypt(envelope: string): string {
    const [version, ivPart, tagPart, ciphertextPart] = envelope.split(".");
    if (version !== "v1" || !ivPart || !tagPart || !ciphertextPart) {
      throw new Error("Unsupported encrypted token format");
    }
    const decipher = createDecipheriv(ALGORITHM, this.key, Buffer.from(ivPart, "base64url"));
    decipher.setAuthTag(Buffer.from(tagPart, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
}
