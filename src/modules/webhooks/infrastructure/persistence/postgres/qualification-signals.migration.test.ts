import assert from "node:assert/strict";
import test from "node:test";
import { CREATE_QUALIFICATION_SIGNAL_TABLES_SQL } from "./qualification-signals.migration";

test("tenant route directory backfills IDs without bypassing tenant RLS", () => {
  assert.match(CREATE_QUALIFICATION_SIGNAL_TABLES_SQL, /FORCE ROW LEVEL SECURITY/);
  assert.match(CREATE_QUALIFICATION_SIGNAL_TABLES_SQL, /SELECT tenant_id FROM public\.user_tenant_memberships/);
  assert.match(CREATE_QUALIFICATION_SIGNAL_TABLES_SQL, /SELECT tenant_id FROM public\.dealer_invitations/);
  assert.match(CREATE_QUALIFICATION_SIGNAL_TABLES_SQL, /to_regclass\('public\.tenant_location_routes'\)/);
  assert.match(CREATE_QUALIFICATION_SIGNAL_TABLES_SQL, /SECURITY DEFINER/);
  assert.doesNotMatch(CREATE_QUALIFICATION_SIGNAL_TABLES_SQL, /SELECT dealer_id FROM public\.tenants/);
  assert.match(CREATE_QUALIFICATION_SIGNAL_TABLES_SQL, /REVOKE ALL ON TABLE public\.tenant_processing_routes FROM PUBLIC/);
  assert.match(CREATE_QUALIFICATION_SIGNAL_TABLES_SQL, /GRANT EXECUTE ON FUNCTION public\.list_tenant_route_ids\(\) TO bdc/);
  assert.match(CREATE_QUALIFICATION_SIGNAL_TABLES_SQL, /GRANT EXECUTE ON FUNCTION public\.list_qualification_signal_dealers\(\) TO bdc/);
});
