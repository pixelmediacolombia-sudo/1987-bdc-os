import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMetaCapiPayload, hashPhone } from "@/modules/decisions/domain/meta-capi";

test("Ticket 8.5 normalizes common US phone formats to the same hash", () => {
  const variants = ["(571) 555-0134", "+1 571 555 0134", "1-571-555-0134", "15715550134"];
  assert.equal(new Set(variants.map(hashPhone)).size, 1);
});

test("Ticket 8.5 omits empty personal fields and leaves ctwa_clid clear", () => {
  const payload = buildMetaCapiPayload({
    eventName: "Lead_Calificado",
    eventId: "ledger-1",
    eventTime: new Date("2026-08-24T15:00:00.000Z"),
    dealer: "country_club_cars",
    contactId: "contact-1",
    ctwaClid: "click-1",
    objectivesAnswered: 5,
  });
  const userData = payload.data[0].user_data;
  assert.equal(userData.ctwa_clid, "click-1");
  assert.equal("ph" in userData, false);
  assert.equal("em" in userData, false);
  assert.equal(userData.external_id.length, 64);
});
