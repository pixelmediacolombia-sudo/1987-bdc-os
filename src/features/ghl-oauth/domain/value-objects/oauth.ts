export type OAuthStateClaims = {
  issuedAt: number;
  nonce: string;
  tenantId?: string;
};

export type GhlOAuthTokens = {
  accessToken: string;
  refreshToken?: string;
  locationId: string;
  scopes: string[];
  expiresAt?: Date;
};

export type GhlRefreshedTokens = {
  accessToken: string;
  refreshToken?: string;
  scopes: string[];
  expiresAt?: Date;
};
