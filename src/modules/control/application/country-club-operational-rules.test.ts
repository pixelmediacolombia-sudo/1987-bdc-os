import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCountryClubFollowUp,
  canSendCountryClubFollowUp,
  COUNTRY_CLUB_FOLLOW_UP_SCHEDULE,
} from "@/modules/control/application/country-club-operational-rules";

test("Country Club follow-up uses three attempts at 2 hours, next day and 3 days", () => {
  assert.deepEqual(COUNTRY_CLUB_FOLLOW_UP_SCHEDULE.map((item) => item.delayMs), [
    2 * 60 * 60 * 1000,
    24 * 60 * 60 * 1000,
    3 * 24 * 60 * 60 * 1000,
  ]);
  assert.equal(canSendCountryClubFollowUp(1), true);
  assert.equal(canSendCountryClubFollowUp(3), true);
  assert.equal(canSendCountryClubFollowUp(4), false);
});

test("first and second follow-ups resume the pending item without repeating the greeting", () => {
  const pending = "¿Con cuánto contaría para el enganche?";
  assert.match(buildCountryClubFollowUp({ attempt: 1, pendingQuestion: pending, language: "es" }), /seguimiento/);
  assert.match(buildCountryClubFollowUp({ attempt: 2, pendingQuestion: pending, language: "en" }), /following up/);
  assert.doesNotMatch(buildCountryClubFollowUp({ attempt: 1, pendingQuestion: pending, language: "es" }), /Hola|Sofía|Country Club/);
});

test("the third follow-up closes with an open door and does not require a pending item", () => {
  assert.match(buildCountryClubFollowUp({ attempt: 3, language: "es" }), /Cualquier cosa/);
  assert.match(buildCountryClubFollowUp({ attempt: 3, language: "en" }), /whenever you are ready/);
  assert.throws(() => buildCountryClubFollowUp({ attempt: 1, language: "es" }), /pending question/);
});
