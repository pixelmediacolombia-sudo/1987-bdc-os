import Redis from "ioredis";
import type { RedisClientPort, RedisSetResult } from "@/modules/control/application/ports/redis-client.port";

const DELETE_IF_VALUE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;
const DRAIN_LIST_SCRIPT = `
local messages = redis.call('LRANGE', KEYS[1], 0, -1)
redis.call('DEL', KEYS[1])
return messages
`;
const REPLACE_SORTED_SET_MEMBER_SCRIPT = `
if redis.call('ZREM', KEYS[1], ARGV[1]) == 1 then
  redis.call('ZADD', KEYS[1], ARGV[2], ARGV[3])
  return 1
end
return 0
`;
const MOVE_SORTED_SET_MEMBER_SCRIPT = `
if redis.call('ZREM', KEYS[1], ARGV[1]) == 1 then
  redis.call('ZADD', KEYS[2], ARGV[2], ARGV[3])
  return 1
end
return 0
`;

export class IoredisClient implements RedisClientPort {
  private readonly client: Redis;

  constructor(redisUrl: string) {
    if (!redisUrl.trim()) throw new Error("Missing required environment variable: REDIS_URL");
    this.client = new Redis(redisUrl, {
      lazyConnect: true,
      connectTimeout: 5_000,
      maxRetriesPerRequest: 1,
      retryStrategy: (attempt) => (attempt > 3 ? null : Math.min(attempt * 250, 1_000)),
    });
    this.client.on("error", () => undefined);
  }

  async set(
    key: string,
    value: string,
    mode: "NX",
    ttlMode: "EX" | "PX",
    ttl: number,
  ): Promise<RedisSetResult> {
    if (ttlMode === "EX") {
      return this.client.set(key, value, "EX", ttl, mode);
    }
    return this.client.set(key, value, "PX", ttl, mode);
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async scan(match: string): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";
    do {
      const [nextCursor, batch] = await this.client.scan(cursor, "MATCH", match, "COUNT", 100);
      cursor = nextCursor;
      keys.push(...batch);
    } while (cursor !== "0");
    return keys;
  }

  async zadd(key: string, score: number, member: string): Promise<number> {
    return this.client.zadd(key, score, member);
  }

  async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
    return this.client.zrangebyscore(key, min, max);
  }

  async zrem(key: string, member: string): Promise<number> {
    return this.client.zrem(key, member);
  }

  async replaceSortedSetMember(key: string, member: string, score: number, replacement: string): Promise<boolean> {
    const replaced = await this.client.eval(REPLACE_SORTED_SET_MEMBER_SCRIPT, 1, key, member, score, replacement);
    return Number(replaced) === 1;
  }

  async moveSortedSetMember(sourceKey: string, destinationKey: string, member: string, score: number, replacement: string): Promise<boolean> {
    const moved = await this.client.eval(MOVE_SORTED_SET_MEMBER_SCRIPT, 2, sourceKey, destinationKey, member, score, replacement);
    return Number(moved) === 1;
  }

  async del(...keys: string[]): Promise<number> {
    return this.client.del(...keys);
  }

  async rpush(key: string, ...values: string[]): Promise<number> {
    return this.client.rpush(key, ...values);
  }

  async lpush(key: string, ...values: string[]): Promise<number> {
    return this.client.lpush(key, ...values);
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return this.client.lrange(key, start, stop);
  }

  async drainList(key: string): Promise<string[]> {
    const drained = await this.client.eval(DRAIN_LIST_SCRIPT, 1, key);
    if (!Array.isArray(drained)) throw new Error("Redis returned an invalid burst buffer list");
    return drained.map((item) => String(item));
  }

  async deleteIfValue(key: string, expectedValue: string): Promise<boolean> {
    const deleted = await this.client.eval(DELETE_IF_VALUE_SCRIPT, 1, key, expectedValue);
    return Number(deleted) === 1;
  }

  async close(): Promise<void> {
    if (this.client.status === "end") return;
    await this.client.quit();
  }
}

export function createIoredisClientFromEnv(): IoredisClient {
  const redisUrl = process.env.REDIS_URL?.trim();
  if (!redisUrl) throw new Error("Missing required environment variable: REDIS_URL");
  return new IoredisClient(redisUrl);
}
