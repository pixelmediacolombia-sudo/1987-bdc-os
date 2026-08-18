import { createHmac, timingSafeEqual } from "node:crypto";
import type { OAuthStateService } from "@/features/ghl-oauth/application/ports/oauth-state.port";
import type { OAuthStateClaims } from "@/features/ghl-oauth/domain/value-objects/oauth";

const STATE_TTL_MS = 10 * 60 * 1000;

export class HmacOAuthStateService implements OAuthStateService {
  constructor(private readonly secret: string) {}

  create(claims: OAuthStateClaims): string {
    const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
    return `${encoded}.${this.sign(encoded)}`;
  }

  verify(state: string): OAuthStateClaims {
    const [encoded, signature] = state.split(".");
    if (!encoded || !signature) throw new Error("Invalid OAuth state");

    const expected = Buffer.from(this.sign(encoded), "base64url");
    const actual = Buffer.from(signature, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      throw new Error("Invalid OAuth state signature");
    }

    let claims: OAuthStateClaims;
    try {
      claims = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as OAuthStateClaims;
    } catch {
      throw new Error("Invalid OAuth state payload");
    }
    if (!claims.issuedAt || Date.now() - claims.issuedAt > STATE_TTL_MS) {
      throw new Error("Expired OAuth state");
    }
    return claims;
  }

  private sign(value: string): string {
    return createHmac("sha256", this.secret).update(value).digest("base64url");
  }
}
