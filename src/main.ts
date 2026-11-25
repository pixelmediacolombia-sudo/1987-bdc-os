import { loadAppConfig } from "@/infrastructure/config/env.config";
import { createPostgresPool } from "@/infrastructure/database/postgres-pool";
import { IoredisClient } from "@/modules/control/infrastructure/redis/ioredis-client";
import { initializeDatabase } from "@/infrastructure/startup/database-initializer";
import { createBackendRuntime } from "@/infrastructure/startup/create-backend-runtime";

async function start(): Promise<void> {
  const config = loadAppConfig();
  const pool = createPostgresPool(config.databaseUrl, config.pgSsl);
  const migrationPool = config.migrationDatabaseUrl
    ? createPostgresPool(config.migrationDatabaseUrl, config.pgSsl)
    : pool;
  const redis = new IoredisClient(config.redisUrl);
  try {
    await initializeDatabase(migrationPool);
  } finally {
    if (migrationPool !== pool) await migrationPool.end();
  }
  const runtime = await createBackendRuntime(config, pool, redis);
  const server = runtime.app.listen(config.port, () => console.log(`1987 BDC OS backend listening on port ${config.port}`));

  const shutdown = (signal: string) => {
    console.log(`Received ${signal}; shutting down`);
    server.close(() => void runtime.shutdown());
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch((error: unknown) => {
  console.error("Backend startup failed", error instanceof Error ? error.message : "unknown error");
  process.exitCode = 1;
});
