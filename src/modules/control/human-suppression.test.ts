import assert from "node:assert/strict";
import { test } from "node:test";
import { BurstBufferService, type BurstBufferLogger } from "@/modules/control/application/burst-buffer.service";
import { ContactMutex } from "@/modules/control/application/contact-mutex";
import { HumanSuppressionService } from "@/modules/control/application/human-suppression.service";
import { HydratingInboundConversationOrchestrator } from "@/modules/control/application/hydrating-inbound-conversation-orchestrator";
import type { InboundConversationOrchestratorPort } from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";
import type { RedisClientPort, RedisSetResult } from "@/modules/control/application/ports/redis-client.port";
import type { WebhookRepository } from "@/modules/webhooks/application/ports/webhook-repository.port";
import { ProcessGHLWebhookUseCase } from "@/modules/webhooks/application/process-ghl-webhook.use-case";
import type { GhlWebhookEvent } from "@/modules/webhooks/domain/ghl-webhook-event";

const CONTACT_ID = "contact-human-42";
const TENANT_ID = "tenant-42";

class FakeRedis implements RedisClientPort {
  readonly lists = new Map<string, string[]>();
  readonly values = new Map<string, string>();

  async set(key: string, value: string, _mode: "NX", _ttlMode: "EX" | "PX", _ttl: number): Promise<RedisSetResult> {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async ttl(key: string): Promise<number> { return this.values.has(key) ? 90 : -2; }
  async scan(match: string): Promise<string[]> { return [...this.values.keys()].filter((key) => key.startsWith(match.split("*")[0] ?? match)); }
  async zadd(): Promise<number> { return 1; }
  async zrangebyscore(): Promise<string[]> { return []; }
  async zrem(): Promise<number> { return 1; }
  async replaceSortedSetMember(): Promise<boolean> { return true; }
  async moveSortedSetMember(): Promise<boolean> { return true; }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1;
      if (this.lists.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.push(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(...values);
    this.lists.set(key, list);
    return list.length;
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const list = this.lists.get(key) ?? [];
    return stop === -1 ? list.slice(start) : list.slice(start, stop + 1);
  }

  async drainList(key: string): Promise<string[]> {
    const list = [...(this.lists.get(key) ?? [])];
    this.lists.delete(key);
    return list;
  }

  async deleteIfValue(key: string, expectedValue: string): Promise<boolean> {
    if (this.values.get(key) !== expectedValue) return false;
    this.values.delete(key);
    return true;
  }

  async close(): Promise<void> {}
}

class CapturingOrchestrator implements InboundConversationOrchestratorPort {
  calls = 0;

  async process(): Promise<void> {
    this.calls += 1;
  }
}

class RlsAwareWebhookRepository implements WebhookRepository {
  readonly trace: string[] = [];
  state = "open";
  interruption?: GhlWebhookEvent["humanInterruption"];

  async process(event: GhlWebhookEvent): Promise<{ duplicate: boolean; tenantId: string }> {
    this.trace.push("BEGIN", "set_config", "SELECT/UPDATE under tenant context");
    this.interruption = event.humanInterruption;
    if (event.humanInterruption) this.state = "paused";
    this.trace.push("COMMIT");
    return { duplicate: false, tenantId: TENANT_ID };
  }
}

test("cancela el búfer, temporizador y flujo IA cuando aparece human_takeover", async () => {
  const redis = new FakeRedis();
  const mutex = new ContactMutex(redis, 30_000);
  const orchestrator = new CapturingOrchestrator();
  const logs: string[] = [];
  const logger: BurstBufferLogger = {
    info: (message) => logs.push(message),
    error: (message) => logs.push(`ERROR ${message}`),
  };
  let scheduledCallback: (() => void) | undefined;
  const burstBuffer = new BurstBufferService(redis, mutex, orchestrator, {
    bufferSeconds: 15,
    controlTtlSeconds: 90,
    logger,
    timerScheduler: (callback) => {
      scheduledCallback = callback;
      return setTimeout(() => undefined, 60_000).unref();
    },
  });

  await burstBuffer.add({
    externalId: "inbound-1",
    contactId: CONTACT_ID,
    conversationId: "conversation-42",
    channel: "sms",
    content: "Hola, estoy interesado",
    semanticHash: "hash-inbound-1",
  }, TENANT_ID);
  assert.ok(scheduledCallback);
  assert.equal(redis.lists.get(`buffer:messages:tenant:${TENANT_ID}:contact:${CONTACT_ID}`)?.length, 1);
  assert.ok(redis.values.has(`buffer:timer:tenant:${TENANT_ID}:contact:${CONTACT_ID}`));

  const repository = new RlsAwareWebhookRepository();
  const suppression = new HumanSuppressionService(burstBuffer, mutex, { info: (message) => logs.push(message) });
  await new ProcessGHLWebhookUseCase(repository, burstBuffer, suppression).execute({
    payload: {
      eventId: "contact-update-1",
      eventType: "ContactUpdate",
      locationId: "location-42",
      contactId: CONTACT_ID,
      tags: ["human_takeover"],
    },
    rawBody: Buffer.from("{}"),
    signature: "test-signature",
  });

  assert.equal(redis.lists.has(`buffer:messages:${CONTACT_ID}`), false);
  assert.equal(redis.values.has(`buffer:timer:${CONTACT_ID}`), false);
  console.info(`[Ticket6] Redis buffer/timer cleared for ${CONTACT_ID}`);
  assert.equal(repository.state, "paused");
  console.info(`[Ticket6] conversation state=${repository.state} under RLS context`);
  assert.deepEqual(repository.interruption, {
    trigger: "control_tag",
    contactId: CONTACT_ID,
    controlTag: "human_takeover",
  });
  assert.equal(orchestrator.calls, 0);
  console.info(`[Ticket6] AI orchestrator calls=${orchestrator.calls}`);
  assert.ok(repository.trace.indexOf("set_config") < repository.trace.indexOf("SELECT/UPDATE under tenant context"));
  assert.match(logs.join("\n"), /Burst buffer cancelled/);
  assert.match(logs.join("\n"), /Human suppression completed/);
});

test("detecta un mensaje outbound enviado por staff como takeover humano", async () => {
  const repository = new RlsAwareWebhookRepository();
  const useCase = new ProcessGHLWebhookUseCase(repository);

  await useCase.execute({
    payload: {
      eventId: "staff-message-1",
      eventType: "OutboundMessage",
      locationId: "location-42",
      contactId: CONTACT_ID,
      conversationId: "conversation-42",
      direction: "outbound",
      sender_type: "staff",
      content: "Te atiendo personalmente.",
    },
    rawBody: Buffer.from("{}"),
    signature: "test-signature",
  });

  assert.equal(repository.interruption?.trigger, "staff_message");
  assert.equal(repository.interruption?.staffMessage?.content, "Te atiendo personalmente.");
  assert.equal(repository.state, "paused");
});

test("outbound oficial sin sender_type pausa por defecto si no existe registro de 1987", async () => {
  const repository = new RlsAwareWebhookRepository();
  let suppressions = 0;
  const suppression = { suppress: async () => { suppressions += 1; } };
  await new ProcessGHLWebhookUseCase(repository, undefined, suppression).execute({
    payload: {
      type: "OutboundMessage",
      locationId: "location-42",
      id: "provider-message-unknown",
      contactId: CONTACT_ID,
      conversationId: "conversation-42",
      message: { body: "Mensaje outbound sin registro" },
    },
    rawBody: Buffer.from("{}"),
    signature: "test-signature",
  });
  assert.equal(repository.interruption?.trigger, "staff_message");
  assert.equal(suppressions, 1);
});

test("un outbound registrado por 1987 no dispara supresión", async () => {
  const repository: WebhookRepository = {
    process: async () => ({ duplicate: false, tenantId: TENANT_ID, suppressAi: false }),
  };
  let suppressions = 0;
  await new ProcessGHLWebhookUseCase(repository, undefined, { suppress: async () => { suppressions += 1; } }).execute({
    payload: {
      type: "OutboundMessage",
      locationId: "location-42",
      id: "provider-message-1987",
      contactId: CONTACT_ID,
      message: { body: "Respuesta de 1987" },
    },
    rawBody: Buffer.from("{}"),
    signature: "test-signature",
  });
  assert.equal(suppressions, 0);
});

test("una conversación pausada no reactiva IA con un nuevo inbound", async () => {
  let hydrationCalls = 0;
  let downstreamCalls = 0;
  const hydrator = {
    hydrate: async () => {
      hydrationCalls += 1;
      return { conversation: { state: "paused" } } as never;
    },
  };
  const orchestrator = new HydratingInboundConversationOrchestrator(hydrator as never);
  await orchestrator.process({
    tenantId: TENANT_ID,
    contactId: CONTACT_ID,
    messages: [],
    consolidatedText: "nuevo mensaje inbound",
  });
  void downstreamCalls;
  assert.equal(hydrationCalls, 1);
  assert.equal(downstreamCalls, 0);
});

test("la eliminación y reaplicación de human_takeover son eventos independientes del mismo contacto", async () => {
  const repository = new RlsAwareWebhookRepository();
  let suppressions = 0;
  const useCase = new ProcessGHLWebhookUseCase(repository, undefined, {
    suppress: async () => { suppressions += 1; },
  });

  await useCase.execute({
    payload: { eventId: "takeover-apply-1", eventType: "ContactTagUpdate", locationId: "location-42", contactId: CONTACT_ID, tags: ["human_takeover"] },
    rawBody: Buffer.from("apply-1"),
    signature: "test-signature",
  });
  await useCase.execute({
    payload: { eventId: "takeover-remove-1", eventType: "ContactTagUpdate", locationId: "location-42", contactId: CONTACT_ID, tags: [] },
    rawBody: Buffer.from("remove-1"),
    signature: "test-signature",
  });
  await useCase.execute({
    payload: { eventId: "takeover-apply-2", eventType: "ContactTagUpdate", locationId: "location-42", contactId: CONTACT_ID, tags: [{ name: "human_takeover" }] },
    rawBody: Buffer.from("apply-2"),
    signature: "test-signature",
  });

  assert.equal(suppressions, 2);
  assert.equal(repository.state, "paused");
  assert.equal(repository.interruption?.controlTag, "human_takeover");
});

test("takeover pausa, un nuevo inbound no activa IA y el búfer queda consumido sin downstream", async () => {
  const redis = new FakeRedis();
  const repository = new RlsAwareWebhookRepository();
  const mutex = new ContactMutex(redis, 30_000);
  let scheduledCallback: (() => void) | undefined;
  let aiActivations = 0;
  const burstBuffer = new BurstBufferService(redis, mutex, {
    process: async () => {
      if (repository.state !== "paused") aiActivations += 1;
    },
  }, {
    bufferSeconds: 1,
    controlTtlSeconds: 10,
    timerScheduler: (callback) => {
      scheduledCallback = callback;
      return setTimeout(() => undefined, 60_000).unref();
    },
  });
  const useCase = new ProcessGHLWebhookUseCase(
    repository,
    burstBuffer,
    new HumanSuppressionService(burstBuffer, mutex),
  );

  await useCase.execute({
    payload: { eventId: "takeover-sequence-1", eventType: "ContactTagUpdate", locationId: "location-42", contactId: CONTACT_ID, tags: ["human_takeover"] },
    rawBody: Buffer.from("takeover-sequence-1"),
    signature: "test-signature",
  });
  assert.equal(repository.state, "paused");

  await useCase.execute({
    payload: { eventId: "inbound-after-takeover-1", eventType: "InboundMessage", direction: "inbound", locationId: "location-42", contactId: CONTACT_ID, messageType: "WhatsApp", content: "Nuevo mensaje después del takeover" },
    rawBody: Buffer.from("inbound-after-takeover-1"),
    signature: "test-signature",
  });
  assert.ok(scheduledCallback);
  scheduledCallback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(aiActivations, 0);
  assert.equal(redis.lists.get(`buffer:messages:tenant:${TENANT_ID}:contact:${CONTACT_ID}`)?.length ?? 0, 0);
});
