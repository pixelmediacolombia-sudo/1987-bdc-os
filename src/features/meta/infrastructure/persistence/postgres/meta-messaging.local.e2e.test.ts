import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test from "node:test";
import { Aes256GcmTokenCryptor } from "@/modules/security/infrastructure/aes256-gcm-token.cryptor";
import { createPostgresPool } from "@/infrastructure/database/postgres-pool";
import { MetaWebhookController } from "@/features/meta/presentation/http/meta-webhook.controller";
import { PostgresMetaMessagingConnectionRepository } from "@/features/meta/infrastructure/persistence/postgres/postgres-meta-messaging-connection.repository";
import { PostgresWebhookRepository } from "@/modules/webhooks/infrastructure/persistence/postgres/postgres-webhook.repository";
import { ProcessInboundWebhookUseCase } from "@/modules/webhooks/application/process-inbound-webhook.use-case";
import { RedisWebhookQueue } from "@/modules/webhooks/infrastructure/redis/redis-webhook-queue";
import { IoredisClient } from "@/modules/control/infrastructure/redis/ioredis-client";
import { ContactMutex } from "@/modules/control/application/contact-mutex";
import { BurstBufferService } from "@/modules/control/application/burst-buffer.service";

const enabled = process.env.META_LOCAL_E2E === "true";

test("Meta inbound event is routed by dealer, persisted in Postgres, and buffered through Redis", { skip: !enabled }, async (context) => {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  const encryptionSecret = process.env.ENCRYPTION_SECRET;
  if (!databaseUrl || !redisUrl || !encryptionSecret) throw new Error("Local Docker database, Redis and encryption settings are required");

  const tenantId = randomUUID();
  const pageId = `meta-page-e2e-${tenantId}`;
  const contactId = `meta-psid-e2e-${tenantId}`;
  const messageId = `meta-mid-e2e-${tenantId}`;
  const appSecret = "local-meta-app-secret-for-tests-only";
  const pool = createPostgresPool(databaseUrl, process.env.PGSSL === "true");
  const redis = new IoredisClient(redisUrl);
  const cryptor = new Aes256GcmTokenCryptor(encryptionSecret);
  const connections = new PostgresMetaMessagingConnectionRepository(pool, cryptor);
  const queue = new RedisWebhookQueue(redis, { backoffMs: 50, maxBackoffMs: 100, maxAttempts: 3 });
  const buffered: string[] = [];
  const burstBuffer = new BurstBufferService(
    redis,
    new ContactMutex(redis, 10_000),
    { process: async (input) => { buffered.push(input.contactId); } },
    { bufferSeconds: 60, controlTtlSeconds: 120, logger: { info: () => undefined, error: () => undefined } },
  );
  const repository = new PostgresWebhookRepository(pool);
  const processor = new ProcessInboundWebhookUseCase(repository, burstBuffer, undefined, undefined, { info: () => undefined, error: () => undefined });
  const controller = new MetaWebhookController(processor, queue, "local-meta-webhook-verify-token");
  const rawBody = Buffer.from(JSON.stringify({
    object: "page",
    entry: [{ id: pageId, messaging: [{ sender: { id: contactId }, recipient: { id: pageId }, message: { mid: messageId, text: "Quiero conocer opciones" } }] }],
  }));
  const signature = `sha256=${createHmac("sha256", appSecret).update(rawBody).digest("hex")}`;
  let bufferedKeys: string[] = [];

  await pool.query(
    `INSERT INTO public.tenants (dealer_id, dealer_name, timezone, policy_version, status, sofia_enabled, qualification_flow_enabled, qualification_signal_enabled)
     VALUES ($1, $2, 'America/Bogota', 'shared_dealer_v1', 'active', false, false, false)`,
    [tenantId, `Meta E2E ${tenantId}`],
  );
  try {
    await connections.save({ tenantId, facebookPageId: pageId, pageAccessToken: "encrypted-page-token", grantedScopes: ["pages_messaging"] });
    const connection = await connections.getForTenant(tenantId);
    assert.equal(connection?.pageId, pageId);
    assert.equal(connection?.pageAccessToken, "encrypted-page-token");
    const route = await pool.query("SELECT public.resolve_meta_tenant_id($1) AS tenant_id", [pageId]);
    assert.equal(route.rows[0]?.tenant_id, tenantId);

    await queue.start((job) => controller.process(job.rawBody, job.signature));
    assert.equal(await queue.enqueue(rawBody, signature), true);
    const deadline = Date.now() + 8_000;
    let persisted: { status: string } | undefined;
    let bufferedMessage: string | undefined;
    while (Date.now() < deadline) {
      const webhook = await pool.query<{ status: string }>(
        "SELECT status FROM public.raw_webhooks WHERE tenant_id = $1 AND external_id = $2",
        [tenantId, messageId],
      );
      persisted = webhook.rows[0];
      const contacts = await pool.query("SELECT 1 FROM public.contacts WHERE tenant_id = $1 AND provider_contact_id = $2", [tenantId, contactId]);
      if (contacts.rowCount) {
        bufferedKeys = await redis.scan("buffer:messages:*");
        for (const key of bufferedKeys) {
          const rows = await redis.lrange(key, 0, -1);
          bufferedMessage = rows.find((row) => row.includes(messageId));
          if (bufferedMessage) break;
        }
      }
      if (persisted?.status === "processed" && bufferedMessage) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(persisted?.status, "processed", "Meta webhook must reach its durable processed stage in PostgreSQL");
    assert.ok(bufferedMessage?.includes(contactId), "Inbound Meta message must reach the real Redis conversation buffer");
    assert.equal((await pool.query("SELECT 1 FROM public.conversations WHERE tenant_id = $1 AND provider_conversation_id = $2", [tenantId, `fb:${pageId}:${contactId}`])).rowCount, 1);
  } finally {
    await queue.stop();
    await burstBuffer.cancel(tenantId, contactId).catch(() => undefined);
    if (bufferedKeys.length) await redis.del(...bufferedKeys).catch(() => undefined);
    await pool.query("DELETE FROM public.tenants WHERE dealer_id = $1", [tenantId]).catch(() => undefined);
    await redis.close();
    await pool.end();
  }
  assert.ok(buffered.length === 0 || buffered.includes(contactId));
  context.diagnostic(`Meta event ${messageId} persisted and passed through PostgreSQL + Redis for tenant ${tenantId}`);
});
