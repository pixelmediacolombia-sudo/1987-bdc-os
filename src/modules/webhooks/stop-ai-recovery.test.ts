import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  WebhookProcessResult,
  WebhookRepository,
  WebhookStage,
  WebhookStageClaim,
} from "@/modules/webhooks/application/ports/webhook-repository.port";
import { ProcessGHLWebhookUseCase } from "@/modules/webhooks/application/process-ghl-webhook.use-case";
import type { PolicyEvaluatorPort } from "@/modules/decisions/application/policy-evaluation.service";

const TENANT_ID = "tenant-stop-ai";
const EXTERNAL_ID = "stop-recovery-1";
const CONTACT_ID = "contact-stop-ai";

class RecoverableWebhookRepository implements WebhookRepository {
  stage: WebhookStage = "received";
  claim?: WebhookStageClaim;
  suppressionRequired = true;
  tenantClaims: string[] = [];

  async process(_event: Parameters<NonNullable<WebhookRepository["process"]>>[0]): Promise<WebhookProcessResult> {
    const duplicate = this.stage !== "received";
    if (!duplicate) this.stage = "policy_pending";
    return {
      duplicate,
      tenantId: TENANT_ID,
      suppressAi: this.suppressionRequired,
      stage: this.stage,
    };
  }

  async claimStage(input: Omit<WebhookStageClaim, "token">): Promise<WebhookStageClaim | undefined> {
    this.tenantClaims.push(input.tenantId);
    if (input.tenantId !== TENANT_ID || this.stage !== input.stage || this.claim) return undefined;
    this.claim = { ...input, token: `claim-${this.tenantClaims.length}` };
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

function stopAiPayload() {
  return {
    eventId: EXTERNAL_ID,
    eventType: "ContactTagUpdate",
    locationId: "location-stop-ai",
    contactId: CONTACT_ID,
    tags: ["stop_ai"],
  };
}

function createEvaluator(options: { failFirst?: boolean; delayMs?: number } = {}) {
  let shouldFail = options.failFirst ?? false;
  let calls = 0;
  const evaluator: PolicyEvaluatorPort = {
    evaluateForContact: async () => {
      calls += 1;
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
      if (shouldFail) {
        shouldFail = false;
        throw new Error("decision log temporarily unavailable");
      }
      return {} as never;
    },
  };
  return { evaluator, calls: () => calls };
}

function createUseCase(
  repository: RecoverableWebhookRepository,
  evaluator: PolicyEvaluatorPort,
  suppressionCalls: { count: number },
) {
  return new ProcessGHLWebhookUseCase(repository, undefined, {
    suppress: async () => {
      suppressionCalls.count += 1;
    },
  }, evaluator);
}

async function execute(useCase: ProcessGHLWebhookUseCase): Promise<void> {
  await useCase.execute({
    payload: stopAiPayload(),
    rawBody: Buffer.from(EXTERNAL_ID),
    signature: "test-signature",
  });
}

test("A1/A2: retry recovers policy_pending after a decision-log failure without duplicating STOP", async () => {
  const repository = new RecoverableWebhookRepository();
  const evaluator = createEvaluator({ failFirst: true });
  const suppressionCalls = { count: 0 };
  const useCase = createUseCase(repository, evaluator.evaluator, suppressionCalls);

  await assert.rejects(execute(useCase), /decision log temporarily unavailable/);
  assert.equal(repository.stage, "policy_pending");
  assert.equal(repository.claim, undefined);

  await execute(useCase);
  assert.equal(repository.stage, "processed");
  assert.equal(evaluator.calls(), 2);
  assert.equal(suppressionCalls.count, 1);

  await execute(useCase);
  assert.equal(repository.stage, "processed");
  assert.equal(evaluator.calls(), 2);
  assert.equal(suppressionCalls.count, 1);
});

test("A3: STOP suppression cancels the contact flow exactly once", async () => {
  const repository = new RecoverableWebhookRepository();
  const evaluator = createEvaluator();
  const suppressionCalls = { count: 0 };

  await execute(createUseCase(repository, evaluator.evaluator, suppressionCalls));

  assert.equal(repository.stage, "processed");
  assert.equal(suppressionCalls.count, 1);
});

test("A4: five concurrent deliveries produce one effective policy and suppression transition", async () => {
  const repository = new RecoverableWebhookRepository();
  const evaluator = createEvaluator({ delayMs: 20 });
  const suppressionCalls = { count: 0 };
  const useCase = createUseCase(repository, evaluator.evaluator, suppressionCalls);

  await Promise.all(Array.from({ length: 5 }, () => execute(useCase)));

  assert.equal(repository.stage, "processed");
  assert.equal(evaluator.calls(), 1);
  assert.equal(suppressionCalls.count, 1);
  assert.deepEqual([...new Set(repository.tenantClaims)], [TENANT_ID]);
});
