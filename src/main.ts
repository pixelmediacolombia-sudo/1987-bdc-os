import { createHttpApp } from "@/presentation/http/create-http-app";
import { loadAppConfig } from "@/features/ghl-oauth/infrastructure/config/env.config";
import { Aes256GcmTokenCryptor } from "@/features/ghl-oauth/infrastructure/crypto/aes256-gcm-token.cryptor";
import { GhlOAuthClientAdapter } from "@/features/ghl-oauth/infrastructure/ghl/ghl-oauth.client";
import { HmacOAuthStateService } from "@/features/ghl-oauth/infrastructure/oauth/hmac-oauth-state.service";
import { createPostgresPool } from "@/features/ghl-oauth/infrastructure/persistence/postgres/pool";
import { ensureIntegrationsTable } from "@/features/ghl-oauth/infrastructure/persistence/postgres/integrations.migration";
import { PostgresTenantIntegrationRepository } from "@/features/ghl-oauth/infrastructure/persistence/postgres/tenant-integration.repository";
import { CompleteGhlOAuthUseCase } from "@/features/ghl-oauth/application/use-cases/complete-ghl-oauth.use-case";
import { InitiateGhlOAuthUseCase } from "@/features/ghl-oauth/application/use-cases/initiate-ghl-oauth.use-case";
import { GhlOAuthController } from "@/features/ghl-oauth/presentation/http/ghl-oauth.controller";
import { GhlOAuthPresentationService } from "@/features/ghl-oauth/presentation/services/ghl-oauth.presentation.service";

async function start(): Promise<void> {
  const config = loadAppConfig();
  const pool = createPostgresPool(config.databaseUrl, config.pgSsl);
  await ensureIntegrationsTable(pool);

  const oauthClient = new GhlOAuthClientAdapter(config);
  const stateService = new HmacOAuthStateService(config.oauthStateSecret);
  const cryptor = new Aes256GcmTokenCryptor(config.encryptionSecret);
  const repository = new PostgresTenantIntegrationRepository(pool);
  const presentationService = new GhlOAuthPresentationService(
    new InitiateGhlOAuthUseCase(oauthClient, stateService),
    new CompleteGhlOAuthUseCase(oauthClient, stateService, cryptor, repository),
  );
  const controller = new GhlOAuthController(presentationService);
  const app = createHttpApp(controller);
  const server = app.listen(config.port, () => console.log(`1987 BDC OS backend listening on port ${config.port}`));

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting down`);
    server.close(() => void pool.end());
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error: unknown) => {
  console.error("Backend startup failed", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
