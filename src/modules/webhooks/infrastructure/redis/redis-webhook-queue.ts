import { createHash, randomUUID } from "node:crypto";
import type {
  WebhookQueueHandler,
  WebhookQueueJob,
  WebhookQueuePort,
} from "@/modules/webhooks/application/ports/webhook-queue.port";
import type { RedisClientPort } from "@/modules/control/application/ports/redis-client.port";

const PENDING_KEY = "queue:webhook:pending";
const CLAIM_KEY_PREFIX = "queue:webhook:claim:";
const POLL_MS = 250;
const CLAIM_TTL_MS = 30_000;

type StoredWebhook = { id: string; rawBody: string; signature: string };

export class RedisWebhookQueue implements WebhookQueuePort {
  private poller?: ReturnType<typeof setInterval>;
  private handler?: WebhookQueueHandler;
  private polling = false;

  constructor(private readonly redis: RedisClientPort) {}

  async enqueue(rawBody: Buffer, signature: string): Promise<boolean> {
    const id = createHash("sha256").update(rawBody).digest("hex");
    const stored: StoredWebhook = { id, rawBody: rawBody.toString("base64"), signature };
    await this.redis.zadd(PENDING_KEY, Date.now(), JSON.stringify(stored));
    return true;
  }

  async start(handler: WebhookQueueHandler): Promise<void> {
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
      const members = await this.redis.zrangebyscore(PENDING_KEY, 0, Date.now());
      for (const member of members) {
        const stored = parseStoredWebhook(member);
        const claimToken = randomUUID();
        const claimed = await this.redis.set(
          `${CLAIM_KEY_PREFIX}${stored.id}`,
          claimToken,
          "NX",
          "PX",
          CLAIM_TTL_MS,
        );
        if (claimed !== "OK") continue;

        try {
          await this.handler({ rawBody: Buffer.from(stored.rawBody, "base64"), signature: stored.signature });
          await this.redis.zrem(PENDING_KEY, member);
        } catch {
          // Leave the member pending. The claim expires and the next poll retries it.
        } finally {
          await this.redis.deleteIfValue(`${CLAIM_KEY_PREFIX}${stored.id}`, claimToken);
        }
      }
    } finally {
      this.polling = false;
    }
  }
}

function parseStoredWebhook(value: string): StoredWebhook {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Redis webhook queue contains an invalid job");
  const job = parsed as Partial<StoredWebhook>;
  if (typeof job.id !== "string" || typeof job.rawBody !== "string" || typeof job.signature !== "string") {
    throw new Error("Redis webhook queue job is missing required fields");
  }
  return job as StoredWebhook;
}
