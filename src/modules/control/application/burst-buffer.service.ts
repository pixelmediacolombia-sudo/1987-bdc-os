import { randomUUID } from "node:crypto";
import type { InboundMessage } from "@/modules/webhooks/domain/ghl-webhook-event";
import { ContactMutex } from "@/modules/control/application/contact-mutex";
import type {
  BurstBufferCancellationPort,
  BurstBufferPort,
} from "@/modules/control/application/ports/burst-buffer.port";
import type {
  BufferedInboundMessage,
  InboundConversationOrchestratorPort,
} from "@/modules/control/application/ports/inbound-conversation-orchestrator.port";
import type { RedisClientPort } from "@/modules/control/application/ports/redis-client.port";
import type { BurstFlushQueuePort } from "@/modules/control/application/ports/burst-flush-queue.port";

const MESSAGE_KEY_PREFIX = "buffer:messages:";
const TIMER_KEY_PREFIX = "buffer:timer:";
const RETRY_DELAY_MS = 100;
const DEFAULT_CONTROL_TTL_SECONDS = 90;

export type BurstBufferTimer = ReturnType<typeof setTimeout>;
export type BurstBufferTimerScheduler = (callback: () => void, delayMs: number) => BurstBufferTimer;
export type BurstBufferLogger = {
  info(message: string): void;
  error(message: string): void;
};

export type BurstBufferOptions = {
  bufferSeconds?: number;
  controlTtlSeconds?: number;
  timerScheduler?: BurstBufferTimerScheduler;
  durableQueue?: BurstFlushQueuePort;
  clock?: () => number;
  logger?: BurstBufferLogger;
};

type StoredMessage = BufferedInboundMessage & { tenantId: string };
type TimerState = { token: string; runAt: number };

const defaultLogger: BurstBufferLogger = {
  info: (message) => console.info(message),
  error: (message) => console.error(message),
};

export class BurstBufferService implements BurstBufferPort, BurstBufferCancellationPort {
  private readonly bufferSeconds: number;
  private readonly controlTtlSeconds: number;
  private readonly timerScheduler: BurstBufferTimerScheduler;
  private readonly durableQueue?: BurstFlushQueuePort;
  private readonly clock: () => number;
  private readonly logger: BurstBufferLogger;
  private readonly scheduledTimers = new Map<string, Set<BurstBufferTimer>>();

  constructor(
    private readonly redis: RedisClientPort,
    private readonly mutex: ContactMutex,
    private readonly orchestrator: InboundConversationOrchestratorPort,
    options: BurstBufferOptions = {},
  ) {
    this.bufferSeconds = options.bufferSeconds ?? readPositiveNumberEnv("BURST_BUFFER_SECONDS", 15);
    this.controlTtlSeconds = options.controlTtlSeconds ?? readPositiveNumberEnv("BURST_BUFFER_CONTROL_TTL_SECONDS", DEFAULT_CONTROL_TTL_SECONDS);
    if (!Number.isFinite(this.bufferSeconds) || this.bufferSeconds <= 0) {
      throw new Error("BURST_BUFFER_SECONDS must be a positive number");
    }
    if (!Number.isFinite(this.controlTtlSeconds) || this.controlTtlSeconds < this.bufferSeconds * 2) {
      throw new Error("BURST_BUFFER_CONTROL_TTL_SECONDS must be at least twice BURST_BUFFER_SECONDS");
    }
    this.timerScheduler = options.timerScheduler ?? ((callback, delayMs) => setTimeout(callback, delayMs));
    this.durableQueue = options.durableQueue;
    this.clock = options.clock ?? (() => Date.now());
    this.logger = options.logger ?? defaultLogger;
  }

  async start(): Promise<void> {
    await this.durableQueue?.start((job) => this.flushAfterTimer(job.tenantId, job.contactId, job.timerToken));
  }

  async stop(): Promise<void> {
    await this.durableQueue?.stop();
  }

