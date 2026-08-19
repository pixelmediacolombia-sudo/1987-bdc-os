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
import { ensureWebhookTables } from "@/modules/webhooks/infrastructure/persistence/postgres/webhooks.migration";
import { PostgresWebhookRepository } from "@/modules/webhooks/infrastructure/persistence/postgres/postgres-webhook.repository";
import { ProcessGHLWebhookUseCase } from "@/modules/webhooks/application/process-ghl-webhook.use-case";
import { WebhookController } from "@/modules/webhooks/presentation/http/webhook.controller";
import { ContactMutex } from "@/modules/control/application/contact-mutex";
import { BurstBufferService } from "@/modules/control/application/burst-buffer.service";
import { HumanSuppressionService } from "@/modules/control/application/human-suppression.service";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import { IoredisClient } from "@/modules/control/infrastructure/redis/ioredis-client";
import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import { LocalPolicyPackProvider } from "@/modules/memory/infrastructure/policies/local-policy-pack.provider";
import { ensureMemoryTables } from "@/modules/memory/infrastructure/persistence/postgres/memory.migration";
import { PostgresHydrationRepository } from "@/modules/memory/infrastructure/persistence/postgres/postgres-hydration.repository";

async function start(): Promise<void> {
  const config = loadAppConfig();
  const pool = createPostgresPool(config.databaseUrl, config.pgSsl);
  const redis = new IoredisClient(config.redisUrl);
  await ensureIntegrationsTable(pool);
  await ensureWebhookTables(pool);
  await ensureMemoryTables(pool);

  const oauthClient = new GhlOAuthClientAdapter(config);
  const stateService = new HmacOAuthStateService(config.oauthStateSecret);
  const cryptor = new Aes256GcmTokenCryptor(config.encryptionSecret);
  const repository = new PostgresTenantIntegrationRepository(pool);
  const presentationService = new GhlOAuthPresentationService(
    new InitiateGhlOAuthUseCase(oauthClient, stateService),
    new CompleteGhlOAuthUseCase(oauthClient, stateService, cryptor, repository),
  );
  const controller = new GhlOAuthController(presentationService);
  const hydrator = new ConversationHydrator(
    new PostgresHydrationRepository(pool),
    new LocalPolicyPackProvider(),
  );
  const contactMutex = new ContactMutex(redis, config.contactMutexTtlMs);
  const burstBuffer = new BurstBufferService(
    redis,
    contactMutex,
    new HydratingInboundConversationOrchestrator(hydrator),
    { bufferSeconds: config.burstBufferSeconds, controlTtlSeconds: config.burstBufferControlTtlSeconds },
  );
  await burstBuffer.recoverPendingTimers();
  const humanSuppression = new HumanSuppressionService(burstBuffer, contactMutex);
  const webhookController = new WebhookController(
    new ProcessGHLWebhookUseCase(new PostgresWebhookRepository(pool), burstBuffer, humanSuppression),
  );
  const app = createHttpApp(controller, webhookController);
  const server = app.listen(config.port, () => console.log(`1987 BDC OS backend listening on port ${config.port}`));

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting down`);
    server.close(() => void Promise.all([pool.end(), redis.close()]));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error: unknown) => {
  console.error("Backend startup failed", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
