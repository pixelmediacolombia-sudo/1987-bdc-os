import type { GhlOAuthClient } from "@/features/ghl-oauth/application/ports/ghl-oauth-client.port";
import type { OAuthStateService } from "@/features/ghl-oauth/application/ports/oauth-state.port";
import type { SecretCryptor } from "@/features/ghl-oauth/application/ports/secret-cryptor.port";
import type { TenantIntegrationRepository } from "@/features/ghl-oauth/application/ports/tenant-integration-repository.port";

export class CompleteGhlOAuthUseCase {
  constructor(
    private readonly oauthClient: GhlOAuthClient,
    private readonly stateService: OAuthStateService,
    private readonly cryptor: SecretCryptor,
    private readonly repository: TenantIntegrationRepository,
  ) {}

  async execute(input: { code: string; state: string }): Promise<{ tenantId: string; locationId: string }> {
    const claims = this.stateService.verify(input.state);
    let tokens;
    try {
      tokens = await this.oauthClient.exchangeCode(input.code);
    } catch {
      throw new Error("GHL token exchange failed");
    }

    let tenantId: string;
    try {
      tenantId = await this.repository.saveGhlInstallation({
        locationId: tokens.locationId,
        ...(claims.tenantId ? { expectedTenantId: claims.tenantId } : {}),
        encryptedAccessToken: this.cryptor.encrypt(tokens.accessToken),
        ...(tokens.refreshToken ? { encryptedRefreshToken: this.cryptor.encrypt(tokens.refreshToken) } : {}),
        scopes: tokens.scopes,
        ...(tokens.expiresAt ? { accessTokenExpiresAt: tokens.expiresAt } : {}),
      });
    } catch (error) {
      if (error instanceof Error && error.message !== "OAuth location does not match the requested tenant") {
        throw new Error("OAuth installation persistence failed");
      }
      throw error;
    }

    return { tenantId, locationId: tokens.locationId };
  }
}
