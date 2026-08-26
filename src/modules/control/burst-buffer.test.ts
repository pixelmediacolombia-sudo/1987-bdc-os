import assert from "node:assert/strict";
import { test } from "node:test";
import { ContactMutex } from "@/modules/control/application/contact-mutex";
import { BurstBufferService, type BurstBufferLogger } from "@/modules/control/application/burst-buffer.service";
import type {
  ConsolidatedInboundConversation,
  InboundConversationOrchestratorPort,
} from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";
import type {
  RedisClientPort,
  RedisSetResult,
} from "@/modules/control/application/ports/redis-client.port";
import type { InboundMessage } from "@/modules/webhooks/domain/ghl-webhook-event";

class FakeRedis implements RedisClientPort {
  readonly lists = new Map<string, string[]>();
  readonly values = new Map<string, string>();
  readonly setCalls: Array<{ key: string; ttlMode: "EX" | "PX"; ttl: number }> = [];

  async set(
    key: string,
    value: string,
    _mode: "NX",
    ttlMode: "EX" | "PX",
    ttl: number,
  ): Promise<RedisSetResult> {
    this.setCalls.push({ key, ttlMode, ttl });
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

  async del(key: string): Promise<number> {
    let deleted = this.lists.delete(key) ? 1 : 0;
    if (this.values.delete(key)) deleted += 1;
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

  async close(): Promise<void> {
    return Promise.resolve();
  }
}

class CapturingOrchestrator implements InboundConversationOrchestratorPort {
  result?: ConsolidatedInboundConversation;
  calls = 0;
  resolve?: () => void;

  async process(input: ConsolidatedInboundConversation): Promise<void> {
    this.calls += 1;
    this.result = input;
    this.resolve?.();
  }
}

function createMessage(externalId: string, content: string): InboundMessage {
  return {
    externalId,
    contactId: "contact-42",
    conversationId: "conversation-42",
    channel: "sms",
    content,
    semanticHash: `hash-${externalId}`,
  };
}

test("consolida tres fragmentos después de un búfer exacto de 15 segundos", async () => {
  const redis = new FakeRedis();
  const mutex = new ContactMutex(redis, 30_000);
  const orchestrator = new CapturingOrchestrator();
  const logs: string[] = [];
  const logger: BurstBufferLogger = {
    info: (message) => logs.push(message),
    error: (message) => logs.push(`ERROR ${message}`),
  };
  let scheduledCallback: (() => void) | undefined;
  let scheduledDelayMs = 0;
  const service = new BurstBufferService(redis, mutex, orchestrator, {
    bufferSeconds: 15,
    controlTtlSeconds: 90,
    logger,
    timerScheduler: (callback, delayMs) => {
      scheduledCallback = callback;
      scheduledDelayMs = delayMs;
      return setTimeout(() => undefined, 60_000).unref();
    },
  });

  await service.add(createMessage("message-1", "Hola"), "tenant-42");
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await service.add(createMessage("message-2", "Me interesa la Tacoma"), "tenant-42");
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  await service.add(createMessage("message-3", "¿La tienen manual?"), "tenant-42");

  assert.equal(redis.lists.get("buffer:messages:tenant:tenant-42:contact:contact-42")?.length, 3);
  assert.ok(scheduledDelayMs >= 14_900 && scheduledDelayMs <= 15_000, `buffer delay=${scheduledDelayMs}ms`);
  assert.equal(redis.setCalls.find((call) => call.key === "buffer:timer:tenant:tenant-42:contact:contact-42")?.ttl, 90);
  assert.match(logs.join("\n"), /count=3/);
  assert.match(logs.join("\n"), /delay=15s/);

  const flushed = new Promise<void>((resolve) => {
    orchestrator.resolve = resolve;
  });
  assert.ok(scheduledCallback);
  scheduledCallback();
  await flushed;
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(orchestrator.result?.messages.map((message) => message.content), [
    "Hola",
    "Me interesa la Tacoma",
    "¿La tienen manual?",
  ]);
  assert.equal(orchestrator.result?.tenantId, "tenant-42");
  assert.equal(orchestrator.result?.consolidatedText, "Hola\nMe interesa la Tacoma\n¿La tienen manual?");
  assert.match(logs.join("\n"), /mutex acquired/);
  assert.match(logs.join("\n"), /consolidated 3 messages/);
});

test("reintentar el mismo webhook no duplica el mensaje y repara el timer durable", async () => {
  const redis = new FakeRedis();
  const mutex = new ContactMutex(redis, 30_000);
  const orchestrator = new CapturingOrchestrator();
  const logs: string[] = [];
  const scheduled: Array<{ callback: () => void; delayMs: number }> = [];
  const durableJobs: unknown[] = [];
  const service = new BurstBufferService(redis, mutex, orchestrator, {
    bufferSeconds: 15,
    controlTtlSeconds: 90,
    durableQueue: {
      schedule: async (job) => { durableJobs.push(job); },
      start: async () => undefined,
      stop: async () => undefined,
    },
    logger: { info: (message) => logs.push(message), error: (message) => logs.push(`ERROR ${message}`) },
    timerScheduler: (callback, delayMs) => {
      scheduled.push({ callback, delayMs });
      return setTimeout(() => undefined, 60_000).unref();
    },
  });

  await service.add(createMessage("retryable-webhook", "Hola"), "tenant-42");
  await service.add(createMessage("retryable-webhook", "Hola"), "tenant-42");

  assert.equal(redis.lists.get("buffer:messages:tenant:tenant-42:contact:contact-42")?.length, 1);
  assert.equal(scheduled.length, 0);
  assert.equal(durableJobs.length, 2);
  assert.match(logs.join("\n"), /deduplicated message/);
  assert.match(logs.join("\n"), /ensuring durable schedule/);
});

test("el mutex solo libera el token que lo adquirió", async () => {
  const redis = new FakeRedis();
  const first = new ContactMutex(redis, 30_000);
  const second = new ContactMutex(redis, 30_000);

  assert.equal(await first.acquire("tenant-42", "contact-42"), true);
  assert.equal(await second.acquire("tenant-42", "contact-42"), false);
  await second.release("tenant-42", "contact-42");
  assert.equal(await second.acquire("tenant-42", "contact-42"), false);
  await first.release("tenant-42", "contact-42");
  assert.equal(await second.acquire("tenant-42", "contact-42"), true);
  assert.equal(await first.acquire("tenant-43", "contact-42"), true);
});

test("recupera runAt tras reinicio y hace un único flush al segundo 15", async () => {
  const redis = new FakeRedis();
  const mutex = new ContactMutex(redis, 30_000);
  const orchestrator = new CapturingOrchestrator();
  let now = 0;
  const firstTimers: Array<{ callback: () => void; delayMs: number }> = [];
  const first = new BurstBufferService(redis, mutex, orchestrator, {
    bufferSeconds: 15,
    controlTtlSeconds: 90,
    clock: () => now,
    timerScheduler: (callback, delayMs) => {
      firstTimers.push({ callback, delayMs });
      return setTimeout(() => undefined, 60_000).unref();
    },
  });
  await first.add(createMessage("restart-1", "Hola"), "tenant-42");
  assert.equal(firstTimers[0]?.delayMs, 15_000);

  now = 5_000;
  const recoveredTimers: Array<{ callback: () => void; delayMs: number }> = [];
  const recovered = new BurstBufferService(redis, mutex, orchestrator, {
    bufferSeconds: 15,
    controlTtlSeconds: 90,
    clock: () => now,
    timerScheduler: (callback, delayMs) => {
      recoveredTimers.push({ callback, delayMs });
      return setTimeout(() => undefined, 60_000).unref();
    },
  });
  await recovered.recoverPendingTimers();
  assert.equal(recoveredTimers[0]?.delayMs, 10_000);

  now = 15_000;
  recoveredTimers[0]?.callback();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(orchestrator.calls, 1);
  assert.equal(redis.lists.get("buffer:messages:tenant:tenant-42:contact:contact-42")?.length ?? 0, 0);
});

test("al fallar el orquestador reemplaza el token y permite el retry", async () => {
  const redis = new FakeRedis();
  const mutex = new ContactMutex(redis, 30_000);
  let failures = 0;
  const orchestrator: InboundConversationOrchestratorPort = {
    process: async () => {
      failures += 1;
      if (failures === 1) throw new Error("orchestrator unavailable");
    },
  };
  const timers: Array<() => void> = [];
  const service = new BurstBufferService(redis, mutex, orchestrator, {
    bufferSeconds: 1,
    controlTtlSeconds: 10,
    timerScheduler: (callback) => {
      timers.push(callback);
      return setTimeout(() => undefined, 60_000).unref();
    },
  });
  await service.add(createMessage("retry-1", "Hola"), "tenant-42");
  timers[0]?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(timers.length, 2);
  timers[1]?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(failures, 2);
  assert.equal(redis.lists.get("buffer:messages:tenant:tenant-42:contact:contact-42")?.length ?? 0, 0);
});
