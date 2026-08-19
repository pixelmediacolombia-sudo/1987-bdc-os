import assert from "node:assert/strict";
import { test } from "node:test";
import { BurstBufferService, scopeSuffix } from "@/modules/control/application/burst-buffer.service";
import { ContactMutex } from "@/modules/control/application/contact-mutex";
import type { ConsolidatedInboundConversation, InboundConversationOrchestratorPort } from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";
import { IoredisClient } from "@/modules/control/infrastructure/redis/ioredis-client";

const enabled = process.env.RUN_REDIS_INTEGRATION_TESTS === "true" && Boolean(process.env.REDIS_URL?.trim());

class CapturingOrchestrator implements InboundConversationOrchestratorPort {
  result?: ConsolidatedInboundConversation;
  async process(input: ConsolidatedInboundConversation): Promise<void> { this.result = input; }
}

test("Redis real: expira la ventana y hace flush atómico del búfer", { skip: !enabled }, async () => {
  const tenantId = `integration-tenant-${Date.now()}`;
  const contactId = `integration-contact-${Date.now()}`;
  const redis = new IoredisClient(process.env.REDIS_URL as string);
  const mutex = new ContactMutex(redis, 30_000);
  const orchestrator = new CapturingOrchestrator();
  const service = new BurstBufferService(redis, mutex, orchestrator, {
    bufferSeconds: 1,
    controlTtlSeconds: 5,
  });

  try {
    await service.add({
      externalId: `integration-message-${Date.now()}`,
      contactId,
      conversationId: "integration-conversation",
      channel: "sms",
      content: "mensaje de integración",
      semanticHash: "integration-hash",
    }, tenantId);

    const suffix = scopeSuffix(tenantId, contactId);
    const messageKey = `buffer:messages:${suffix}`;
    const timerKey = `buffer:timer:${suffix}`;
    assert.equal(await redis.lrange(messageKey, 0, -1).then((items) => items.length), 1);
    assert.ok((await redis.ttl(timerKey)) > 1, "el TTL de control debe superar la ventana");

    await new Promise((resolve) => setTimeout(resolve, 1_300));
    assert.equal(await redis.lrange(messageKey, 0, -1).then((items) => items.length), 0);
    assert.equal(await redis.get(timerKey), null);
    assert.equal(orchestrator.result?.consolidatedText, "mensaje de integración");
  } finally {
    await service.cancel(tenantId, contactId).catch(() => undefined);
    await redis.close();
  }
});
