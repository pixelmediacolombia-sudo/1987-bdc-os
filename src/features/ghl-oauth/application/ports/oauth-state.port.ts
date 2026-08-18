import type { OAuthStateClaims } from "@/features/ghl-oauth/domain/value-objects/oauth";

export interface OAuthStateService {
  create(claims: OAuthStateClaims): string;
  verify(state: string): OAuthStateClaims;
}
