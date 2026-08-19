import type {
  BurstFlushHandler,
  BurstFlushJob,
  BurstFlushQueuePort,
} from "@/modules/control/application/ports/burst-flush-queue.port";
import type { RedisClientPort } from "@/modules/control/application/ports/redis-client.port";

const QUEUE_KEY_PREFIX = "queue:burst-flush:";
const POLL_MS = 250;

export class RedisBurstFlushQueue implements BurstFlushQueuePort {
  private poller?: ReturnType<typeof setInterval>;
  private handler?: BurstFlushHandler;
  private polling = false;

  constructor(private readonly redis: RedisClientPort) {}

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
        const members = await this.redis.zrangebyscore(key, 0, Date.now());
        for (const member of members) {
          if (await this.redis.zrem(key, member) !== 1) continue;
          try {
            await this.handler(decodeJob(member));
          } catch {
            // BurstBufferService persists and reschedules its retry before rethrowing.
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

function decodeJob(member: string): BurstFlushJob {
  const parts = member.split("|").map(decodeURIComponent);
  if (parts.length !== 4 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error("Redis burst queue contains an invalid job");
  }
  const runAt = Number(parts[3]);
  if (!Number.isFinite(runAt)) throw new Error("Redis burst queue contains an invalid runAt");
  return { tenantId: parts[0], contactId: parts[1], timerToken: parts[2], runAt };
}
