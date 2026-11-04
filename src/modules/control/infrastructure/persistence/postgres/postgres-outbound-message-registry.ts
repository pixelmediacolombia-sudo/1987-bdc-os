import type { Pool, PoolClient } from "pg";
import type {
  OutboundMessageRegistryEntry,
  OutboundMessageReservation,
  OutboundMessageRegistryPort,
} from "@/modules/control/application/ports/outbound-message-registry.port";

export class PostgresOutboundMessageRegistry implements OutboundMessageRegistryPort {
  constructor(private readonly pool: Pool) {}

  async register(entry: OutboundMessageRegistryEntry): Promise<OutboundMessageReservation> {
    return this.withTenantContext(entry.tenantId, async (client) => {
      const result = await client.query<OutboundMessageReservation>(
        `INSERT INTO public.outbound_message_registry
           (tenant_id, contact_id, semantic_hash, provider_message_id, content, status)
         VALUES ($1, $2, $3, $4, $5, 'reserved')
         RETURNING attempt_id AS "attemptId", expires_at AS "expiresAt"`,
        [entry.tenantId, entry.contactId, entry.semanticHash, entry.providerMessageId ?? null, entry.content],
      );
      if (result.rowCount !== 1 || !result.rows[0]) throw new Error("Outbound registry reservation was not created");
      return result.rows[0];
    });
  }

  async attachProviderMessageId(input: {
    tenantId: string;
    attemptId: string;
    providerMessageId: string;
  }): Promise<void> {
    await this.withTenantContext(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE public.outbound_message_registry
            SET provider_message_id = $3,
                status = 'sent'
          WHERE tenant_id = $1
            AND attempt_id = $2
            AND status = 'reserved'
            AND expires_at > now()
            AND provider_message_id IS NULL`,
        [input.tenantId, input.attemptId, input.providerMessageId],
      );
      if (result.rowCount !== 1) throw new Error("Outbound registry reservation was not found");
    });
  }

  async markFailed(input: { tenantId: string; attemptId: string }): Promise<void> {
    await this.withTenantContext(input.tenantId, (client) => client.query(
      `UPDATE public.outbound_message_registry
          SET status = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'failed' END
        WHERE tenant_id = $1
          AND attempt_id = $2
          AND status = 'reserved'`,
      [input.tenantId, input.attemptId],
    ).then(() => undefined));
  }

  async markDeliveryUncertain(input: {
    tenantId: string;
    attemptId: string;
    providerMessageId: string;
    reason: string;
  }): Promise<void> {
    await this.withTenantContext(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE public.outbound_message_registry
            SET provider_message_id = $3,
                status = 'uncertain',
                uncertainty_reason = left($4, 1000),
                uncertainty_detected_at = now(),
                updated_at = now()
          WHERE tenant_id = $1
            AND attempt_id = $2
            AND status IN ('reserved', 'expired')`,
        [input.tenantId, input.attemptId, input.providerMessageId, input.reason],
      );
      if (result.rowCount !== 1) throw new Error("Outbound uncertain delivery was not found");
    });
  }

  async listDeliveryUncertainties(tenantId: string) {
    return this.withTenantContext(tenantId, async (client) => {
      const result = await client.query<{
        attempt_id: string;
        contact_id: string;
        provider_message_id: string;
        content: string;
        uncertainty_reason: string;
        uncertainty_detected_at: Date;
        reconciliation_attempts: number;
        last_reconciliation_error: string | null;
      }>(
        `SELECT attempt_id, contact_id, provider_message_id, content,
                uncertainty_reason, uncertainty_detected_at,
                reconciliation_attempts, last_reconciliation_error
           FROM public.outbound_message_registry
          WHERE tenant_id = $1 AND status = 'uncertain'
          ORDER BY uncertainty_detected_at ASC`,
        [tenantId],
      );
      return result.rows.map((row) => ({
        tenantId,
        attemptId: row.attempt_id,
        contactId: row.contact_id,
        providerMessageId: row.provider_message_id,
        content: row.content,
        uncertaintyReason: row.uncertainty_reason,
        detectedAt: row.uncertainty_detected_at,
        reconciliationAttempts: row.reconciliation_attempts,
        ...(row.last_reconciliation_error ? { lastReconciliationError: row.last_reconciliation_error } : {}),
      }));
    });
  }

  async recordDeliveryReconciliationAttempt(input: {
    tenantId: string;
    attemptId: string;
    result: "found" | "not_found" | "unknown";
    providerStatus?: string;
    error?: string;
  }): Promise<void> {
    await this.withTenantContext(input.tenantId, (client) => client.query(
      `UPDATE public.outbound_message_registry
          SET reconciliation_attempts = reconciliation_attempts + 1,
              last_reconciliation_result = $3,
              last_provider_status = COALESCE($4, last_provider_status),
              last_reconciliation_error = left($5, 1000),
              updated_at = now()
        WHERE tenant_id = $1 AND attempt_id = $2 AND status = 'uncertain'`,
      [input.tenantId, input.attemptId, input.result, input.providerStatus ?? null, input.error ?? null],
    ).then(() => undefined));
  }

  async resolveDeliveryUncertainty(input: {
    tenantId: string;
    attemptId: string;
    resolution: "confirmed" | "not_found" | "cancelled";
    reviewer: string;
    providerStatus?: string;
  }): Promise<void> {
    await this.withTenantContext(input.tenantId, async (client) => {
      const result = await client.query(
        `UPDATE public.outbound_message_registry
            SET status = CASE WHEN $3 = 'confirmed' THEN 'sent' ELSE 'failed' END,
                resolution = $3,
                resolved_by = left($4, 160),
                resolved_at = now(),
                last_provider_status = COALESCE($5, last_provider_status),
                updated_at = now()
          WHERE tenant_id = $1 AND attempt_id = $2 AND status = 'uncertain'`,
        [input.tenantId, input.attemptId, input.resolution, input.reviewer, input.providerStatus ?? null],
      );
      if (result.rowCount !== 1) throw new Error("Outbound uncertain delivery was not open");
    });
  }

  async wasIssuedBy1987(input: {
    tenantId: string;
    contactId: string;
    semanticHash?: string;
    providerMessageId?: string;
    content?: string;
  }): Promise<boolean> {
    return this.withTenantContext(input.tenantId, async (client) => {
      const result = await client.query(
        `SELECT 1
          FROM public.outbound_message_registry
          WHERE tenant_id = $1
            AND contact_id = $2
            AND (
              ($3::text IS NOT NULL AND provider_message_id = $3 AND status = 'sent')
              OR
              ($4::text IS NOT NULL AND semantic_hash = $4 AND status = 'reserved' AND expires_at > now())
              OR
              (
                $5::text IS NOT NULL
                AND status = 'reserved'
                AND expires_at > now()
                AND regexp_replace(btrim(lower(content)), '[[:space:]]+', ' ', 'g')
                  = regexp_replace(btrim(lower($5::text)), '[[:space:]]+', ' ', 'g')
              )
            )
          LIMIT 1`,
        [input.tenantId, input.contactId, input.providerMessageId ?? null, input.semanticHash ?? null, input.content ?? null],
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
