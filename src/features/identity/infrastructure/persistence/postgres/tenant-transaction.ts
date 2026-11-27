import type { Pool, PoolClient } from "pg";

export async function withTenant<T>(
  pool: Pool,
  tenantId: string,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, "app.tenant_id", tenantId, action);
}

export async function withUser<T>(
  pool: Pool,
  userId: string,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  return withTransaction(pool, "app.user_id", userId, action);
}

async function withTransaction<T>(
  pool: Pool,
  setting: "app.tenant_id" | "app.user_id",
  value: string,
  action: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const contextQuery = setting === "app.tenant_id"
      ? "SELECT set_config('app.tenant_id', $1, true)"
      : "SELECT set_config('app.user_id', $1, true)";
    await client.query(contextQuery, [value]);
    const result = await action(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
