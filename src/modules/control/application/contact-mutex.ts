import { randomUUID } from "node:crypto";
import type { RedisClientPort } from "@/modules/control/application/ports/redis-client.port";

const LOCK_KEY_PREFIX = "lock:contact:";

export class ContactMutex {
  private readonly ownershipTokens = new Map<string, string>();

  constructor(
    private readonly redis: RedisClientPort,
    private readonly ttlMs = 30_000,
  ) {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("Contact mutex TTL must be a positive integer");
    }
  }

  async acquire(contactId: string): Promise<boolean> {
    const token = randomUUID();
    const acquired = await this.redis.set(
      this.key(contactId),
      token,
      "NX",
      "PX",
      this.ttlMs,
    );

    if (acquired !== "OK") return false;
    this.ownershipTokens.set(contactId, token);
    return true;
  }

  async release(contactId: string): Promise<void> {
    const token = this.ownershipTokens.get(contactId);
    if (!token) return;

    try {
      await this.redis.deleteIfValue(this.key(contactId), token);
    } finally {
      this.ownershipTokens.delete(contactId);
    }
  }

  private key(contactId: string): string {
    return `${LOCK_KEY_PREFIX}${contactId}`;
  }
}
