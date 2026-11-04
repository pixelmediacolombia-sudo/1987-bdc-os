import assert from "node:assert/strict";
import { test } from "node:test";
import type { PolicyEvaluatorPort } from "@/modules/decisions/application/policy-evaluation.service";
import { QualificationFlowService } from "@/modules/control/application/qualification-flow.service";
import { OutboundMessageRejectedError } from "@/modules/control/application/registered-outbound-message-sender";

function decision(overrides: Record<string, unknown> = {}) {
  return {
    allowedActions: ["REPLY"],
    selectedAction: null,
    reason: "All deterministic policy gates passed",
    localTimestamp: "2026-11-03T12:00:00-05:00",
    replyBlocked: false,
    gate: "PASSED",
    decisionLoggedSuccessfully: true,
    rlsEnforced: true,
    ...overrides,
  } as never;
}

function input() {
  return {
    tenantId: "tenant-a",
    contactId: "contact-a",
    content: "Te ayudo a encontrar una SUV.",
    semanticHash: "hash-a",
    channel: "WhatsApp" as const,
    externalId: "inbound-a",
  };
}

test("Sofia response rechecks current policy immediately before provider send", async () => {
  const evaluations: unknown[] = [];
  let sends = 0;
  const policyEvaluator: PolicyEvaluatorPort = {
    evaluateForContact: async (request) => { evaluations.push(request); return decision(); },
  };
  const flow = new QualificationFlowService(policyEvaluator, {
    send: async () => { sends += 1; return { providerMessageId: "provider-a" }; },
  } as never);

  await flow.sendSofiaResponse(input());

  assert.equal(sends, 1);
  assert.deepEqual(evaluations, [{
    tenantId: "tenant-a",
    ghlContactId: "contact-a",
    requestedAction: "REPLY",
    externalId: "inbound-a",
    source: "qualification-flow",
  }]);
});

test("Sofia response never reaches provider when current policy blocks reply", async () => {
  let sends = 0;
  const policyEvaluator: PolicyEvaluatorPort = {
    evaluateForContact: async () => decision({
      allowedActions: ["WAIT", "HANDOFF"],
      selectedAction: "WAIT",
      reason: "Quiet hours active",
      replyBlocked: true,
      gate: "QUIET_HOURS",
    }),
  };
  const flow = new QualificationFlowService(policyEvaluator, {
    send: async () => { sends += 1; return { providerMessageId: "provider-never" }; },
  } as never);

  await assert.rejects(
    flow.sendSofiaResponse(input()),
    (error: unknown) => error instanceof OutboundMessageRejectedError && error.action === "WAIT" && /Quiet hours/.test(error.message),
  );
  assert.equal(sends, 0);
});

test("internal handoff authorization is independent from customer reply authorization", async () => {
  const requests: Array<Record<string, unknown>> = [];
  const flow = new QualificationFlowService({
    evaluateForContact: async (request) => {
      requests.push(request);
      if (request.requestedAction === "REPLY") {
        return decision({ allowedActions: ["WAIT", "HANDOFF"], replyBlocked: true, selectedAction: "WAIT" });
      }
      return decision({ allowedActions: ["HANDOFF"], replyBlocked: true, selectedAction: "HANDOFF" });
    },
  }, { send: async () => ({ providerMessageId: "unused" }) } as never);

  const handoff = await flow.authorizeHandoff({ tenantId: "tenant-a", contactId: "contact-a" });
  assert.equal(handoff.selectedAction, "HANDOFF");
  await assert.rejects(flow.sendSofiaResponse(input()), OutboundMessageRejectedError);
  assert.equal(requests[0]?.requestedAction, undefined);
  assert.equal(requests[1]?.requestedAction, "REPLY");
});
