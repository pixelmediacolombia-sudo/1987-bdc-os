export type DelayedBurstFlushJob = {
  tenantId: string;
  contactId: string;
  timerToken: string;
  runAt: Date;
};

/**
 * Contract for the next durable-queue adapter. The current Redis timer
 * recovery is intentionally kept behind this boundary until a worker-backed
 * implementation is selected.
 */
export interface DelayedBurstFlushQueuePort {
  schedule(job: DelayedBurstFlushJob): Promise<void>;
  cancel(job: Pick<DelayedBurstFlushJob, "tenantId" | "contactId" | "timerToken">): Promise<void>;
  recover(): Promise<DelayedBurstFlushJob[]>;
}
