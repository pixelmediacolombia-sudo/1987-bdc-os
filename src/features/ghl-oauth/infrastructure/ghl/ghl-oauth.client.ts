import axios from "axios";
import type { GhlOAuthClient } from "@/features/ghl-oauth/application/ports/ghl-oauth-client.port";
import type { GhlOAuthTokens } from "@/features/ghl-oauth/domain/value-objects/oauth";
import type { AppConfig } from "@/features/ghl-oauth/infrastructure/config/env.config";

type GhlTokenResponse = {
  access_token?: unknown;
  refresh_token?: unknown;
  locationId?: unknown;
  scope?: unknown;
  scopes?: unknown;
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

export class GhlOAuthClientAdapter implements GhlOAuthClient {
  constructor(private readonly config: AppConfig) {}

  createAuthorizationUrl(input: { state: string }): string {
    const url = new URL(this.config.ghlAuthorizationUrl);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: this.config.ghlClientId,
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
    };
  }
}
