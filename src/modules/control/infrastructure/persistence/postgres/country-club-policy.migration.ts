import type { Pool } from "pg";

export const COUNTRY_CLUB_POLICY_VERSION = "country_club_cars_v8";
export const DEFAULT_COUNTRY_CLUB_GHL_LOCATION_ID = "k9DePpsNBu9qWT1C6pW0";

/** Activates only the explicitly identified Country Club tenant. */
export async function ensureCountryClubPolicy(
  pool: Pool,
  ghlLocationId = process.env.COUNTRY_CLUB_GHL_LOCATION_ID?.trim() || DEFAULT_COUNTRY_CLUB_GHL_LOCATION_ID,
): Promise<boolean> {
  if (!ghlLocationId) throw new Error("Country Club GHL location id cannot be empty");
  await pool.query("BEGIN");
  try {
    const result = await pool.query<{ ghl_location_id: string }>(
      `UPDATE public.tenants
          SET policy_version = $1
        WHERE ghl_location_id = $2
        RETURNING ghl_location_id`,
      [COUNTRY_CLUB_POLICY_VERSION, ghlLocationId],
    );
    await pool.query("COMMIT");
    return result.rowCount === 1;
  } catch (error) {
    await pool.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}
