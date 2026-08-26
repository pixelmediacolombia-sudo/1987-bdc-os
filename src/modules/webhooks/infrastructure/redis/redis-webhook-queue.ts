import { createHash, randomUUID } from "node:crypto";
import type {
  WebhookQueueHandler,
  WebhookQueuePort,
} from "@/modules/webhooks/application/ports/webhook-queue.port";
import type { RedisClientPort } from "@/modules/control/application/ports/redis-client.port";

const PENDING_KEY = "queue:webhook:pending";
const CLAIM_KEY_PREFIX = "queue:webhook:claim:";
const DEAD_LETTER_KEY = "queue:webhook:dead-letter";
const POLL_MS = 250;
const CLAIM_TTL_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 1_000;
const DEFAULT_MAX_BACKOFF_MS = 60_000;

type StoredWebhook = { id: string; rawBody: string; signature: string; attempts: number };
type RedisWebhookQueueOptions = {
  maxAttempts?: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  claimTtlMs?: number;
  clock?: () => number;
};

export class RedisWebhookQueue implements WebhookQueuePort {
  private poller?: ReturnType<typeof setInterval>;
  private handler?: WebhookQueueHandler;
  private polling = false;

  private readonly maxAttempts: number;
  private readonly backoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly claimTtlMs: number;
  private readonly clock: () => number;

  constructor(private readonly redis: RedisClientPort, options: RedisWebhookQueueOptions = {}) {
    this.maxAttempts = options.maxAttempts ?? readPositiveIntegerEnv("WEBHOOK_QUEUE_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS);
    this.backoffMs = options.backoffMs ?? readPositiveIntegerEnv("WEBHOOK_QUEUE_BACKOFF_MS", DEFAULT_BACKOFF_MS);
    this.maxBackoffMs = options.maxBackoffMs ?? readPositiveIntegerEnv("WEBHOOK_QUEUE_MAX_BACKOFF_MS", DEFAULT_MAX_BACKOFF_MS);
    this.claimTtlMs = options.claimTtlMs ?? CLAIM_TTL_MS;
    this.clock = options.clock ?? (() => Date.now());
    if (this.maxAttempts < 1 || this.backoffMs < 1 || this.maxBackoffMs < this.backoffMs || this.claimTtlMs < 1) {
      throw new Error("Redis webhook queue options are invalid");
    }
  }

  async enqueue(rawBody: Buffer, signature: string): Promise<boolean> {
    const id = createHash("sha256").update(rawBody).digest("hex");
    const stored: StoredWebhook = { id, rawBody: rawBody.toString("base64"), signature, attempts: 0 };
    await this.redis.zadd(PENDING_KEY, this.clock(), JSON.stringify(stored));
    return true;
  }

  async start(handler: WebhookQueueHandler): Promise<void> {
    this.handler = handler;
    if (this.poller) return;
    this.poller = setInterval(() => {
      void this.poll().catch((error: unknown) => {
        console.error(`GHL webhook queue poll failed: ${error instanceof Error ? error.message : "unknown error"}`);
      });
    }, POLL_MS);
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
          this.claimTtlMs,
        );
        if (claimed !== "OK") continue;

        try {
          await this.handler({ rawBody: Buffer.from(stored.rawBody, "base64"), signature: stored.signature });
          // ACK only after the consumer succeeds.
          await this.redis.zrem(PENDING_KEY, member);
        } catch (error) {
          const attempts = stored.attempts + 1;
          const failure = error instanceof Error ? error.message.slice(0, 500) : "unknown error";
          console.error(`GHL webhook processing failed id=${stored.id} attempt=${attempts}/${this.maxAttempts}: ${failure}`);
          const replacement = JSON.stringify({ ...stored, attempts });
          if (attempts >= this.maxAttempts) {
            const deadLetter = JSON.stringify({
              ...stored,
              attempts,
              deadLetteredAt: new Date(this.clock()).toISOString(),
              lastError: failure,
            });
            await this.redis.moveSortedSetMember(PENDING_KEY, DEAD_LETTER_KEY, member, this.clock(), deadLetter);
            console.error(`GHL webhook moved to dead letter id=${stored.id} attempts=${attempts}`);
          } else {
            const delay = Math.min(this.maxBackoffMs, this.backoffMs * (2 ** (attempts - 1)));
            await this.redis.replaceSortedSetMember(PENDING_KEY, member, this.clock() + delay, replacement);
          }
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
  if (job.attempts !== undefined && (!Number.isInteger(job.attempts) || job.attempts < 0)) {
    throw new Error("Redis webhook queue job has invalid attempts");
  }
  return { ...job, attempts: job.attempts ?? 0 } as StoredWebhook;
}

function readPositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
