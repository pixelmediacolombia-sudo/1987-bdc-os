import type { Pool } from "pg";
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
import { bootstrapLocalAdmin } from "@/features/identity/infrastructure/persistence/postgres/local-admin.bootstrap";
import { ensureMetaMessagingTables } from "@/features/meta/infrastructure/persistence/postgres/meta-messaging.migration";
import { ensureOpportunitiesTable } from "@/features/opportunities/infrastructure/persistence/postgres/opportunities.migration";
import { ensureAppointmentsTables } from "@/features/appointments/infrastructure/persistence/postgres/appointments.migration";
import { ensureRuntimeRolePrivileges } from "@/infrastructure/database/runtime-role.migration";
import { ensureAutomationEventOutbox } from "@/modules/automations/infrastructure/persistence/postgres/automation-event-outbox.migration";
import { ensureAutomationWorkflows } from "@/modules/automations/infrastructure/persistence/postgres/automation-workflows.migration";
import { ensureAutomationEngine } from "@/modules/automations/infrastructure/persistence/postgres/automation-engine.migration";

export async function initializeDatabase(pool: Pool): Promise<void> {
  await ensureWebhookTables(pool);
  await ensureIdentityTables(pool);
  await ensureConversationWorkflowColumns(pool);
  await ensureConversationMessageDelivery(pool);
  await ensureAdminAuditTable(pool);
  await ensureOpportunitiesTable(pool);
  await ensureAppointmentsTables(pool);
  await ensureAutomationEventOutbox(pool);
  await ensureAutomationWorkflows(pool);
  await ensureAutomationEngine(pool);
  const localAdminCreated = await bootstrapLocalAdmin(pool);
  if (localAdminCreated) console.info("[Identity] local platform admin bootstrapped");
  await ensureTenantFeatureFlags(pool);
  await ensureMemoryTables(pool);
  const sharedDealerActivated = await ensureSharedDealerPolicy(pool);
  console.info(`[SharedDealerPolicy] baseline=shared_dealer_v1 dealer_overrides=planned migrated=${sharedDealerActivated}`);
  await ensureDecisionLogsTable(pool);
  await ensureQualificationSignalTables(pool);
  await ensureMetaMessagingTables(pool);
  await ensureConversationAiShadowTables(pool);
  await ensureInternalDiagnosticAuditTable(pool);
  await ensureTenantRowLevelSecurity(pool);
  await ensureRuntimeRolePrivileges(pool);
}


