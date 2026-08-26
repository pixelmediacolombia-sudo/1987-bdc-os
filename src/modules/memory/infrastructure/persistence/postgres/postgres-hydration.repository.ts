import type { Pool, QueryResultRow } from "pg";
import { HydrationNotFoundError } from "@/modules/memory/domain/hydrated-context";
import type {
  ActiveFact,
  ContactConversation,
  HydrationRepositoryPort,
  ObjectiveLedgerEntry,
  RecentTranscriptMessage,
  TenantProfile,
} from "@/modules/memory/application/ports/hydration-repository.port";

type TenantRow = {
  id: string;
  timezone: string;
  policy_version: string;
  status: string;
  sofia_enabled: boolean;
  qualification_flow_enabled: boolean;
  qualification_signal_enabled: boolean;
};
type ContactConversationRow = {
  contact_id: string;
  ghl_contact_id: string;
  preferred_language: string;
  consent_state: string;
  conversation_id: string;
  channel: string;
  state: string;
};
type TranscriptRow = {
  direction: RecentTranscriptMessage["direction"];
  sender_type: RecentTranscriptMessage["senderType"];
  content: string;
  created_at: Date;
};
type FactRow = { fact_key: string; fact_value: string | null };
type ObjectiveRow = { objective_type: string; asked: boolean; answered: boolean; skipped: boolean };

export class PostgresHydrationRepository implements HydrationRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async loadTenant(tenantId: string): Promise<TenantProfile> {
    const rows = await this.readWithTenant<TenantRow>(tenantId, `
      SELECT dealer_id::text AS id, timezone, policy_version, status,
             sofia_enabled, qualification_flow_enabled, qualification_signal_enabled
        FROM public.tenants
       WHERE dealer_id = $1
       LIMIT 1`, [tenantId]);
    const row = rows[0];
    if (!row) throw new HydrationNotFoundError("tenant", tenantId);
    return {
      id: row.id,
      timezone: row.timezone,
      policyVersion: row.policy_version,
      status: row.status,
      flags: {
        sofiaEnabled: row.sofia_enabled,
        qualificationFlowEnabled: row.qualification_flow_enabled,
        qualificationSignalEnabled: row.qualification_signal_enabled,
      },
    };
  }

  async loadContactConversation(tenantId: string, ghlContactId: string): Promise<ContactConversation> {
    const rows = await this.readWithTenant<ContactConversationRow>(tenantId, `
      SELECT c.id::text AS contact_id, c.ghl_contact_id, c.preferred_language, c.consent_state,
             conversation.id::text AS conversation_id, conversation.channel, conversation.state
        FROM public.contacts AS c
        JOIN LATERAL (
          SELECT cv.id, cv.channel, cv.state
            FROM public.conversations AS cv
           WHERE cv.tenant_id = c.tenant_id AND cv.contact_id = c.id
           ORDER BY cv.last_activity DESC NULLS LAST, cv.id DESC
           LIMIT 1
        ) AS conversation ON true
       WHERE c.tenant_id = $1 AND c.ghl_contact_id = $2
       LIMIT 1`, [tenantId, ghlContactId]);
    const row = rows[0];
    if (!row) throw new HydrationNotFoundError("contact", ghlContactId);
    return {
      contact: { id: row.contact_id, ghlContactId: row.ghl_contact_id, preferredLanguage: row.preferred_language, consentState: row.consent_state },
      conversation: { id: row.conversation_id, channel: row.channel, state: row.state },
    };
  }

  async loadRecentTranscript(tenantId: string, conversationId: string, limit: number): Promise<RecentTranscriptMessage[]> {
    const rows = await this.readWithTenant<TranscriptRow>(tenantId, `SELECT direction, sender_type, content, created_at FROM public.messages WHERE tenant_id = $1 AND conversation_id = $2 ORDER BY created_at DESC LIMIT $3`, [tenantId, conversationId, limit]);
    return rows.reverse().map((row) => ({ direction: row.direction, senderType: row.sender_type, content: row.content, createdAt: row.created_at }));
  }

  async loadActiveFacts(tenantId: string, contactId: string): Promise<ActiveFact[]> {
    const rows = await this.readWithTenant<FactRow>(tenantId, `SELECT key AS fact_key, value AS fact_value FROM public.facts WHERE tenant_id = $1 AND contact_id = $2 AND active = true ORDER BY key ASC, observed_at DESC`, [tenantId, contactId]);
    return rows.map((row) => ({ key: row.fact_key, value: row.fact_value ?? "" }));
  }

  async loadObjectives(tenantId: string, contactId: string): Promise<ObjectiveLedgerEntry[]> {
    const rows = await this.readWithTenant<ObjectiveRow>(tenantId, `SELECT objective_type, asked, answered, skipped FROM public.objectives WHERE tenant_id = $1 AND contact_id = $2 ORDER BY objective_type ASC`, [tenantId, contactId]);
    return rows.map((row) => ({ objectiveType: row.objective_type, asked: row.asked, answered: row.answered, skipped: row.skipped }));
  }

  private async readWithTenant<T extends QueryResultRow>(tenantId: string, sql: string, values: unknown[]): Promise<T[]> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await client.query<T>(sql, values);
      await client.query("COMMIT");
      return result.rows;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
