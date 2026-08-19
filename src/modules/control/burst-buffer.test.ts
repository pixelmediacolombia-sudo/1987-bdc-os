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

  async del(key: string): Promise<number> {
    return this.lists.delete(key) ? 1 : 0;
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
  resolve?: () => void;

  async process(input: ConsolidatedInboundConversation): Promise<void> {
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

  assert.equal(redis.lists.get("buffer:messages:contact-42")?.length, 3);
  assert.equal(scheduledDelayMs, 15_000);
  assert.equal(redis.setCalls.find((call) => call.key === "buffer:timer:contact-42")?.ttl, 15);
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

test("el mutex solo libera el token que lo adquirió", async () => {
  const redis = new FakeRedis();
  const first = new ContactMutex(redis, 30_000);
  const second = new ContactMutex(redis, 30_000);

  assert.equal(await first.acquire("contact-42"), true);
  assert.equal(await second.acquire("contact-42"), false);
  await second.release("contact-42");
  assert.equal(await second.acquire("contact-42"), false);
  await first.release("contact-42");
  assert.equal(await second.acquire("contact-42"), true);
});
