import type { Pool } from "pg";
import type {
  OutboundMessageRegistryEntry,
  OutboundMessageRegistryPort,
} from "@/modules/control/application/ports/outbound-message-registry.port";

export class PostgresOutboundMessageRegistry implements OutboundMessageRegistryPort {
  constructor(private readonly pool: Pool) {}

  async register(entry: OutboundMessageRegistryEntry): Promise<void> {
    await this.pool.query(
      `INSERT INTO public.outbound_message_registry
         (tenant_id, contact_id, semantic_hash, provider_message_id, content)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, contact_id, semantic_hash) DO NOTHING`,
      [entry.tenantId, entry.contactId, entry.semanticHash, entry.providerMessageId ?? null, entry.content],
    );
  }

  async wasIssuedBy1987(input: {
    tenantId: string;
    contactId: string;
    semanticHash: string;
    providerMessageId?: string;
  }): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1
         FROM public.outbound_message_registry
        WHERE tenant_id = $1
          AND contact_id = $2
          AND (semantic_hash = $3 OR ($4::text IS NOT NULL AND provider_message_id = $4))
        LIMIT 1`,
      [input.tenantId, input.contactId, input.semanticHash, input.providerMessageId ?? null],
    );
    return result.rowCount === 1;
  }
}
