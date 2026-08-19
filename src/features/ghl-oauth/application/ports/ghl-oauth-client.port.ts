import type { GhlOAuthTokens, GhlRefreshedTokens } from "@/features/ghl-oauth/domain/value-objects/oauth";

export type AuthorizationUrlInput = {
  state: string;
};

export interface GhlOAuthClient {
  createAuthorizationUrl(input: AuthorizationUrlInput): string;
  exchangeCode(code: string): Promise<GhlOAuthTokens>;
  refreshToken(refreshToken: string): Promise<GhlRefreshedTokens>;
}
