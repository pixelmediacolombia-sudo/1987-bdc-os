export type MetaPageAsset = { id: string; name: string; accessToken: string; instagramBusinessId?: string };
export type MetaOAuthAssets = { pages: MetaPageAsset[]; whatsappPhoneNumberIds: string[]; grantedScopes: string[] };

type TokenResponse = { access_token?: unknown; token_type?: unknown; expires_in?: unknown };

export class MetaOAuthClient {
  constructor(
    private readonly appId: string,
    private readonly appSecret: string,
    private readonly redirectUri: string,
    private readonly baseUrl = "https://graph.facebook.com",
    private readonly apiVersion = "v27.0",
    private readonly authorizationBaseUrl = "https://www.facebook.com",
    private readonly request: typeof fetch = fetch,
  ) {}

  authorizationUrl(state: string, scopes: string[]): string {
    const url = new URL(`/${this.apiVersion}/dialog/oauth`, this.authorizationBaseUrl);
    url.searchParams.set("client_id", this.appId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    url.searchParams.set("scope", scopes.join(","));
    return url.toString();
  }

  async exchangeCode(code: string): Promise<{ accessToken: string; expiresIn?: number }> {
    const params = new URLSearchParams({
      client_id: this.appId,
      client_secret: this.appSecret,
      redirect_uri: this.redirectUri,
      code,
    });
    const response = await this.get<TokenResponse>(`/${this.apiVersion}/oauth/access_token?${params}`);
    if (typeof response.access_token !== "string" || !response.access_token) throw new Error("Meta OAuth token response is invalid");
    return { accessToken: response.access_token, ...(typeof response.expires_in === "number" ? { expiresIn: response.expires_in } : {}) };
  }

  async exchangeLongLivedToken(shortLivedToken: string): Promise<{ accessToken: string; expiresIn?: number }> {
    const params = new URLSearchParams({
      grant_type: "fb_exchange_token",
      client_id: this.appId,
      client_secret: this.appSecret,
      fb_exchange_token: shortLivedToken,
    });
    const response = await this.get<TokenResponse>(`/${this.apiVersion}/oauth/access_token?${params}`);
    if (typeof response.access_token !== "string" || !response.access_token) throw new Error("Meta long-lived token response is invalid");
    return { accessToken: response.access_token, ...(typeof response.expires_in === "number" ? { expiresIn: response.expires_in } : {}) };
  }

  async listAssets(userAccessToken: string): Promise<MetaOAuthAssets> {
    const [pageResponse, businessResponse, permissionResponse] = await Promise.all([
      this.get<{ data?: Array<{ id?: unknown; name?: unknown; access_token?: unknown; instagram_business_account?: { id?: unknown } }> }>(
        `/${this.apiVersion}/me/accounts?fields=id,name,access_token,instagram_business_account{id}&access_token=${encodeURIComponent(userAccessToken)}`,
      ),
      this.get<{ data?: Array<{ id?: unknown }> }>(`/${this.apiVersion}/me/businesses?fields=id&access_token=${encodeURIComponent(userAccessToken)}`),
      this.get<{ data?: Array<{ permission?: unknown; status?: unknown }> }>(`/${this.apiVersion}/me/permissions?access_token=${encodeURIComponent(userAccessToken)}`),
    ]);
    const pages: MetaPageAsset[] = (pageResponse.data ?? []).flatMap((page) => {
      if (typeof page.id !== "string" || typeof page.name !== "string" || typeof page.access_token !== "string") return [];
      return [{ id: page.id, name: page.name, accessToken: page.access_token,
        ...(typeof page.instagram_business_account?.id === "string" ? { instagramBusinessId: page.instagram_business_account.id } : {}) }];
    });
    const businessIds = (businessResponse.data ?? []).flatMap((business) => typeof business.id === "string" ? [business.id] : []);
    const phoneLists = await Promise.all(businessIds.map(async (businessId) => {
      const owned = await this.get<{ data?: Array<{ id?: unknown }> }>(
        `/${this.apiVersion}/${encodeURIComponent(businessId)}/owned_whatsapp_business_accounts?fields=id&access_token=${encodeURIComponent(userAccessToken)}`,
      );
      return Promise.all((owned.data ?? []).flatMap((account) => typeof account.id === "string" ? [account.id] : []).map(async (accountId) => {
        const phones = await this.get<{ data?: Array<{ id?: unknown }> }>(
          `/${this.apiVersion}/${encodeURIComponent(accountId)}/phone_numbers?fields=id&access_token=${encodeURIComponent(userAccessToken)}`,
        );
        return (phones.data ?? []).flatMap((phone) => typeof phone.id === "string" ? [phone.id] : []);
      }));
    }));
    const grantedScopes = (permissionResponse.data ?? []).flatMap((permission) =>
      permission.status === "granted" && typeof permission.permission === "string" ? [permission.permission] : []);
    return { pages, whatsappPhoneNumberIds: phoneLists.flat(2), grantedScopes };
  }

  private async get<T>(path: string): Promise<T> {
    let response: Response;
    try {
      response = await this.request(new URL(path, this.baseUrl), { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error("Meta Graph API request failed before a response was received");
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const message = payload && typeof payload === "object" ? (payload as { error?: { message?: unknown } }).error?.message : undefined;
      throw new Error(`Meta Graph API request rejected: ${typeof message === "string" ? message : `HTTP ${response.status}`}`);
    }
    if (!payload || typeof payload !== "object") throw new Error("Meta Graph API response is invalid");
    return payload as T;
  }
}
