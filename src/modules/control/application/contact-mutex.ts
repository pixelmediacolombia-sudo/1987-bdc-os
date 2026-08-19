import { randomUUID } from "node:crypto";
import type { RedisClientPort } from "@/modules/control/application/ports/redis-client.port";

const LOCK_KEY_PREFIX = "lock:contact:";

function scopedKey(tenantId: string, contactId: string): string {
  const tenant = tenantId.trim();
  const contact = contactId.trim();
  if (!tenant) throw new Error("Contact mutex tenantId cannot be empty");
  if (!contact) throw new Error("Contact mutex contactId cannot be empty");
  return `${LOCK_KEY_PREFIX}tenant:${encodeURIComponent(tenant)}:contact:${encodeURIComponent(contact)}`;
}

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

  async acquire(tenantId: string, contactId: string): Promise<boolean> {
    const token = randomUUID();
    const acquired = await this.redis.set(
      scopedKey(tenantId, contactId),
      token,
      "NX",
      "PX",
      this.ttlMs,
    );

    if (acquired !== "OK") return false;
    this.ownershipTokens.set(scopedKey(tenantId, contactId), token);
    return true;
  }

  async release(tenantId: string, contactId: string): Promise<void> {
    const key = scopedKey(tenantId, contactId);
    const token = this.ownershipTokens.get(key);
    if (!token) return;

    try {
      await this.redis.deleteIfValue(key, token);
    } finally {
      this.ownershipTokens.delete(key);
    }
  }
}
