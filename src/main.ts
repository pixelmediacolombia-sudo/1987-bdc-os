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
import { RedisWebhookQueue } from "@/modules/webhooks/infrastructure/redis/redis-webhook-queue";
import { ContactMutex } from "@/modules/control/application/contact-mutex";
import { BurstBufferService } from "@/modules/control/application/burst-buffer.service";
import { HumanSuppressionService } from "@/modules/control/application/human-suppression.service";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import { IoredisClient } from "@/modules/control/infrastructure/redis/ioredis-client";
import { RedisBurstFlushQueue } from "@/modules/control/infrastructure/redis/redis-burst-flush-queue";
import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import { LocalPolicyPackProvider } from "@/modules/memory/infrastructure/policies/local-policy-pack.provider";
import { ensureMemoryTables } from "@/modules/memory/infrastructure/persistence/postgres/memory.migration";
import { PostgresHydrationRepository } from "@/modules/memory/infrastructure/persistence/postgres/postgres-hydration.repository";
import { PostgresOutboundMessageRegistry } from "@/modules/control/infrastructure/persistence/postgres/postgres-outbound-message-registry";
import { ensureDecisionLogsTable } from "@/modules/decisions/infrastructure/persistence/postgres/decision-logs.migration";
import { PostgresDecisionLogRepository } from "@/modules/decisions/infrastructure/persistence/postgres/postgres-decision-log.repository";
import { PostgresPolicyContextRepository } from "@/modules/decisions/infrastructure/persistence/postgres/postgres-policy-context.repository";
import { PolicyEngine } from "@/modules/decisions/application/policy-engine";
import { PolicyEvaluationService } from "@/modules/decisions/application/policy-evaluation.service";
import { QuestionLedgerService } from "@/modules/decisions/application/QuestionLedgerService";
import { PolicyDiagnosticController } from "@/modules/decisions/presentation/http/policy-diagnostic.controller";
import { RedisDiagnosticController } from "@/presentation/http/redis-diagnostic.controller";

async function start(): Promise<void> {
  const config = loadAppConfig();
  const pool = createPostgresPool(config.databaseUrl, config.pgSsl);
  const redis = new IoredisClient(config.redisUrl);
  await ensureIntegrationsTable(pool);
  await ensureWebhookTables(pool);
  await ensureMemoryTables(pool);
  await ensureDecisionLogsTable(pool);

  const oauthClient = new GhlOAuthClientAdapter(config);
  const stateService = new HmacOAuthStateService(config.oauthStateSecret);
  const cryptor = new Aes256GcmTokenCryptor(config.encryptionSecret);
  const repository = new PostgresTenantIntegrationRepository(pool);
  const presentationService = new GhlOAuthPresentationService(
    new InitiateGhlOAuthUseCase(oauthClient, stateService),
    new CompleteGhlOAuthUseCase(oauthClient, stateService, cryptor, repository),
  );
  const controller = new GhlOAuthController(presentationService);
  const policyPackProvider = new LocalPolicyPackProvider();
  const hydrator = new ConversationHydrator(
    new PostgresHydrationRepository(pool),
    policyPackProvider,
  );
  const policyEvaluator = new PolicyEvaluationService(
    new PostgresPolicyContextRepository(pool, policyPackProvider),
    new PolicyEngine(),
    new PostgresDecisionLogRepository(pool),
    new QuestionLedgerService(pool),
  );
  const contactMutex = new ContactMutex(redis, config.contactMutexTtlMs);
  const burstBuffer = new BurstBufferService(
    redis,
    contactMutex,
    new HydratingInboundConversationOrchestrator(hydrator),
    {
      bufferSeconds: config.burstBufferSeconds,
      controlTtlSeconds: config.burstBufferControlTtlSeconds,
      durableQueue: new RedisBurstFlushQueue(redis),
    },
  );
  await burstBuffer.recoverPendingTimers();
  await burstBuffer.start();
  const humanSuppression = new HumanSuppressionService(burstBuffer, contactMutex);
  const processWebhook = new ProcessGHLWebhookUseCase(
    new PostgresWebhookRepository(pool, new PostgresOutboundMessageRegistry(pool)),
    burstBuffer,
    humanSuppression,
    policyEvaluator,
  );
  const webhookQueue = new RedisWebhookQueue(redis);
  await webhookQueue.start(async (job) => {
    const payload: unknown = JSON.parse(job.rawBody.toString("utf8"));
    await processWebhook.execute({ payload, rawBody: job.rawBody, signature: job.signature });
  });
  const webhookController = new WebhookController(
    processWebhook,
    webhookQueue,
  );
  const policyDiagnosticController = new PolicyDiagnosticController(policyEvaluator, config.policyDiagnosticToken);
  const redisDiagnosticController = new RedisDiagnosticController(redis, config.policyDiagnosticToken);
  const app = createHttpApp(controller, webhookController, undefined, policyDiagnosticController, redisDiagnosticController);
  const server = app.listen(config.port, () => console.log(`1987 BDC OS backend listening on port ${config.port}`));

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting down`);
    server.close(() => void Promise.all([webhookQueue.stop(), burstBuffer.stop(), pool.end(), redis.close()]));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error: unknown) => {
  console.error("Backend startup failed", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
