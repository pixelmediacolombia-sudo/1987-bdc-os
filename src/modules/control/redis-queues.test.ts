import assert from "node:assert/strict";
import { test } from "node:test";
import type { RedisClientPort, RedisSetResult } from "@/modules/control/application/ports/redis-client.port";
import { RedisBurstFlushQueue } from "@/modules/control/infrastructure/redis/redis-burst-flush-queue";
import { RedisWebhookQueue } from "@/modules/webhooks/infrastructure/redis/redis-webhook-queue";

class SortedSetRedis implements RedisClientPort {
  readonly values = new Map<string, string>();
  readonly sets = new Map<string, Map<string, number>>();

  async set(key: string, value: string, _mode: "NX", _ttlMode: "EX" | "PX", _ttl: number): Promise<RedisSetResult> {
    if (this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async get(key: string): Promise<string | null> { return this.values.get(key) ?? null; }
  async ttl(key: string): Promise<number> { return this.values.has(key) ? 60 : -2; }

  async scan(match: string): Promise<string[]> {
    const prefix = match.split("*")[0] ?? match;
    return [...this.sets.keys()].filter((key) => key.startsWith(prefix));
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    const set = this.sets.get(key) ?? new Map<string, number>();
    const isNew = !set.has(member);
    set.set(member, score);
    this.sets.set(key, set);
    return isNew ? 1 : 0;
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    return [...(this.sets.get(key) ?? new Map()).entries()]
      .filter(([, score]) => score >= min && score <= max)
      .sort((left, right) => left[1] - right[1])
      .map(([member]) => member);
  }

  async zrem(key: string, member: string): Promise<number> {
    const set = this.sets.get(key);
    if (!set?.delete(member)) return 0;
    return 1;
  }

  async replaceSortedSetMember(key: string, member: string, score: number, replacement: string): Promise<boolean> {
    if ((this.sets.get(key)?.delete(member) ?? false) === false) return false;
    await this.zadd(key, score, replacement);
    return true;
  }

  async moveSortedSetMember(sourceKey: string, destinationKey: string, member: string, score: number, replacement: string): Promise<boolean> {
    if ((this.sets.get(sourceKey)?.delete(member) ?? false) === false) return false;
    await this.zadd(destinationKey, score, replacement);
    return true;
  }

  async del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.values.delete(key)) deleted += 1;
      if (this.sets.delete(key)) deleted += 1;
    }
    return deleted;
  }

  async rpush(): Promise<number> { return 0; }
  async lpush(): Promise<number> { return 0; }
  async lrange(): Promise<string[]> { return []; }
  async drainList(): Promise<string[]> { return []; }

  async deleteIfValue(key: string, expectedValue: string): Promise<boolean> {
    if (this.values.get(key) !== expectedValue) return false;
    this.values.delete(key);
    return true;
  }

  async close(): Promise<void> {}
}

async function poll(queue: unknown): Promise<void> {
  await (queue as { poll: () => Promise<void> }).poll();
}

test("burst queue claims first, ACKs after success, and reprograms a failure", async () => {
  const redis = new SortedSetRedis();
  let now = 0;
  let memberPresentDuringHandler = false;
  let shouldFail = true;
  const queue = new RedisBurstFlushQueue(redis, { clock: () => now });
  await queue.schedule({ tenantId: "tenant-a", contactId: "contact-a", timerToken: "token-a", runAt: 0 });
  await queue.start(async () => {
    memberPresentDuringHandler = [...redis.sets.values()].some((set) => set.size === 1);
    if (shouldFail) {
      shouldFail = false;
      throw new Error("temporary failure");
    }
  });
  assert.equal(memberPresentDuringHandler, true, "burst member must remain until handler success");
  assert.equal([...redis.sets.values()].some((set) => set.size === 1), true, "failed burst must remain durable");

  now = 500;
  await poll(queue);
  assert.equal([...redis.sets.values()].some((set) => set.size === 1), false, "successful burst must be ACKed");
  await queue.stop();
});

test("webhook queue applies exponential backoff and moves terminal failures to DLQ", async () => {
  const redis = new SortedSetRedis();
  let now = 0;
  let calls = 0;
  const queue = new RedisWebhookQueue(redis, { maxAttempts: 2, backoffMs: 100, maxBackoffMs: 500, clock: () => now });
  await queue.enqueue(Buffer.from("signed-payload"), "signature");
  await queue.start(async () => {
    calls += 1;
    throw new Error("provider unavailable");
  });

  const pending = redis.sets.get("queue:webhook:pending");
  assert.equal(calls, 1);
  assert.equal(pending?.size, 1);
  assert.equal([...pending.values()][0], 100, "first retry must use the base backoff");

  now = 100;
  await poll(queue);
  assert.equal(calls, 2);
  assert.equal(redis.sets.get("queue:webhook:pending")?.size ?? 0, 0);
  assert.equal(redis.sets.get("queue:webhook:dead-letter")?.size, 1);
  const deadLetter = [...(redis.sets.get("queue:webhook:dead-letter")?.keys() ?? [])][0] ?? "";
  assert.match(deadLetter, /"attempts":2/);
  assert.match(deadLetter, /provider unavailable/);
  await queue.stop();
});
