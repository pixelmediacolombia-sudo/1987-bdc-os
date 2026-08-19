export type RedisSetResult = "OK" | null;

export interface RedisClientPort {
  set(
    key: string,
    value: string,
    mode: "NX",
    ttlMode: "EX" | "PX",
    ttl: number,
  ): Promise<RedisSetResult>;
  get(key: string): Promise<string | null>;
  ttl(key: string): Promise<number>;
  scan(match: string): Promise<string[]>;
  zadd(key: string, score: number, member: string): Promise<number>;
  zrangebyscore(key: string, min: number, max: number): Promise<string[]>;
  zrem(key: string, member: string): Promise<number>;
  del(...keys: string[]): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  drainList(key: string): Promise<string[]>;
  deleteIfValue(key: string, expectedValue: string): Promise<boolean>;
  close(): Promise<void>;
}
