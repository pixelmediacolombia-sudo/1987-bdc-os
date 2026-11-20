import assert from "node:assert/strict";
import { test } from "node:test";
import { findMetaCapiEnvConfig, loadMetaCapiEnvConfig } from "@/modules/control/infrastructure/meta-capi.config";
import { buildMetaCapiPayload, hasMetaCapiAttribution, hashPhone } from "@/modules/decisions/domain/meta-capi";

test("Ticket 8.5 normalizes common US phone formats to the same hash", () => {
  const variants = ["(571) 555-0134", "+1 571 555 0134", "1-571-555-0134", "15715550134"];
  assert.equal(new Set(variants.map(hashPhone)).size, 1);
});

test("Ticket 8.5 omits empty personal fields and leaves ctwa_clid clear", () => {
  const payload = buildMetaCapiPayload({
    eventName: "Lead_Calificado",
    eventId: "ledger-1",
    eventTime: new Date("2026-08-24T15:00:00.000Z"),
    dealer: "dealer-tenant-1",
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

test("Ticket 8.5 treats only a real ctwa_clid as Meta attribution", () => {
  assert.equal(hasMetaCapiAttribution(undefined), false);
  assert.equal(hasMetaCapiAttribution("   "), false);
  assert.equal(hasMetaCapiAttribution("click-1"), true);
});

test("Ticket 8.5 loads independent dataset/token pairs keyed by tenant ID", () => {
  const env: NodeJS.ProcessEnv = {
    META_CAPI_DEALERS_JSON: JSON.stringify({
      "tenant-a": { datasetId: "dataset-a", accessToken: "token-a" },
      "tenant-b": { datasetId: "dataset-b", accessToken: "token-b" },
    }),
  };
  const config = loadMetaCapiEnvConfig(env);
  assert.deepEqual(config.dealers.map((dealer) => dealer.tenantId), ["tenant-a", "tenant-b"]);
  assert.equal(findMetaCapiEnvConfig("tenant-a", config.dealers)?.datasetId, "dataset-a");
  assert.equal(findMetaCapiEnvConfig("tenant-b", config.dealers)?.accessToken, "token-b");
});

test("Ticket 8.5 uses a Meta-supported event name for business messaging by default", () => {
  assert.equal(loadMetaCapiEnvConfig({}).eventName, "LeadSubmitted");
  assert.equal(loadMetaCapiEnvConfig({ META_CAPI_EVENT_NAME: "Lead_Calificado" }).eventName, "LeadSubmitted");
});

test("Ticket 8.5 rejects an incomplete dataset/token pair", () => {
  assert.throws(
    () => loadMetaCapiEnvConfig({ META_CAPI_DEALERS_JSON: JSON.stringify({ "tenant-a": { datasetId: "dataset-a" } }) }),
    /entry tenant-a must include datasetId and accessToken/,
  );
});
