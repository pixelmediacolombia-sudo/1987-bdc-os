import assert from "node:assert/strict";
import { test } from "node:test";
import { PolicyEngine } from "@/modules/decisions/application/policy-engine";
import type { PolicyContext } from "@/modules/decisions/domain/policy-context";

const QUIET_POLICY_CONTEXT: PolicyContext = {
  tenant: {
    id: "00000000-0000-0000-0000-000000000001",
    timezone: "America/New_York",
    policyVersion: "test_v1",
    status: "active",
    policies: {
      version: "test_v1",
      downPayment: { min: 5_000, max: null, currency: "USD" },
      quietHours: { enabled: true, start: "21:00", end: "08:00" },
      humanHandoff: { enabled: true, triggers: [] },
      financialBoundaries: {
        disclaimer: {
          code: "FINANCING_REVIEW_REQUIRED",
          text: "Dealer review and lender approval are required.",
        },
      },
    },
  },
  contact: {
    id: "00000000-0000-0000-0000-000000000002",
    ghlContactId: "ghl-contact-2",
    consentState: "unknown",
  },
  activeFacts: {},
};

const AT_3_AM = new Date("2026-08-21T07:00:00.000Z");
const engine = new PolicyEngine();

test("compliance gate forces STOP for stop_ai, revoked consent, and opt-out", () => {
  assert.deepEqual(engine.evaluate(QUIET_POLICY_CONTEXT, { controlTag: "stop_ai", now: AT_3_AM }).allowedActions, ["STOP"]);
  assert.equal(
    engine.evaluate({
      ...QUIET_POLICY_CONTEXT,
      contact: { ...QUIET_POLICY_CONTEXT.contact, consentState: "revoked" },
    }, { now: new Date("2026-08-21T15:00:00Z") }).selectedAction,
    "STOP",
  );
  assert.equal(
    engine.evaluate(QUIET_POLICY_CONTEXT, { inboundMessage: "CANCELAR por favor", now: new Date("2026-08-21T15:00:00Z") }).reason,
    "AI stopped: opt-out keyword detected in latest inbound message",
  );
});

test("quiet-hours gate uses tenant timezone and restricts the action space", () => {
  const decision = engine.evaluate(QUIET_POLICY_CONTEXT, { now: AT_3_AM });
  assert.equal(decision.localTimestamp, "2026-08-21T03:00:00-04:00");
  assert.deepEqual(decision.allowedActions, ["WAIT", "SCHEDULE_FOLLOWUP", "HANDOFF"]);
  assert.equal(decision.replyBlocked, true);
  assert.equal(decision.gate, "QUIET_HOURS");
});

test("financial gate handles zero and below-band down payments with a disclaimer", () => {
  const zero = engine.evaluate(QUIET_POLICY_CONTEXT, {
    downPayment: 0,
    now: new Date("2026-08-21T15:00:00Z"),
  });
  assert.deepEqual(zero.allowedActions, ["HANDOFF", "REPLY"]);
  assert.equal(zero.constraints?.replyDisclaimer?.code, "FINANCING_REVIEW_REQUIRED");
  assert.equal(zero.gate, "FINANCIAL");

  const belowMinimum = engine.evaluate({
    ...QUIET_POLICY_CONTEXT,
    activeFacts: { down_payment: "2500" },
  }, { now: new Date("2026-08-21T15:00:00Z") });
  assert.match(belowMinimum.reason, /below the approved minimum/);
});

test("passed gates expose exactly the typed minimum action universe", () => {
  const decision = engine.evaluate({
    ...QUIET_POLICY_CONTEXT,
    tenant: {
      ...QUIET_POLICY_CONTEXT.tenant,
      policies: {
        ...QUIET_POLICY_CONTEXT.tenant.policies,
        quietHours: { enabled: false, start: null, end: null },
      },
    },
  }, { downPayment: 10_000, now: new Date("2026-08-21T15:00:00Z") });
  assert.deepEqual(decision.allowedActions, [
    "REPLY", "WAIT", "ASK_OBJECTIVE", "SEARCH_INVENTORY", "OFFER_ALTERNATIVES",
    "OFFER_APPOINTMENT", "BOOK_APPOINTMENT", "CREATE_TASK", "HANDOFF",
    "SCHEDULE_FOLLOWUP", "CANCEL_FOLLOWUP", "UPDATE_CRM", "STOP",
  ]);
});
