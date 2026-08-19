export type BurstFlushJob = {
  tenantId: string;
  contactId: string;
  timerToken: string;
  runAt: number;
};

export type BurstFlushHandler = (job: BurstFlushJob) => Promise<void>;

export interface BurstFlushQueuePort {
  schedule(job: BurstFlushJob): Promise<void>;
  start(handler: BurstFlushHandler): Promise<void>;
  stop(): Promise<void>;
}
