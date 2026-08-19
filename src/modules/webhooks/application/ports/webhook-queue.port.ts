export type WebhookBackgroundTask = () => Promise<void>;

export type WebhookQueueJob = {
  rawBody: Buffer;
  signature: string;
};

export type WebhookQueueHandler = (job: WebhookQueueJob) => Promise<void>;

export interface WebhookQueuePort {
  enqueue(rawBody: Buffer, signature: string, inMemoryTask: WebhookBackgroundTask): boolean | Promise<boolean>;
  start(handler: WebhookQueueHandler): Promise<void>;
  stop(): Promise<void>;
}
