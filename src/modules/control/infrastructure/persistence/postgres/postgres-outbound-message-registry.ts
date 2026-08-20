import type { Pool, PoolClient } from "pg";
import type {
  OutboundMessageRegistryEntry,
  OutboundMessageRegistryPort,
} from "@/modules/control/application/ports/outbound-message-registry.port";

export class PostgresOutboundMessageRegistry implements OutboundMessageRegistryPort {
  constructor(private readonly pool: Pool) {}

  async register(entry: OutboundMessageRegistryEntry): Promise<void> {
    await this.withTenantContext(entry.tenantId, (client) => client.query(
        `INSERT INTO public.outbound_message_registry
           (tenant_id, contact_id, semantic_hash, provider_message_id, content)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (tenant_id, contact_id, semantic_hash) DO NOTHING`,
        [entry.tenantId, entry.contactId, entry.semanticHash, entry.providerMessageId ?? null, entry.content],
      ));
  }

  async attachProviderMessageId(input: {
    tenantId: string;
    contactId: string;
    semanticHash: string;
    providerMessageId: string;
  }): Promise<void> {
    await this.withTenantContext(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE public.outbound_message_registry
            SET provider_message_id = $4
          WHERE tenant_id = $1
            AND contact_id = $2
            AND semantic_hash = $3
            AND provider_message_id IS NULL`,
        [input.tenantId, input.contactId, input.semanticHash, input.providerMessageId],
      );
      if (result.rowCount !== 1) throw new Error("Outbound registry reservation was not found");
    });
  }

  async wasIssuedBy1987(input: {
    tenantId: string;
    contactId: string;
    semanticHash: string;
    providerMessageId?: string;
  }): Promise<boolean> {
    return this.withTenantContext(input.tenantId, async (client) => {
      const result = await client.query(
        `SELECT 1
           FROM public.outbound_message_registry
          WHERE tenant_id = $1
            AND contact_id = $2
            AND (semantic_hash = $3 OR ($4::text IS NOT NULL AND provider_message_id = $4))
          LIMIT 1`,
        [input.tenantId, input.contactId, input.semanticHash, input.providerMessageId ?? null],
      );
      return result.rowCount === 1;
    });
  }

  private async withTenantContext<T>(tenantId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) throw new Error("Outbound registry tenantId cannot be empty");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [normalizedTenantId]);
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
