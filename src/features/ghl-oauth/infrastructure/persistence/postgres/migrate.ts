import { loadAppConfig } from "@/features/ghl-oauth/infrastructure/config/env.config";
import { createPostgresPool } from "@/features/ghl-oauth/infrastructure/persistence/postgres/pool";
import { ensureIntegrationsTable } from "@/features/ghl-oauth/infrastructure/persistence/postgres/integrations.migration";
import { ensureWebhookTables } from "@/modules/webhooks/infrastructure/persistence/postgres/webhooks.migration";
import { ensureMemoryTables } from "@/modules/memory/infrastructure/persistence/postgres/memory.migration";
import { ensureDecisionLogsTable } from "@/modules/decisions/infrastructure/persistence/postgres/decision-logs.migration";

async function main(): Promise<void> {
  const config = loadAppConfig();
  const pool = createPostgresPool(config.databaseUrl, config.pgSsl);
  try {
    await ensureIntegrationsTable(pool);
    await ensureWebhookTables(pool);
    await ensureMemoryTables(pool);
    await ensureDecisionLogsTable(pool);
    console.log("Database migration completed: integrations, webhooks, facts, and objectives are ready.");
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    const databaseError = error as Error & { code?: string; detail?: string; hint?: string };
    console.error("Database migration failed:", {
      name: databaseError.name,
      message: databaseError.message,
      code: databaseError.code,
      detail: databaseError.detail,
      hint: databaseError.hint,
    });
  } else {
    console.error("Database migration failed: unknown error");
  }
  process.exitCode = 1;
});
