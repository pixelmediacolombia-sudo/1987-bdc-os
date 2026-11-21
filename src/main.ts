import { createHttpApp } from "@/presentation/http/create-http-app";
import { loadAppConfig } from "@/infrastructure/config/env.config";
import { Aes256GcmTokenCryptor } from "@/modules/security/infrastructure/aes256-gcm-token.cryptor";
import { HmacOAuthStateService } from "@/features/meta/infrastructure/hmac-oauth-state.service";
import { createPostgresPool } from "@/infrastructure/database/postgres-pool";
import { ensureWebhookTables } from "@/modules/webhooks/infrastructure/persistence/postgres/webhooks.migration";
import { PostgresWebhookRepository } from "@/modules/webhooks/infrastructure/persistence/postgres/postgres-webhook.repository";
import { ProcessInboundWebhookUseCase } from "@/modules/webhooks/application/process-inbound-webhook.use-case";
import { RedisWebhookQueue } from "@/modules/webhooks/infrastructure/redis/redis-webhook-queue";
import { ContactMutex } from "@/modules/control/application/contact-mutex";
import { BurstBufferService } from "@/modules/control/application/burst-buffer.service";
import { HumanSuppressionService } from "@/modules/control/application/human-suppression.service";
import { IoredisClient } from "@/modules/control/infrastructure/redis/ioredis-client";
import { RedisBurstFlushQueue } from "@/modules/control/infrastructure/redis/redis-burst-flush-queue";
import { ConversationHydrator } from "@/modules/memory/application/conversation-hydrator";
import { LocalPolicyPackProvider } from "@/modules/memory/infrastructure/policies/local-policy-pack.provider";
import { ensureMemoryTables } from "@/modules/memory/infrastructure/persistence/postgres/memory.migration";
import { PostgresHydrationRepository } from "@/modules/memory/infrastructure/persistence/postgres/postgres-hydration.repository";
import { PostgresOutboundMessageRegistry } from "@/modules/control/infrastructure/persistence/postgres/postgres-outbound-message-registry";
import { createQualificationFlow } from "@/modules/control/infrastructure/composition/qualification-flow.composer";
import { createInboundConversationOrchestrator } from "@/modules/control/infrastructure/composition/inbound-conversation-orchestrator.composer";
import { ensureDecisionLogsTable } from "@/modules/decisions/infrastructure/persistence/postgres/decision-logs.migration";
import { PostgresDecisionLogRepository } from "@/modules/decisions/infrastructure/persistence/postgres/postgres-decision-log.repository";
import { PostgresPolicyContextRepository } from "@/modules/decisions/infrastructure/persistence/postgres/postgres-policy-context.repository";
import { PolicyEngine } from "@/modules/decisions/application/policy-engine";
import { PolicyEvaluationService } from "@/modules/decisions/application/policy-evaluation.service";
import { QuestionLedgerService } from "@/modules/decisions/application/QuestionLedgerService";
import { PolicyDiagnosticController } from "@/modules/decisions/presentation/http/policy-diagnostic.controller";
import { RedisDiagnosticController } from "@/presentation/http/redis-diagnostic.controller";
import { ensureQualificationSignalTables } from "@/modules/webhooks/infrastructure/persistence/postgres/qualification-signals.migration";
import { PostgresQualificationSignalRepository } from "@/modules/control/infrastructure/persistence/postgres/postgres-qualification-signal.repository";
import { QualificationSignalWorker } from "@/modules/control/infrastructure/qualification-signal.worker";
import { MetaCapiProvider } from "@/modules/control/infrastructure/meta-capi.provider";
import { PostgresSofiaStateRepository } from "@/modules/control/infrastructure/persistence/postgres/postgres-sofia-state.repository";
import { ensureTenantFeatureFlags } from "@/modules/control/infrastructure/persistence/postgres/tenant-flags.migration";
import { ensureSharedDealerPolicy } from "@/modules/control/infrastructure/persistence/postgres/shared-dealer-policy.migration";
import { ensureConversationAiShadowTables } from "@/modules/control/infrastructure/persistence/postgres/conversation-ai-shadow.migration";
import { LocalMediaUnderstandingAdapter } from "@/modules/media/infrastructure/local-media-understanding.adapter";
import { OpenAICompatibleConversationalModel } from "@/modules/ai/infrastructure/openai-compatible-conversational-model.adapter";
import { ConversationAiService } from "@/modules/control/application/conversation-ai.service";
import { PostgresConversationAiShadowRepository } from "@/modules/control/infrastructure/persistence/postgres/postgres-conversation-ai-shadow.repository";
import { OutboundDeliveryReconciliationService } from "@/modules/control/application/outbound-delivery-reconciliation.service";
import { RegisteredOutboundMessageSender } from "@/modules/control/application/registered-outbound-message-sender";
import { OutboundDeliveryReconciliationController } from "@/presentation/http/outbound-delivery-reconciliation.controller";
import { ensureInternalDiagnosticAuditTable } from "@/presentation/http/internal-diagnostic-audit.migration";
import { PostgresInternalDiagnosticAudit } from "@/presentation/http/postgres-internal-diagnostic-audit";
import { ensureIdentityTables } from "@/features/identity/infrastructure/persistence/postgres/identity.migration";
import { ensureAdminAuditTable } from "@/features/identity/infrastructure/persistence/postgres/admin-audit.migration";
import { bootstrapLocalAdmin } from "@/features/identity/infrastructure/persistence/postgres/local-admin.bootstrap";
import { createIdentityRouter } from "@/features/identity/presentation/http/identity.routes";
import { createSmtpDealerInvitationMailer } from "@/features/identity/infrastructure/email/smtp-dealer-invitation-mailer";
import { ensureMetaMessagingTables } from "@/features/meta/infrastructure/persistence/postgres/meta-messaging.migration";
import { MetaWebhookController } from "@/features/meta/presentation/http/meta-webhook.controller";
import { MetaGraphApiClient } from "@/features/meta/infrastructure/meta-graph-api.client";
import { MetaOutboundMessageProvider } from "@/features/meta/infrastructure/meta-outbound-message.provider";
import { PostgresMetaMessagingConnectionRepository } from "@/features/meta/infrastructure/persistence/postgres/postgres-meta-messaging-connection.repository";
import { MetaOAuthClient } from "@/features/meta/application/oauth/meta-oauth.client";
import { MetaOAuthController } from "@/features/meta/presentation/http/meta-oauth.controller";

