import assert from "node:assert/strict";
import test from "node:test";
import { resolveDealerName } from "./dealer-name";

test("identifies known production dealers by exact GHL location ID", () => {
  assert.equal(resolveDealerName(null, "k9DePpsNBu9qWT1C6pW0"), "Country Club DMV");
  assert.equal(resolveDealerName("   ", "xuHo0opTO2g5edIuPJRl"), "Koons of Fredericksburg");
  assert.equal(resolveDealerName(null, "C89276AhU942sfwFMQ9m"), "Legacy tenant - dealer identity unconfirmed");
});

test("preserves manually assigned names and does not guess unknown or case-mismatched locations", () => {
  assert.equal(resolveDealerName("Dealer editado", "k9DePpsNBu9qWT1C6pW0"), "Dealer editado");
  assert.equal(resolveDealerName(null, "unknown-location"), null);
  assert.equal(resolveDealerName(null, "K9DePpsNBu9qWT1C6pW0"), null);
  assert.equal(resolveDealerName(null, null), null);
});
