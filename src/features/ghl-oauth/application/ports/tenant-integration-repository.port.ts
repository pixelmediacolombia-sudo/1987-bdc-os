export type SaveGhlInstallationInput = {
  locationId: string;
  expectedTenantId?: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  scopes: string[];
  accessTokenExpiresAt?: Date;
};

export type StoredGhlIntegration = {
  id: string;
  tenantId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  scopes: string[];
  accessTokenExpiresAt?: Date;
};

export type UpdateGhlTokensInput = {
  tenantId: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  scopes: string[];
  accessTokenExpiresAt?: Date;
};

export interface TenantIntegrationRepository {
  saveGhlInstallation(input: SaveGhlInstallationInput): Promise<string>;
  getGhlIntegration(tenantId: string): Promise<StoredGhlIntegration | undefined>;
  updateGhlTokens(input: UpdateGhlTokensInput): Promise<void>;
}
