import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  WebhookProcessResult,
  WebhookRepository,
  WebhookStage,
  WebhookStageClaim,
} from "@/modules/webhooks/application/ports/webhook-repository.port";
import { ProcessInboundWebhookUseCase } from "@/modules/webhooks/application/process-inbound-webhook.use-case";
import type { BurstBufferPort } from "@/modules/control/application/ports/burst-buffer.port";
import type { InboundWebhookEvent } from "@/modules/webhooks/domain/inbound-webhook-event";

const TENANT_ID = "tenant-buffer-recovery";
const EXTERNAL_ID = "inbound-buffer-recovery-1";
const CONTACT_ID = "contact-buffer-recovery";

class ReceivedWebhookRepository implements WebhookRepository {
  stage: WebhookStage = "received";
  claim?: WebhookStageClaim;

  async process(_event: Parameters<NonNullable<WebhookRepository["process"]>>[0]): Promise<WebhookProcessResult> {
    return {
      duplicate: this.stage !== "received",
      tenantId: TENANT_ID,
      stage: this.stage,
    };
  }

  async claimStage(input: Omit<WebhookStageClaim, "token">): Promise<WebhookStageClaim | undefined> {
    if (this.stage !== input.stage || this.claim) return undefined;
    this.claim = { ...input, token: "buffer-claim" };
    return this.claim;
  }

  async completeStage(input: WebhookStageClaim, nextStage: WebhookStage): Promise<void> {
    assert.equal(this.claim?.token, input.token);
    assert.equal(this.stage, input.stage);
    this.stage = nextStage;
    this.claim = undefined;
  }

  async releaseStage(input: WebhookStageClaim): Promise<void> {
    if (this.claim?.token === input.token) this.claim = undefined;
  }
}

function inboundEvent(): InboundWebhookEvent {
  const inboundMessage = {
    externalId: EXTERNAL_ID,
    contactId: CONTACT_ID,
    conversationId: `whatsapp:${CONTACT_ID}`,
    channel: "whatsapp",
    content: "Hola busco un SUV",
    semanticHash: "semantic-buffer-recovery",
  };
  return {
    provider: "meta",
    externalId: EXTERNAL_ID,
    eventType: "meta.message.received",
    accountId: "account-buffer-recovery",
    signature: "test-signature",
    rawBody: Buffer.from(EXTERNAL_ID),
    payload: { object: "whatsapp_business_account" },
    contactId: CONTACT_ID,
    conversationId: inboundMessage.conversationId,
    inboundMessage,
  };
}

async function execute(useCase: ProcessInboundWebhookUseCase): Promise<void> {
  await useCase.execute(inboundEvent());
}

test("un fallo del buffer deja el webhook en received y el reintento completa la entrega", async () => {
  const repository = new ReceivedWebhookRepository();
  let bufferCalls = 0;
  let failFirst = true;
  const burstBuffer: BurstBufferPort = {
    add: async () => {
      bufferCalls += 1;
      if (failFirst) {
        failFirst = false;
        throw new Error("redis temporarily unavailable");
      }
    },
  };
  const useCase = new ProcessInboundWebhookUseCase(repository, burstBuffer);

  await assert.rejects(execute(useCase), /redis temporarily unavailable/);
  assert.equal(repository.stage, "received");
  assert.equal(repository.claim, undefined);

  await execute(useCase);
  assert.equal(repository.stage, "processed");
  assert.equal(bufferCalls, 2);
});
