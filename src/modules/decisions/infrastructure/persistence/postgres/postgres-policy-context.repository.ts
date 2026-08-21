import type { Pool, PoolClient } from "pg";
import type { PolicyPackProviderPort } from "@/modules/memory/application/ports/policy-pack.provider.port";
import type { PolicyContextRepositoryPort } from "@/modules/decisions/application/ports/policy-context-repository.port";
import type { PolicyContext } from "@/modules/decisions/domain/policy-context";

type TenantRow = { id: string; timezone: string; policy_version: string; status: string };
type ContactRow = { id: string; ghl_contact_id: string; consent_state: string };
type MessageRow = { content: string };
type FactRow = { fact_key: string; fact_value: string | null };

export class PostgresPolicyContextRepository implements PolicyContextRepositoryPort {
  constructor(
    private readonly pool: Pool,
    private readonly policyProvider: PolicyPackProviderPort,
  ) {}

  async load(tenantId: string, ghlContactId: string): Promise<PolicyContext> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const tenant = await this.loadTenant(client, tenantId);
      const contact = await this.loadContact(client, tenantId, ghlContactId);
      const latestInbound = await client.query<MessageRow>(
        `SELECT m.content
           FROM public.messages AS m
           JOIN public.conversations AS cv
             ON cv.id = m.conversation_id AND cv.tenant_id = m.tenant_id
          WHERE m.tenant_id = $1
            AND cv.contact_id = $2
            AND m.direction = 'inbound'
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 1`,
        [tenantId, contact.id],
      );
      const facts = await client.query<FactRow>(
        `SELECT key AS fact_key, value AS fact_value
           FROM public.facts
          WHERE tenant_id = $1 AND contact_id = $2 AND active = true
          ORDER BY key ASC, observed_at DESC`,
        [tenantId, contact.id],
      );
      await client.query("COMMIT");
      const policies = await this.policyProvider.load(tenant.policy_version);
      return {
        tenant: {
          id: tenant.id,
          timezone: tenant.timezone,
          policyVersion: tenant.policy_version,
          status: tenant.status,
          policies,
        },
        contact: {
          id: contact.id,
          ghlContactId: contact.ghl_contact_id,
          consentState: contact.consent_state,
        },
        ...(latestInbound.rows[0]?.content ? { lastInboundMessage: latestInbound.rows[0].content } : {}),
        activeFacts: Object.fromEntries(facts.rows.map((fact) => [fact.fact_key, fact.fact_value ?? ""])),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async loadTenant(client: PoolClient, tenantId: string): Promise<TenantRow> {
    const result = await client.query<TenantRow>(
      `SELECT dealer_id::text AS id, timezone, policy_version, status
         FROM public.tenants
        WHERE dealer_id = $1
        LIMIT 1`,
      [tenantId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Policy tenant ${tenantId} was not found`);
    return row;
  }

  private async loadContact(client: PoolClient, tenantId: string, ghlContactId: string): Promise<ContactRow> {
    const result = await client.query<ContactRow>(
      `SELECT id::text AS id, ghl_contact_id, consent_state
         FROM public.contacts
        WHERE tenant_id = $1 AND ghl_contact_id = $2
        LIMIT 1`,
      [tenantId, ghlContactId],
    );
    const row = result.rows[0];
    if (!row) throw new Error(`Policy contact ${ghlContactId} was not found`);
    return row;
  }
}