  async add(message: InboundMessage, tenantId: string): Promise<void> {
    const contactId = this.requireContactId(message.contactId);
    const normalizedTenantId = this.requireTenantId(tenantId);
    const storedMessage: StoredMessage = {
      ...message,
      tenantId: normalizedTenantId,
      receivedAt: new Date(this.clock()).toISOString(),
    };
    const messageKey = this.messageKey(normalizedTenantId, contactId);
    const timerKey = this.timerKey(normalizedTenantId, contactId);

    const bufferedMessages = await this.redis.lrange(messageKey, 0, -1);
    const duplicate = bufferedMessages.some((serialized) => hasExternalId(serialized, message.externalId));
    const count = duplicate
      ? bufferedMessages.length
      : await this.redis.rpush(messageKey, JSON.stringify(storedMessage));
    this.logger.info(
      duplicate
        ? `Burst buffer deduplicated message for contact ${contactId}; count=${count}`
        : `Burst buffer accumulated message for contact ${contactId}; count=${count}`,
    );

    const existingTimerValue = await this.redis.get(timerKey);
    if (existingTimerValue) {
      const existingTimer = parseTimer(existingTimerValue);
      if (!existingTimer) throw new Error("Burst buffer timer contains an invalid state");
      if (this.durableQueue) {
        this.logger.info(`Burst buffer timer already exists for tenant ${normalizedTenantId}, contact ${contactId}; ensuring durable schedule`);
        await this.scheduleTimer(normalizedTenantId, contactId, existingTimer.token, existingTimer.runAt);
      }
      return;
    }

    const timerToken = randomUUID();
    const runAt = this.clock() + this.bufferSeconds * 1000;
    const timerValue = serializeTimer({ token: timerToken, runAt });
    const timerCreated = await this.redis.set(timerKey, timerValue, "NX", "EX", this.controlTtlSeconds);
    if (timerCreated !== "OK") return;

    this.logger.info(`Burst buffer timer scheduled for tenant ${normalizedTenantId}, contact ${contactId}; delay=${this.bufferSeconds}s controlTtl=${this.controlTtlSeconds}s`);
    await this.scheduleTimer(normalizedTenantId, contactId, timerToken, runAt);
  }

  async cancel(tenantId: string, contactId: string): Promise<void> {
    const normalizedTenantId = this.requireTenantId(tenantId);
    const normalizedContactId = this.requireContactId(contactId);
    const scope = this.scopeKey(normalizedTenantId, normalizedContactId);
    const timers = this.scheduledTimers.get(scope);
    if (timers) {
      for (const timer of timers) clearTimeout(timer);
      this.scheduledTimers.delete(scope);
    }

    await this.redis.del(this.messageKey(normalizedTenantId, normalizedContactId), this.timerKey(normalizedTenantId, normalizedContactId));
    this.logger.info(`Burst buffer cancelled for tenant ${normalizedTenantId}, contact ${normalizedContactId}`);
  }

  async recoverPendingTimers(): Promise<void> {
    const timerKeys = await this.redis.scan(`${TIMER_KEY_PREFIX}tenant:*:contact:*`);
    for (const timerKey of timerKeys) {
      const parsed = parseScopedKey(timerKey, TIMER_KEY_PREFIX);
      if (!parsed) continue;
      const rawState = await this.redis.get(timerKey);
      const state = rawState ? parseTimer(rawState) : undefined;
      if (!state) continue;
      await this.scheduleTimer(parsed.tenantId, parsed.contactId, state.token, state.runAt);
      this.logger.info(`Burst buffer timer recovered after restart for tenant ${parsed.tenantId}, contact ${parsed.contactId}; remaining=${Math.max(0, state.runAt - this.clock())}ms`);
    }
  }

  private async scheduleTimer(tenantId: string, contactId: string, timerToken: string, runAt: number): Promise<void> {
    if (this.durableQueue) {
      await this.durableQueue.schedule({ tenantId, contactId, timerToken, runAt });
      return;
    }
    this.schedule(tenantId, contactId, timerToken, Math.max(0, runAt - this.clock()));
  }

  private schedule(tenantId: string, contactId: string, timerToken: string, delayMs: number): void {
    const scope = this.scopeKey(tenantId, contactId);
    let timer: BurstBufferTimer;
    timer = this.timerScheduler(() => {
      this.scheduledTimers.get(scope)?.delete(timer);
      void this.flushAfterTimer(tenantId, contactId, timerToken).catch((error: unknown) => {
        this.logger.error(
          `Burst buffer flush failed for tenant ${tenantId}, contact ${contactId}: ${error instanceof Error ? error.message : "unknown error"}`,
        );
      });
    }, delayMs);
    const timers = this.scheduledTimers.get(scope) ?? new Set<BurstBufferTimer>();
    timers.add(timer);
    this.scheduledTimers.set(scope, timers);
  }

