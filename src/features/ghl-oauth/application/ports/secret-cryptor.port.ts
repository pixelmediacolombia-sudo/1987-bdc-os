export interface SecretCryptor {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}
