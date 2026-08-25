import assert from "node:assert/strict";
import { test } from "node:test";
import { findMetaCapiEnvConfig, loadMetaCapiEnvConfig } from "@/modules/control/infrastructure/meta-capi.config";
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

test("Ticket 8.5 loads all seven master-map dataset/token pairs", () => {
  const env: NodeJS.ProcessEnv = {
    META_CAPI_DATASET_COUNTRY_CLUB: "dataset-country-club",
    META_CAPI_TOKEN_COUNTRY_CLUB: "token-country-club",
    META_CAPI_DATASET_OFFLEASE: "dataset-offlease",
    META_CAPI_TOKEN_OFFLEASE: "token-offlease",
    META_CAPI_DATASET_KOONS_CULPEPER: "dataset-koons-culpeper",
    META_CAPI_TOKEN_KOONS_CULPEPER: "token-koons-culpeper",
    META_CAPI_DATASET_KOONS_FBURG_ES: "dataset-koons-fburg-es",
    META_CAPI_TOKEN_KOONS_FBURG_ES: "token-koons-fburg-es",
    META_CAPI_DATASET_ACTION: "dataset-action",
    META_CAPI_TOKEN_ACTION: "token-action",
    META_CAPI_DATASET_ARLINGTON: "dataset-arlington",
    META_CAPI_TOKEN_ARLINGTON: "token-arlington",
    META_CAPI_DATASET_EASTERNS_ES: "dataset-easterns-es",
    META_CAPI_TOKEN_EASTERNS_ES: "token-easterns-es",
  };
  const config = loadMetaCapiEnvConfig(env);
  assert.deepEqual(config.dealers.map((dealer) => dealer.key), [
    "COUNTRY_CLUB",
    "OFFLEASE",
    "KOONS_CULPEPER",
    "KOONS_FBURG_ES",
    "ACTION",
    "ARLINGTON",
    "EASTERNS_ES",
  ]);
  assert.equal(findMetaCapiEnvConfig("{}", config.dealers, "LiaoSID3nvAhad492pNJ")?.key, "OFFLEASE");
  assert.equal(findMetaCapiEnvConfig("{}", config.dealers, "MyxWNKacThim798E8KC6")?.key, "OFFLEASE");
  assert.equal(findMetaCapiEnvConfig("{}", config.dealers, "113zMWQlHKKBu5w0YtR")?.key, "EASTERNS_ES");
  assert.equal(findMetaCapiEnvConfig("{}", config.dealers, "bTNJHpNZ8FaS1PUHkuUq")?.key, "KOONS_CULPEPER");
  assert.equal(findMetaCapiEnvConfig("{}", config.dealers, "xuH0opT02g5edIuPJRl")?.key, "KOONS_FBURG_ES");
  assert.equal(findMetaCapiEnvConfig("Koons Fredericksburg ES", config.dealers)?.key, "KOONS_FBURG_ES");
});

test("Ticket 8.5 rejects an incomplete dataset/token pair", () => {
  assert.throws(
    () => loadMetaCapiEnvConfig({ META_CAPI_DATASET_ACTION: "dataset-action" }),
    /META_CAPI_DATASET_ACTION and META_CAPI_TOKEN_ACTION must be configured together/,
  );
});
