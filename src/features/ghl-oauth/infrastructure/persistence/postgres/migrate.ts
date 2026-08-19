import { loadAppConfig } from "@/features/ghl-oauth/infrastructure/config/env.config";
import { createPostgresPool } from "@/features/ghl-oauth/infrastructure/persistence/postgres/pool";
import { ensureIntegrationsTable } from "@/features/ghl-oauth/infrastructure/persistence/postgres/integrations.migration";
import { ensureWebhookTables } from "@/modules/webhooks/infrastructure/persistence/postgres/webhooks.migration";

async function main(): Promise<void> {
  const config = loadAppConfig();
  const pool = createPostgresPool(config.databaseUrl, config.pgSsl);
  try {
    await ensureIntegrationsTable(pool);
    await ensureWebhookTables(pool);
    console.log("Database migration completed: public.integrations is ready.");
  } finally {
    await pool.end();
  }
}

main().catch(() => {
  console.error("Database migration failed.");
  process.exitCode = 1;
});
