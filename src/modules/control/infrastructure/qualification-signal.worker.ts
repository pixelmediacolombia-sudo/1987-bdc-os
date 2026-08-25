import type { SecretCryptor } from "@/features/ghl-oauth/application/ports/secret-cryptor.port";
import type {
  CapiDeliveryEvent,
  QualificationSignalRepository,
} from "@/modules/control/application/ports/qualification-signal.port";
import { GhlQualificationTagProvider } from "@/features/ghl-oauth/infrastructure/ghl/ghl-qualification-tag.provider";
import { MetaCapiProvider, QualificationDeliveryError } from "@/modules/control/infrastructure/meta-capi.provider";
import type { MetaCapiPayload } from "@/modules/decisions/domain/meta-capi";

export class QualificationSignalWorker {
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly repository: QualificationSignalRepository,
    private readonly metaProvider: MetaCapiProvider,
    private readonly tagProvider: GhlQualificationTagProvider,
    private readonly cryptor: SecretCryptor,
    private readonly nodeEnv: string,
    private readonly pollMs = 5_000,
  ) {}

  async start(): Promise<void> {
    await this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const dealerId of await this.repository.listDealerIds()) {
        await this.processCapi(dealerId);
        await this.processGhlTag(dealerId);
      }
    } finally {
      this.running = false;
    }
  }

  private async processCapi(dealerId: string): Promise<void> {
    const event = await this.repository.claimNextCapiEvent(dealerId);
    if (!event) return;
    if (!event.datasetId || (!event.accessToken && !event.encryptedAccessToken)) {
      await this.repository.markCapiFailure({
        dealerId,
        eventId: event.eventId,
        error: "Meta CAPI dataset or access token is not configured",
        retryable: false,
      });
      return;
    }

    try {
      if (this.nodeEnv === "production" && event.testEventCode) {
        throw new QualificationDeliveryError("meta_test_event_code must be null in production", 400);
      }
      const result = await this.metaProvider.send({
        datasetId: event.datasetId,
        accessToken: event.accessToken ?? this.cryptor.decrypt(event.encryptedAccessToken!),
        payload: event.payloadSent as unknown as MetaCapiPayload,
        ...(this.nodeEnv === "production" ? {} : event.testEventCode ? { testEventCode: event.testEventCode } : {}),
      });
      await this.repository.markCapiSent(event.eventId, dealerId, result.fbtraceId);
      console.info(`[Ticket8.5] Meta CAPI sent dealer=${dealerId} event=${event.eventId}`);
    } catch (error) {
      await this.repository.markCapiFailure({
        dealerId,
        eventId: event.eventId,
        error: deliveryMessage(error),
        retryable: isRetryable(error),
        rateLimited: isRateLimited(error),
      });
      console.warn(`[Ticket8.5] Meta CAPI delivery failed dealer=${dealerId} event=${event.eventId}`);
    }
  }

  private async processGhlTag(dealerId: string): Promise<void> {
    const event = await this.repository.claimNextGhlTagEvent(dealerId);
    if (!event) return;
    try {
      await this.tagProvider.addQualificationCompletedTag({
        tenantId: dealerId,
        ghlContactId: event.ghlContactId,
      });
      await this.repository.markGhlTagSent(event.id, dealerId);
      console.info(`[Ticket8.5] GHL qualification tag sent dealer=${dealerId} ledger=${event.ledgerEntryId}`);
    } catch (error) {
      await this.repository.markGhlTagFailure({
        dealerId,
        eventId: event.id,
        error: deliveryMessage(error),
        retryable: isRetryable(error),
        rateLimited: isRateLimited(error),
      });
      console.warn(`[Ticket8.5] GHL qualification tag failed dealer=${dealerId} ledger=${event.ledgerEntryId}`);
    }
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof QualificationDeliveryError ? error.retryable : true;
}

function isRateLimited(error: unknown): boolean {
  return error instanceof QualificationDeliveryError ? error.rateLimited : false;
}

function deliveryMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown qualification signal delivery error";
}
