import { randomUUID } from "node:crypto";
import type { InboundMessage } from "@/modules/webhooks/domain/ghl-webhook-event";
import { ContactMutex } from "@/modules/control/application/contact-mutex";
import type { BurstBufferPort } from "@/modules/control/application/ports/burst-buffer.port";
import type {
  BufferedInboundMessage,
  InboundConversationOrchestratorPort,
} from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";
import type { RedisClientPort } from "@/modules/control/application/ports/redis-client.port";

const MESSAGE_KEY_PREFIX = "buffer:messages:";
const TIMER_KEY_PREFIX = "buffer:timer:";
const RETRY_DELAY_MS = 100;

export type BurstBufferTimer = ReturnType<typeof setTimeout>;
export type BurstBufferTimerScheduler = (callback: () => void, delayMs: number) => BurstBufferTimer;
export type BurstBufferLogger = {
  info(message: string): void;
  error(message: string): void;
};

export type BurstBufferOptions = {
  bufferSeconds?: number;
  timerScheduler?: BurstBufferTimerScheduler;
  logger?: BurstBufferLogger;
};

type StoredMessage = BufferedInboundMessage & { tenantId: string };

const defaultLogger: BurstBufferLogger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

export class BurstBufferService implements BurstBufferPort {
  private readonly bufferSeconds: number;
  private readonly timerScheduler: BurstBufferTimerScheduler;
  private readonly logger: BurstBufferLogger;

  constructor(
    private readonly redis: RedisClientPort,
    private readonly mutex: ContactMutex,
    private readonly orchestrator: InboundConversationOrchestratorPort,
    options: BurstBufferOptions = {},
  ) {
    this.bufferSeconds = options.bufferSeconds ?? readPositiveNumberEnv("BURST_BUFFER_SECONDS", 15);
    if (!Number.isFinite(this.bufferSeconds) || this.bufferSeconds <= 0) {
      throw new Error("BURST_BUFFER_SECONDS must be a positive number");
    }
    this.timerScheduler = options.timerScheduler ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.logger = options.logger ?? defaultLogger;
  }

  async add(message: InboundMessage, tenantId: string): Promise<void> {
    const contactId = this.requireContactId(message.contactId);
    const normalizedTenantId = this.requireTenantId(tenantId);
    const storedMessage: StoredMessage = {
      ...message,
      tenantId: normalizedTenantId,
      receivedAt: new Date().toISOString(),
    };
    const messageKey = this.messageKey(contactId);
    const timerKey = this.timerKey(contactId);

    const count = await this.redis.rpush(messageKey, JSON.stringify(storedMessage));
    this.logger.info(`Burst buffer accumulated message for contact ${contactId}; count=${count}`);

    const timerToken = randomUUID();
    const timerCreated = await this.redis.set(timerKey, timerToken, "NX", "EX", this.bufferSeconds);
    if (timerCreated !== "OK") return;

    this.logger.info(`Burst buffer timer scheduled for contact ${contactId}; delay=${this.bufferSeconds}s`);
    this.schedule(contactId, timerToken, this.bufferSeconds * 1000);
  }

  private schedule(contactId: string, timerToken: string, delayMs: number): void {
    this.timerScheduler(() => {
      void this.flushAfterTimer(contactId, timerToken).catch((error: unknown) => {
        this.logger.error(
          `Burst buffer flush failed for contact ${contactId}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      });
    }, delayMs);
  }

  private async flushAfterTimer(contactId: string, timerToken: string): Promise<void> {
    const currentTimerToken = await this.redis.get(this.timerKey(contactId));
    if (currentTimerToken && currentTimerToken !== timerToken) return;

    const acquired = await this.mutex.acquire(contactId);
    if (!acquired) {
      this.logger.info(`Burst buffer mutex busy for contact ${contactId}; retrying in ${RETRY_DELAY_MS}ms`);
      this.schedule(contactId, timerToken, RETRY_DELAY_MS);
      return;
    }
    this.logger.info(`Burst buffer mutex acquired for contact ${contactId}`);

    try {
      const messageKey = this.messageKey(contactId);
      const serializedMessages = await this.redis.drainList(messageKey);
      if (serializedMessages.length === 0) {
        await this.redis.deleteIfValue(this.timerKey(contactId), timerToken);
        return;
      }

      const messages = serializedMessages
        .map((serialized) => this.parseStoredMessage(serialized))
        .sort((left, right) => left.receivedAt.localeCompare(right.receivedAt));
      await this.redis.del(messageKey);
      try {
        const tenantIds = new Set(messages.map((item) => item.tenantId));
        if (tenantIds.size !== 1) throw new Error("Burst buffer contains multiple tenant IDs for one contact");
        await this.orchestrator.process({
          tenantId: messages[0].tenantId,
          contactId,
          messages,
          consolidatedText: messages.map((item) => item.content).join("\n"),
        });
      } catch (error) {
        await this.redis.lpush(messageKey, ...serializedMessages.reverse());
        const retryToken = randomUUID();
        if (await this.redis.set(this.timerKey(contactId), retryToken, "NX", "EX", this.bufferSeconds) === "OK") {
          this.schedule(contactId, retryToken, this.bufferSeconds * 1000);
        }
        throw error;
      }

      await this.redis.deleteIfValue(this.timerKey(contactId), timerToken);
      this.logger.info(`Burst buffer consolidated ${messages.length} messages for contact ${contactId}`);
    } finally {
      await this.mutex.release(contactId);
    }
  }

  private parseStoredMessage(serialized: string): StoredMessage {
    const parsed: unknown = JSON.parse(serialized);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Burst buffer contains an invalid message");
    }

    const message = parsed as Partial<StoredMessage>;
    if (typeof message.contactId !== "string" || typeof message.content !== "string" || typeof message.receivedAt !== "string" || typeof message.tenantId !== "string") {
      throw new Error("Burst buffer message is missing required fields");
    }
    return message as StoredMessage;
  }

  private requireContactId(contactId: string): string {
    const normalized = contactId.trim();
    if (!normalized) throw new Error("Inbound message contactId cannot be empty");
    return normalized;
  }

  private requireTenantId(tenantId: string): string {
    const normalized = tenantId.trim();
    if (!normalized) throw new Error("Inbound message tenantId cannot be empty");
    return normalized;
  }

  private messageKey(contactId: string): string {
    return `${MESSAGE_KEY_PREFIX}${contactId}`;
  }

  private timerKey(contactId: string): string {
    return `${TIMER_KEY_PREFIX}${contactId}`;
  }
}

function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}
