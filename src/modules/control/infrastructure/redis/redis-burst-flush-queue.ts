import { createHash, randomUUID } from "node:crypto";
import type {
  BurstFlushHandler,
  BurstFlushJob,
  BurstFlushQueuePort,
} from "@/modules/control/application/ports/burst-flush-queue.port";
import type { RedisClientPort } from "@/modules/control/application/ports/redis-client.port";

const QUEUE_KEY_PREFIX = "queue:burst-flush:";
const POLL_MS = 250;
const CLAIM_KEY_PREFIX = "queue:burst-flush:claim:";
const CLAIM_TTL_MS = 30_000;
const RETRY_DELAY_MS = 500;

export type RedisBurstFlushQueueOptions = {
  claimTtlMs?: number;
  retryDelayMs?: number;
  clock?: () => number;
};

export class RedisBurstFlushQueue implements BurstFlushQueuePort {
  private poller?: ReturnType<typeof setInterval>;
  private handler?: BurstFlushHandler;
  private polling = false;
  private readonly claimTtlMs: number;
  private readonly retryDelayMs: number;
  private readonly clock: () => number;

  constructor(private readonly redis: RedisClientPort, options: RedisBurstFlushQueueOptions = {}) {
    this.claimTtlMs = options.claimTtlMs ?? CLAIM_TTL_MS;
    this.retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
    this.clock = options.clock ?? (() => Date.now());
  }

  async schedule(job: BurstFlushJob): Promise<void> {
    await this.redis.zadd(queueKey(job.tenantId, job.contactId), job.runAt, encodeJob(job));
  }

  async start(handler: BurstFlushHandler): Promise<void> {
    this.handler = handler;
    if (this.poller) return;
    this.poller = setInterval(() => void this.poll(), POLL_MS);
    this.poller.unref?.();
    await this.poll();
  }

  async stop(): Promise<void> {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
    this.handler = undefined;
  }

  private async poll(): Promise<void> {
    if (this.polling || !this.handler) return;
    this.polling = true;
    try {
      const queueKeys = await this.redis.scan(`${QUEUE_KEY_PREFIX}tenant:*:contact:*`);
      for (const key of queueKeys) {
        const members = await this.redis.zrangebyscore(key, 0, this.clock());
        for (const member of members) {
          const claimToken = randomUUID();
          const claimKey = claimKeyFor(key, member);
          if (await this.redis.set(claimKey, claimToken, "NX", "PX", this.claimTtlMs) !== "OK") continue;
          try {
            await this.handler(decodeJob(member));
            // ACK only after the burst handler completes successfully. Keeping
            // the member until then makes a crashed worker recoverable.
            await this.redis.zrem(key, member);
          } catch {
            // Keep the job durable and make the next attempt explicit. The
            // burst service may also have persisted a fresh timer token.
            await this.redis.replaceSortedSetMember(key, member, this.clock() + this.retryDelayMs, member);
          } finally {
            await this.redis.deleteIfValue(claimKey, claimToken);
          }
        }
      }
    } finally {
      this.polling = false;
    }
  }
}

function encodeJob(job: BurstFlushJob): string {
  return [job.tenantId, job.contactId, job.timerToken, String(job.runAt)].map(encodeURIComponent).join("|");
}

function queueKey(tenantId: string, contactId: string): string {
  const tenant = tenantId.trim();
  const contact = contactId.trim();
  if (!tenant || !contact) throw new Error("Redis burst queue scope cannot be empty");
  return `${QUEUE_KEY_PREFIX}tenant:${encodeURIComponent(tenant)}:contact:${encodeURIComponent(contact)}`;
}

function claimKeyFor(queue: string, member: string): string {
  const digest = createHash("sha256").update(`${queue}|${member}`, "utf8").digest("hex");
  return `${CLAIM_KEY_PREFIX}${digest}`;
}

function decodeJob(member: string): BurstFlushJob {
  const parts = member.split("|").map(decodeURIComponent);
  if (parts.length !== 4 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("Redis burst queue contains an invalid job");
  }
  const runAt = Number(parts[3]);
  if (!Number.isFinite(runAt)) throw new Error("Redis burst queue contains an invalid runAt");
  return { tenantId: parts[0], contactId: parts[1], timerToken: parts[2], runAt };
}
