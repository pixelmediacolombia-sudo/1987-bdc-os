import { loadAppConfig } from "@/infrastructure/config/env.config";
import { createPostgresPool } from "@/infrastructure/database/postgres-pool";
import { ensureWebhookTables } from "@/modules/webhooks/infrastructure/persistence/postgres/webhooks.migration";
import { ensureMemoryTables } from "@/modules/memory/infrastructure/persistence/postgres/memory.migration";
import { ensureDecisionLogsTable } from "@/modules/decisions/infrastructure/persistence/postgres/decision-logs.migration";
import { ensureQualificationSignalTables } from "@/modules/webhooks/infrastructure/persistence/postgres/qualification-signals.migration";
import { ensureTenantFeatureFlags } from "@/modules/control/infrastructure/persistence/postgres/tenant-flags.migration";
import { ensureSharedDealerPolicy } from "@/modules/control/infrastructure/persistence/postgres/shared-dealer-policy.migration";
import { ensureConversationAiShadowTables } from "@/modules/control/infrastructure/persistence/postgres/conversation-ai-shadow.migration";
import { ensureInternalDiagnosticAuditTable } from "@/presentation/http/internal-diagnostic-audit.migration";
import { ensureIdentityTables } from "@/features/identity/infrastructure/persistence/postgres/identity.migration";
import { ensureConversationWorkflowColumns } from "@/features/contacts/infrastructure/persistence/postgres/conversation-workflow.migration";
import { ensureConversationMessageDelivery } from "@/features/contacts/infrastructure/persistence/postgres/conversation-messages.migration";
import { ensureAdminAuditTable } from "@/features/identity/infrastructure/persistence/postgres/admin-audit.migration";
import { ensureTenantRowLevelSecurity } from "@/features/identity/infrastructure/persistence/postgres/tenant-rls.migration";
import { ensureOpportunitiesTable } from "@/features/opportunities/infrastructure/persistence/postgres/opportunities.migration";
import { ensureAppointmentsTables } from "@/features/appointments/infrastructure/persistence/postgres/appointments.migration";
import { ensureAutomationEventOutbox } from "@/modules/automations/infrastructure/persistence/postgres/automation-event-outbox.migration";

async function main(): Promise<void> {
  const config = loadAppConfig();
  const pool = createPostgresPool(config.databaseUrl, config.pgSsl);
  try {
    await ensureWebhookTables(pool);
    await ensureIdentityTables(pool);
    await ensureConversationWorkflowColumns(pool);
    await ensureConversationMessageDelivery(pool);
    await ensureAdminAuditTable(pool);
    await ensureOpportunitiesTable(pool);
    await ensureAppointmentsTables(pool);
    await ensureAutomationEventOutbox(pool);
    await ensureTenantFeatureFlags(pool);
    await ensureMemoryTables(pool);
    await ensureDecisionLogsTable(pool);
    await ensureQualificationSignalTables(pool);
    await ensureConversationAiShadowTables(pool);
    await ensureInternalDiagnosticAuditTable(pool);
    const sharedDealerActivated = await ensureSharedDealerPolicy(pool);
    await ensureTenantRowLevelSecurity(pool);
    console.log(`Database migration completed: webhooks, identity, tenant flags, facts, objectives, Sofia state, qualification signals, Meta messaging, and shared dealer policy baseline are ready (shared_dealer_activated=${sharedDealerActivated}).`);
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

