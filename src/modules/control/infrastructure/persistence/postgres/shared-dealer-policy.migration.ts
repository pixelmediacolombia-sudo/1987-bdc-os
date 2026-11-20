import type { Pool } from "pg";

export const SHARED_DEALER_POLICY_VERSION = "shared_dealer_v1";

/** Assigns the shared baseline to every dealer while retaining each tenant's other settings. */
export async function ensureSharedDealerPolicy(pool: Pool): Promise<boolean> {
  const tenants = await pool.query<{ tenant_id: string }>(
    "SELECT dealer_id::text AS tenant_id FROM public.tenants ORDER BY dealer_id",
  );
  let changed = false;
  for (const { tenant_id: tenantId } of tenants.rows) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await client.query(
        `UPDATE public.tenants SET policy_version = $1
          WHERE dealer_id = $2 AND policy_version IS DISTINCT FROM $1`,
        [SHARED_DEALER_POLICY_VERSION, tenantId],
      );
      changed ||= result.rowCount === 1;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
  return changed;
}