async function start(): Promise<void> {
  const config = loadAppConfig();
  const pool = createPostgresPool(config.databaseUrl, config.pgSsl);
  const redis = new IoredisClient(config.redisUrl);
  await ensureWebhookTables(pool);
  await ensureIdentityTables(pool);
  await ensureAdminAuditTable(pool);
  const localAdminCreated = await bootstrapLocalAdmin(pool);
  if (localAdminCreated) console.info("[Identity] local platform admin bootstrapped");
  await ensureTenantFeatureFlags(pool);
  await ensureMemoryTables(pool);
  const sharedDealerActivated = await ensureSharedDealerPolicy(pool);
  console.info(`[SharedDealerPolicy] baseline=shared_dealer_v1 dealer_overrides=planned migrated=${sharedDealerActivated}`);
  await ensureDecisionLogsTable(pool);
  await ensureQualificationSignalTables(pool);
  await ensureMetaMessagingTables(pool);
  await ensureConversationAiShadowTables(pool);
  await ensureInternalDiagnosticAuditTable(pool);

  const stateService = new HmacOAuthStateService(config.oauthStateSecret);
  const cryptor = new Aes256GcmTokenCryptor(config.encryptionSecret);
  const metaMessagingConnections = new PostgresMetaMessagingConnectionRepository(pool, cryptor);
  const metaOAuthClient = config.metaAppId && config.metaAppSecret && config.metaOAuthRedirectUri
    ? new MetaOAuthClient(config.metaAppId, config.metaAppSecret, config.metaOAuthRedirectUri,
        config.metaGraphApiBaseUrl, config.metaGraphApiVersion, config.metaOAuthAuthorizationBaseUrl)
    : undefined;
  const metaOAuthController = new MetaOAuthController(
    pool, stateService, metaOAuthClient, metaMessagingConnections,
    config.metaOAuthRedirectUri, process.env.BDC_APP_URL, config.metaOAuthScopes,
  );
  const metaOutboundProvider = new MetaOutboundMessageProvider(
    metaMessagingConnections,
    new MetaGraphApiClient(config.metaGraphApiBaseUrl, config.metaGraphApiVersion),
  );
  const policyPackProvider = new LocalPolicyPackProvider();
  const hydrator = new ConversationHydrator(
    new PostgresHydrationRepository(pool),
    policyPackProvider,
  );
  const qualificationSignalRepository = new PostgresQualificationSignalRepository(
    pool,
    config.metaCapiDealers,
    config.metaCapiEventName,
  );
  const questionLedger = new QuestionLedgerService(
    pool,
    config.qualificationSignalEnabled ? qualificationSignalRepository : undefined,
  );
  const policyEvaluator = new PolicyEvaluationService(
    new PostgresPolicyContextRepository(pool, policyPackProvider),
    new PolicyEngine(),
    new PostgresDecisionLogRepository(pool),
    questionLedger,
  );
  const outboundRegistry = new PostgresOutboundMessageRegistry(pool);
  const outboundDeliveryReconciliation = new OutboundDeliveryReconciliationService(
    outboundRegistry,
    metaOutboundProvider,
  );
  const conversationalAi = config.conversationalAiEnabled
    ? new ConversationAiService(
        new OpenAICompatibleConversationalModel(
          config.conversationalModelBaseUrl,
          config.conversationalModelApiKey!,
          config.conversationalExtractionModel,
          config.conversationalDraftingModel,
          config.conversationalModelTimeoutMs,
        ),
        new PostgresConversationAiShadowRepository(pool),
      )
    : undefined;
  const sofiaRepository = config.sofiaEnabled ? new PostgresSofiaStateRepository(pool) : undefined;
  const qualificationFlow = config.qualificationFlowEnabled
    ? createQualificationFlow({
        pool,
        outboundProvider: metaOutboundProvider,
        outboundRegistry,
        policyEvaluator,
      })
    : undefined;
  const inboundConversationOrchestrator = createInboundConversationOrchestrator({
    hydrator,
    qualificationFlowEnabled: config.qualificationFlowEnabled,
    qualificationFlow,
    sofiaEnabled: config.sofiaEnabled,
    sofiaRepository,
    qualificationLedger: questionLedger,
    qualificationSignalEnabled: config.qualificationSignalEnabled,
    conversationalAi,
    conversationalAiSendEnabled: config.conversationalAiSendEnabled,
  });
  const contactMutex = new ContactMutex(redis, config.contactMutexTtlMs);
  const burstBuffer = new BurstBufferService(
    redis,
    contactMutex,
    inboundConversationOrchestrator,
    {
      bufferSeconds: config.burstBufferSeconds,
      controlTtlSeconds: config.burstBufferControlTtlSeconds,
      durableQueue: new RedisBurstFlushQueue(redis),
    },
  );
  await burstBuffer.recoverPendingTimers();
  await burstBuffer.start();
  const humanSuppression = new HumanSuppressionService(burstBuffer, contactMutex);
  const mediaUnderstanding = config.mediaUnderstandingEnabled
    ? new LocalMediaUnderstandingAdapter({
        whisperExecutable: config.whisperCliPath,
        whisperModelPath: config.whisperModelPath,
        ffmpegExecutable: config.ffmpegCliPath,
        tesseractExecutable: config.tesseractCliPath,
      })
    : undefined;
  const processWebhook = new ProcessInboundWebhookUseCase(
    new PostgresWebhookRepository(pool, outboundRegistry),
    burstBuffer,
    humanSuppression,
    policyEvaluator,
    undefined,
    mediaUnderstanding,
    undefined,
  );
  const webhookQueue = new RedisWebhookQueue(redis);
  const metaWebhookController = new MetaWebhookController(processWebhook, webhookQueue, config.metaWebhookVerifyToken);
  await webhookQueue.start(async (job) => {
    await metaWebhookController.process(job.rawBody, job.signature);
  });
  let qualificationSignalWorker: QualificationSignalWorker | undefined;
  if (config.qualificationSignalEnabled) {
    const runtimeDatabase = await pool.query<{ database_name: string; database_user: string }>(
      "SELECT current_database() AS database_name, current_user AS database_user",
    );
    const databaseIdentity = runtimeDatabase.rows[0];
    console.info(
      `[Ticket8.5] Qualification signal runtime database database=${databaseIdentity?.database_name ?? "unknown"} user=${databaseIdentity?.database_user ?? "unknown"}`,
    );
    console.info(
      `[Ticket8.5] Qualification signal worker enabled configured_dealers=${config.metaCapiDealers.length} poll_ms=${config.qualificationSignalPollMs}`,
    );
    qualificationSignalWorker = new QualificationSignalWorker(
      qualificationSignalRepository,
      new MetaCapiProvider(),
      cryptor,
      config.nodeEnv,
      config.qualificationSignalPollMs,
    );
    await qualificationSignalWorker.start();
  } else {
    console.info("[Ticket8.5] Qualification signal worker disabled reason=QUALIFICATION_SIGNAL_ENABLED_false");
  }
  const policyDiagnosticController = new PolicyDiagnosticController(policyEvaluator);
  const redisDiagnosticController = new RedisDiagnosticController(redis);
  const outboundDeliveryReconciliationController = new OutboundDeliveryReconciliationController(
    outboundRegistry,
    outboundDeliveryReconciliation,
  );
  // The internal operations dashboard reads BDC OS-owned data.
  const { createDashboardRouter } = require("../dashboard/compiled/router.cjs");
  const dashboardRouter = createDashboardRouter({
    pool,
    publicDirectory: `${__dirname}/../dashboard/public`,
    outboundSender: new RegisteredOutboundMessageSender(outboundRegistry, metaOutboundProvider),
  });
  const app = createHttpApp({
    policyDiagnosticController,
    redisDiagnosticController,
    outboundDeliveryReconciliationController,
    dashboardRouter,
    internalDiagnostics: config.internalDiagnosticsEnabled ? {
      credentials: config.internalDiagnosticCredentials,
      audit: new PostgresInternalDiagnosticAudit(pool),
      production: config.nodeEnv === "production",
      allowedRemoteIps: config.internalDiagnosticAllowedRemoteIps,
    } : undefined,
    identityRouter: createIdentityRouter(pool, {
      production: config.nodeEnv === "production",
      publicAppUrl: process.env.BDC_APP_URL,
      invitationMailer: createSmtpDealerInvitationMailer(),
      metaCapiDealers: config.metaCapiDealers,
      metaCapiEventName: config.metaCapiEventName,
      metaOAuthStart: (tenantId) => metaOAuthController.authorizationUrl(tenantId),
      redisPing: () => redis.ping(),
    }),
    metaWebhook: { controller: metaWebhookController, appSecret: config.metaAppSecret },
    metaOAuth: metaOAuthController,
  });
  const server = app.listen(config.port, () => console.log(`1987 BDC OS backend listening on port ${config.port}`));

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting down`);
    server.close(() => void Promise.all([
      webhookQueue.stop(),
      burstBuffer.stop(),
      qualificationSignalWorker?.stop(),
      pool.end(),
      redis.close(),
    ]));
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error: unknown) => {
  console.error("Backend startup failed", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
