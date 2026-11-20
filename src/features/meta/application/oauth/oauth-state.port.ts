export type OAuthStateClaims = {
  issuedAt: number;
  nonce: string;
  tenantId?: string;
};

export interface OAuthStateService {
  create(claims: OAuthStateClaims): string;
  verify(state: string): OAuthStateClaims;
}