  private async flushAfterTimer(tenantId: string, contactId: string, timerToken: string): Promise<void> {
    const currentTimerValue = await this.redis.get(this.timerKey(tenantId, contactId));
    const currentTimer = currentTimerValue ? parseTimer(currentTimerValue) : undefined;
    if (!currentTimer || currentTimer.token !== timerToken) return;

    const acquired = await this.mutex.acquire(tenantId, contactId);
    if (!acquired) {
      this.logger.info(`Burst buffer mutex busy for tenant ${tenantId}, contact ${contactId}; retrying in ${RETRY_DELAY_MS}ms`);
      const retryRunAt = this.clock() + RETRY_DELAY_MS;
      const currentValue = serializeTimer(currentTimer);
      const retryValue = serializeTimer({ token: timerToken, runAt: retryRunAt });
      if (await this.redis.deleteIfValue(this.timerKey(tenantId, contactId), currentValue)) {
        if (await this.redis.set(this.timerKey(tenantId, contactId), retryValue, "NX", "EX", this.controlTtlSeconds) === "OK") {
          await this.scheduleTimer(tenantId, contactId, timerToken, retryRunAt);
        }
      }
      return;
    }
    this.logger.info(`Burst buffer mutex acquired for tenant ${tenantId}, contact ${contactId}`);

    try {
      const messageKey = this.messageKey(tenantId, contactId);
      const serializedMessages = await this.redis.drainList(messageKey);
      if (serializedMessages.length === 0) {
        await this.redis.deleteIfValue(this.timerKey(tenantId, contactId), serializeTimer(currentTimer));
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
          mediaContext: mergeMediaContext(messages),
        });
      } catch (error) {
        await this.redis.lpush(messageKey, ...serializedMessages.reverse());
        await this.redis.deleteIfValue(this.timerKey(tenantId, contactId), serializeTimer(currentTimer));
        const retryToken = randomUUID();
        const retryRunAt = this.clock() + this.bufferSeconds * 1000;
        const retryValue = serializeTimer({ token: retryToken, runAt: retryRunAt });
        if (await this.redis.set(this.timerKey(tenantId, contactId), retryValue, "NX", "EX", this.controlTtlSeconds) === "OK") {
          await this.scheduleTimer(tenantId, contactId, retryToken, retryRunAt);
        }
        throw error;
      }

      await this.redis.deleteIfValue(this.timerKey(tenantId, contactId), serializeTimer(currentTimer));
      const pending = await this.redis.lrange(messageKey, 0, 0);
      if (pending.length > 0) {
        const nextToken = randomUUID();
        const nextRunAt = this.clock() + this.bufferSeconds * 1000;
        if (await this.redis.set(this.timerKey(tenantId, contactId), serializeTimer({ token: nextToken, runAt: nextRunAt }), "NX", "EX", this.controlTtlSeconds) === "OK") {
          await this.scheduleTimer(tenantId, contactId, nextToken, nextRunAt);
        }
      }
      this.logger.info(`Burst buffer consolidated ${messages.length} messages for tenant ${tenantId}, contact ${contactId}`);
    } finally {
      await this.mutex.release(tenantId, contactId);
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

  private messageKey(tenantId: string, contactId: string): string {
    return `${MESSAGE_KEY_PREFIX}${scopeSuffix(tenantId, contactId)}`;
  }

  private timerKey(tenantId: string, contactId: string): string {
    return `${TIMER_KEY_PREFIX}${scopeSuffix(tenantId, contactId)}`;
  }

  private scopeKey(tenantId: string, contactId: string): string {
    return scopeSuffix(tenantId, contactId);
  }
}

function mergeMediaContext(messages: BufferedInboundMessage[]): {
  audioTranscriptionFailed?: boolean;
  imageClassifications?: Array<"identity_document" | "income_proof_document" | "vehicle_photo" | "unrelated" | "unknown">;
  imageVehicleCategories?: string[];
} | undefined {
  const imageClassifications = messages.flatMap((message) => message.mediaSignals?.imageClassifications ?? []);
  const imageVehicleCategories = messages.flatMap((message) => message.mediaSignals?.imageVehicleCategories ?? []);
  const audioTranscriptionFailed = messages.some((message) => message.mediaSignals?.audioTranscriptionFailed);
  if (!audioTranscriptionFailed && imageClassifications.length === 0 && imageVehicleCategories.length === 0) return undefined;
  return {
    ...(audioTranscriptionFailed ? { audioTranscriptionFailed: true } : {}),
    ...(imageClassifications.length > 0 ? { imageClassifications } : {}),
    ...(imageVehicleCategories.length > 0 ? { imageVehicleCategories } : {}),
  };
}

function hasExternalId(serialized: string, externalId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return Boolean(
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { externalId?: unknown }).externalId === externalId,
    );
  } catch {
    return false;
  }
}

export function scopeSuffix(tenantId: string, contactId: string): string {
  return `tenant:${encodeURIComponent(tenantId)}:contact:${encodeURIComponent(contactId)}`;
}

function parseScopedKey(key: string, prefix: string): { tenantId: string; contactId: string } | undefined {
  const match = key.match(new RegExp(`^${prefix}tenant:([^:]+):contact:(.+)$`));
  if (!match?.[1] || !match[2]) return undefined;
  return { tenantId: decodeURIComponent(match[1]), contactId: decodeURIComponent(match[2]) };
}

function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return value;
}

function serializeTimer(state: TimerState): string {
  return JSON.stringify(state);
}

function parseTimer(value: string): TimerState | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const state = parsed as Partial<TimerState>;
    if (typeof state.token !== "string" || !state.token || typeof state.runAt !== "number" || !Number.isFinite(state.runAt)) return undefined;
    return { token: state.token, runAt: state.runAt };
  } catch {
    return undefined;
  }
}
