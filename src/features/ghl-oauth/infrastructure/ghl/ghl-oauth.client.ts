import axios from "axios";
import type { GhlOAuthClient } from "@/features/ghl-oauth/application/ports/ghl-oauth-client.port";
import type { GhlOAuthTokens, GhlRefreshedTokens } from "@/features/ghl-oauth/domain/value-objects/oauth";
import type { AppConfig } from "@/features/ghl-oauth/infrastructure/config/env.config";

type GhlTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  locationId?: unknown;
  scope?: unknown;
  scopes?: unknown;
  expires_in?: unknown;
  expires_at?: unknown;
};

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`GHL response missing ${field}`);
  return value;
}

function scopesFrom(response: GhlTokenResponse): string[] {
  const raw = response.scopes ?? response.scope;
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  return typeof raw === "string" ? raw.split(/[\s,]+/).filter(Boolean) : [];
}

function expiresAtFrom(response: GhlTokenResponse): Date | undefined {
  if (typeof response.expires_at === "string" || typeof response.expires_at === "number") {
    const raw = typeof response.expires_at === "number" ? response.expires_at * 1000 : Date.parse(response.expires_at);
    if (Number.isFinite(raw)) return new Date(raw);
  }
  if (typeof response.expires_in === "number" && Number.isFinite(response.expires_in) && response.expires_in > 0) {
    return new Date(Date.now() + response.expires_in * 1000);
  }
  return undefined;
}

export class GhlOAuthClientAdapter implements GhlOAuthClient {
  constructor(private readonly config: AppConfig) {}

  createAuthorizationUrl(input: { state: string }): string {
    const url = new URL(this.config.ghlAuthorizationUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.ghlClientId,
      version_id: this.config.ghlAppVersionId,
      redirect_uri: this.config.ghlRedirectUri,
      scope: this.config.ghlScopes.join(" "),
      state: input.state,
    }).toString();
    return url.toString();
  }

  async exchangeCode(code: string): Promise<GhlOAuthTokens> {
    const response = await axios.post<GhlTokenResponse>(
      this.config.ghlTokenUrl,
      new URLSearchParams({
        client_id: this.config.ghlClientId,
        client_secret: this.config.ghlClientSecret,
        grant_type: "authorization_code",
        code,
        redirect_uri: this.config.ghlRedirectUri,
        user_type: "Location",
      }).toString(),
      {
        timeout: 15_000,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          Version: "2021-07-28",
        },
      },
    );

    return {
      accessToken: requiredString(response.data.access_token, "access_token"),
      refreshToken: typeof response.data.refresh_token === "string" ? response.data.refresh_token : undefined,
      locationId: requiredString(response.data.locationId, "locationId"),
      scopes: scopesFrom(response.data),
      expiresAt: expiresAtFrom(response.data),
    };
  }

  async refreshToken(refreshToken: string): Promise<GhlRefreshedTokens> {
    const response = await axios.post<GhlTokenResponse>(
      this.config.ghlTokenUrl,
      new URLSearchParams({
        client_id: this.config.ghlClientId,
        client_secret: this.config.ghlClientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        user_type: "Location",
      }).toString(),
      {
        timeout: 15_000,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
          Version: "2021-07-28",
        },
      },
    );

    return {
      accessToken: requiredString(response.data.access_token, "access_token"),
      refreshToken: typeof response.data.refresh_token === "string" ? response.data.refresh_token : undefined,
      scopes: scopesFrom(response.data),
      expiresAt: expiresAtFrom(response.data),
    };
  }
}
