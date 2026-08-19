import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhlOAuthClient } from "@/features/ghl-oauth/application/ports/ghl-oauth-client.port";
import type {
  StoredGhlIntegration,
  TenantIntegrationRepository,
  UpdateGhlTokensInput,
} from "@/features/ghl-oauth/application/ports/tenant-integration-repository.port";
import { GhlTokenRefreshUseCase } from "@/features/ghl-oauth/application/use-cases/ghl-token-refresh.use-case";
import { Aes256GcmTokenCryptor } from "@/features/ghl-oauth/infrastructure/crypto/aes256-gcm-token.cryptor";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

function createRepository(integration: StoredGhlIntegration) {
  let current = integration;
  const updates: UpdateGhlTokensInput[] = [];
  const repository: TenantIntegrationRepository = {
    saveGhlInstallation: async () => TENANT_ID,
    getGhlIntegration: async () => current,
    updateGhlTokens: async (input) => {
      updates.push(input);
      current = {
        ...current,
        encryptedAccessToken: input.encryptedAccessToken,
        ...(input.encryptedRefreshToken ? { encryptedRefreshToken: input.encryptedRefreshToken } : {}),
        scopes: input.scopes,
        ...(input.accessTokenExpiresAt ? { accessTokenExpiresAt: input.accessTokenExpiresAt } : {}),
      };
    },
  };
  return { repository, updates, getCurrent: () => current };
}

function createOAuthClient(refreshCalls: string[]) {
  const client: GhlOAuthClient = {
    createAuthorizationUrl: () => "https://example.test/oauth",
    exchangeCode: async () => ({
      accessToken: "unused",
      locationId: "unused",
      scopes: [],
    }),
    refreshToken: async (refreshToken) => {
      refreshCalls.push(refreshToken);
      await new Promise((resolve) => setTimeout(resolve, 15));
      return {
        accessToken: "rotated-access-token",
        refreshToken: "rotated-refresh-token",
        scopes: ["contacts.readonly"],
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      };
    },
  };
  return client;
}

test("refreshes an expiring token, rotates the encrypted pair, and coalesces concurrent calls", async () => {
  const cryptor = new Aes256GcmTokenCryptor("test-encryption-secret-with-at-least-32-bytes");
  const stored = {
    id: "00000000-0000-0000-0000-000000000010",
    tenantId: TENANT_ID,
    encryptedAccessToken: cryptor.encrypt("old-access-token"),
    encryptedRefreshToken: cryptor.encrypt("old-refresh-token"),
    scopes: ["contacts.readonly"],
    accessTokenExpiresAt: new Date(Date.now() + 4 * 60 * 1000),
  } satisfies StoredGhlIntegration;
  const { repository, updates, getCurrent } = createRepository(stored);
  const refreshCalls: string[] = [];
  const useCase = new GhlTokenRefreshUseCase(createOAuthClient(refreshCalls), repository, cryptor);

  const tokens = await Promise.all(
    Array.from({ length: 5 }, () => useCase.getValidAccessToken(TENANT_ID)),
  );

  assert.deepEqual(tokens, Array(5).fill("rotated-access-token"));
  assert.deepEqual(refreshCalls, ["old-refresh-token"]);
  assert.equal(updates.length, 1);
  assert.equal(cryptor.decrypt(getCurrent().encryptedAccessToken), "rotated-access-token");
  assert.equal(cryptor.decrypt(getCurrent().encryptedRefreshToken ?? ""), "rotated-refresh-token");
  assert.notEqual(updates[0]?.encryptedAccessToken, "rotated-access-token");
  assert.notEqual(updates[0]?.encryptedRefreshToken, "rotated-refresh-token");
});

test("does not refresh a token that remains valid beyond the five-minute window", async () => {
  const cryptor = new Aes256GcmTokenCryptor("test-encryption-secret-with-at-least-32-bytes");
  const stored = {
    id: "00000000-0000-0000-0000-000000000011",
    tenantId: TENANT_ID,
    encryptedAccessToken: cryptor.encrypt("valid-access-token"),
    encryptedRefreshToken: cryptor.encrypt("refresh-token"),
    scopes: ["contacts.readonly"],
    accessTokenExpiresAt: new Date(Date.now() + 10 * 60 * 1000),
  } satisfies StoredGhlIntegration;
  const { repository, updates } = createRepository(stored);
  const refreshCalls: string[] = [];
  const useCase = new GhlTokenRefreshUseCase(createOAuthClient(refreshCalls), repository, cryptor);

  assert.equal(await useCase.getValidAccessToken(TENANT_ID), "valid-access-token");
  assert.deepEqual(refreshCalls, []);
  assert.equal(updates.length, 0);
});
