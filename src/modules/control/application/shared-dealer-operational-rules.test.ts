import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildSharedDealerFollowUp,
  canSendSharedDealerFollowUp,
  SHARED_DEALER_FOLLOW_UP_SCHEDULE,
} from "@/modules/control/application/shared-dealer-operational-rules";

test("Dealer Demo follow-up uses three attempts at 2 hours, next day and 3 days", () => {
  assert.deepEqual(SHARED_DEALER_FOLLOW_UP_SCHEDULE.map((item) => item.delayMs), [
    2 * 60 * 60 * 1000,
    24 * 60 * 60 * 1000,
    3 * 24 * 60 * 60 * 1000,
  ]);
  assert.equal(canSendSharedDealerFollowUp(1), true);
  assert.equal(canSendSharedDealerFollowUp(3), true);
  assert.equal(canSendSharedDealerFollowUp(4), false);
});

test("first and second follow-ups resume the pending item without repeating the greeting", () => {
  const pending = "¿Con cuánto contaría para el enganche?";
  assert.match(buildSharedDealerFollowUp({ attempt: 1, pendingQuestion: pending, language: "es" }), /seguimiento/);
  assert.match(buildSharedDealerFollowUp({ attempt: 2, pendingQuestion: pending, language: "en" }), /following up/);
  assert.doesNotMatch(buildSharedDealerFollowUp({ attempt: 1, pendingQuestion: pending, language: "es" }), /Hola|Sofía|Dealer Demo/);
});

test("the third follow-up closes with an open door and does not require a pending item", () => {
  assert.match(buildSharedDealerFollowUp({ attempt: 3, language: "es" }), /Cualquier cosa/);
  assert.match(buildSharedDealerFollowUp({ attempt: 3, language: "en" }), /whenever you are ready/);
  assert.throws(() => buildSharedDealerFollowUp({ attempt: 1, language: "es" }), /pending question/);
});
