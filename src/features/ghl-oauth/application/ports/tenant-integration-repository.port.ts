export type SaveGhlInstallationInput = {
  locationId: string;
  expectedTenantId?: string;
  encryptedAccessToken: string;
  encryptedRefreshToken?: string;
  scopes: string[];
};

export interface TenantIntegrationRepository {
  saveGhlInstallation(input: SaveGhlInstallationInput): Promise<string>;
}
