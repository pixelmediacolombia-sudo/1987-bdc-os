import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveDealerDisplayName } from "@/modules/decisions/domain/dealer-identity";

test("resolves Country Club identity from its GHL location id", () => {
  assert.equal(
    resolveDealerDisplayName({ dealerId: "dealer-country-club", ghlLocationId: "k9DePpsNBu9qWT1C6pW0" }),
    "Country Club Cars Inc",
  );
});

test("resolves every configured dealer location to its own display name", () => {
  const locations = [
    ["LiaoSID3nvAhad49ZpNJ", "Off Lease"],
    ["bTNJHpNZ8FaS1PUHkuUq", "Koons Automotive of Culpeper"],
    ["xuHo0opTO2g5edIuPJRl", "Koons Fredericksburg"],
    ["ZxadcudjvBz7KFCB1od4", "Action Pre-Owned"],
    ["9v8zH9Y5eLiiJwZTZDci", "Arlington Woodbridge"],
    ["MRHcOwdTqaN5cug3eSWW", "Easterns"],
  ] as const;
  for (const [ghlLocationId, expected] of locations) {
    assert.equal(resolveDealerDisplayName({ dealerId: "dealer", ghlLocationId }), expected);
  }
});

test("returns no identity for an unknown location so the orchestrator can stay silent", () => {
  assert.equal(resolveDealerDisplayName({ dealerId: "dealer-unknown", ghlLocationId: "unknown-location" }), undefined);
});
