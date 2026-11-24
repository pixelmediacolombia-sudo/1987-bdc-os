import assert from "node:assert/strict";
import test from "node:test";
import type { Pool } from "pg";
import { loadAdminDealerDirectory } from "./route-helpers";

test("Admin directory resolves missing names from exact GHL location IDs", async () => {
  const tenantId = "11111111-1111-4111-8111-111111111111";
  const client = {
    query: async (sql: string) => {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
      if (sql.includes("set_config")) return { rows: [] };
      if (sql.includes("FROM public.tenants AS t")) return { rows: [{ id: tenantId, name: null, ghl_location_id: "k9DePpsNBu9qWT1C6pW0", status: "active", user_count: 0, pending_invitation_count: 0 }] };
      throw new Error("Unexpected tenant directory SQL");
    }, release: () => undefined,
  };
  const pool = {
    query: async (sql: string) => sql.includes("list_tenant_route_ids") ? { rows: [{ dealer_id: tenantId }] } : { rows: [] },
    connect: async () => client,
  } as unknown as Pool;
  const dealers = await loadAdminDealerDirectory(pool);
  assert.equal(dealers.length, 1);
  assert.equal(dealers[0]?.name, "Country Club DMV");
});
