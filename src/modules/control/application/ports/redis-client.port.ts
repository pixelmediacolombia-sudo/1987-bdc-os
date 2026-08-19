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
  del(key: string): Promise<number>;
  rpush(key: string, ...values: string[]): Promise<number>;
  lpush(key: string, ...values: string[]): Promise<number>;
  lrange(key: string, start: number, stop: number): Promise<string[]>;
  drainList(key: string): Promise<string[]>;
  deleteIfValue(key: string, expectedValue: string): Promise<boolean>;
  close(): Promise<void>;
}
