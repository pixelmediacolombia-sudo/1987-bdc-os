import type { Pool } from "pg";

export const COUNTRY_CLUB_POLICY_VERSION = "country_club_cars_v8";
export const DEFAULT_COUNTRY_CLUB_GHL_LOCATION_ID = "k9DePpsNBu9qWT1C6pW0";

/** Activates only the explicitly identified Country Club tenant. */
export async function ensureCountryClubPolicy(
  pool: Pool,
  ghlLocationId = process.env.COUNTRY_CLUB_GHL_LOCATION_ID?.trim() || DEFAULT_COUNTRY_CLUB_GHL_LOCATION_ID,
): Promise<boolean> {
  if (!ghlLocationId) throw new Error("Country Club GHL location id cannot be empty");
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const resolved = await client.query<{ tenant_id: string | null }>(
      "SELECT public.resolve_ghl_tenant_id($1)::text AS tenant_id",
      [ghlLocationId],
    );
    const tenantId = resolved.rows[0]?.tenant_id;
    if (!tenantId) {
      await client.query("COMMIT");
      return false;
    }
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    const result = await client.query<{ policy_version: string }>(
      `UPDATE public.tenants
          SET policy_version = $1
        WHERE dealer_id = $2
        RETURNING policy_version`,
      [COUNTRY_CLUB_POLICY_VERSION, tenantId],
    );
    const readback = await client.query<{ policy_version: string }>(
      "SELECT policy_version FROM public.tenants WHERE dealer_id = $1",
      [tenantId],
    );
    await client.query("COMMIT");
    return result.rowCount === 1 && readback.rows[0]?.policy_version === COUNTRY_CLUB_POLICY_VERSION;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
