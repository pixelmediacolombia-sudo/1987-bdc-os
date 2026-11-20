import { Pool } from "pg";

export function createPostgresPool(databaseUrl: string, ssl: boolean): Pool {
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: ssl ? { rejectUnauthorized: false } : undefined,
  });
  pool.on("error", () => console.error("Unexpected PostgreSQL pool error"));
  return pool;
}
