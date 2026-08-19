import { createHash } from "node:crypto";

export type WebhookBackgroundTask = () => Promise<void>;

/**
 * Keeps the HTTP ACK independent from processing and collapses identical
 * deliveries while they are in flight. PostgreSQL remains the durable
 * idempotency boundary for retries after this process has finished.
 */
export class InMemoryWebhookQueue {
  private readonly inFlight = new Set<string>();

  enqueue(rawBody: Buffer, task: WebhookBackgroundTask): boolean {
    const key = createHash("sha256").update(rawBody).digest("hex");
    if (this.inFlight.has(key)) return false;

    this.inFlight.add(key);
    setImmediate(() => {
      void task()
        .catch((error: unknown) => {
          console.error("GHL webhook background processing failed", error instanceof Error ? error.message : "unknown error");
        })
        .finally(() => this.inFlight.delete(key));
    });
    return true;
  }
}
