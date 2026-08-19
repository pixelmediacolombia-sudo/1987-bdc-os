import type { GhlOAuthClient } from "@/features/ghl-oauth/application/ports/ghl-oauth-client.port";
import type {
  TenantIntegrationRepository,
  UpdateGhlTokensInput,
} from "@/features/ghl-oauth/application/ports/tenant-integration-repository.port";
import type { SecretCryptor } from "@/features/ghl-oauth/application/ports/secret-cryptor.port";

const REFRESH_WINDOW_MS = 5 * 60 * 1000;

export class GhlTokenRefreshUseCase {
  private readonly refreshes = new Map<string, Promise<string>>();

  constructor(
    private readonly oauthClient: GhlOAuthClient,
    private readonly repository: TenantIntegrationRepository,
    private readonly cryptor: SecretCryptor,
  ) {}

  async getValidAccessToken(tenantId: string): Promise<string> {
    const integration = await this.repository.getGhlIntegration(tenantId);
    if (!integration) throw new Error("GHL integration was not found");

    const expiresSoon = !integration.accessTokenExpiresAt
      || integration.accessTokenExpiresAt.getTime() <= Date.now() + REFRESH_WINDOW_MS;
    if (!expiresSoon) return this.cryptor.decrypt(integration.encryptedAccessToken);
    return this.refresh(tenantId);
  }

  async forceRefresh(tenantId: string): Promise<string> {
    return this.refresh(tenantId);
  }

  private refresh(tenantId: string): Promise<string> {
    const existing = this.refreshes.get(tenantId);
    if (existing) return existing;

    const operation = this.refreshOnce(tenantId).finally(() => this.refreshes.delete(tenantId));
    this.refreshes.set(tenantId, operation);
    return operation;
  }

  private async refreshOnce(tenantId: string): Promise<string> {
    const integration = await this.repository.getGhlIntegration(tenantId);
    if (!integration?.encryptedRefreshToken) throw new Error("GHL refresh token is unavailable");

    const previousRefreshToken = this.cryptor.decrypt(integration.encryptedRefreshToken);
    const refreshed = await this.oauthClient.refreshToken(previousRefreshToken);
    const update: UpdateGhlTokensInput = {
      tenantId,
      encryptedAccessToken: this.cryptor.encrypt(refreshed.accessToken),
      encryptedRefreshToken: this.cryptor.encrypt(refreshed.refreshToken ?? previousRefreshToken),
      scopes: refreshed.scopes.length > 0 ? refreshed.scopes : integration.scopes,
      ...(refreshed.expiresAt ? { accessTokenExpiresAt: refreshed.expiresAt } : {}),
    };
    await this.repository.updateGhlTokens(update);
    return refreshed.accessToken;
  }
}
