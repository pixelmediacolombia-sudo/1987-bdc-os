import type { GhlWebhookEvent } from "@/modules/webhooks/domain/ghl-webhook-event";

export type WebhookProcessResult = {
  duplicate: boolean;
  tenantId: string;
  suppressAi?: boolean;
  stage?: WebhookStage;
};

export type WebhookStage =
  | "received"
  | "policy_pending"
  | "policy_applied"
  | "suppression_applied"
  | "processed"
  | "failed";

export type WebhookStageClaim = {
  tenantId: string;
  externalId: string;
  stage: WebhookStage;
  token: string;
};

export interface WebhookRepository {
  process(event: GhlWebhookEvent): Promise<WebhookProcessResult>;
  claimStage?(input: Omit<WebhookStageClaim, "token">): Promise<WebhookStageClaim | undefined>;
  completeStage?(input: WebhookStageClaim, nextStage: WebhookStage): Promise<void>;
  releaseStage?(input: WebhookStageClaim): Promise<void>;
}
