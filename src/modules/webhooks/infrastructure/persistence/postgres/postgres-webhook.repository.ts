import type { Pool, PoolClient } from "pg";
import type { GhlWebhookEvent, InboundMessage } from "@/modules/webhooks/domain/ghl-webhook-event";
import { GhlTenantNotFoundError } from "@/modules/webhooks/domain/ghl-webhook-event";
import type {
  WebhookProcessResult,
  WebhookRepository,
} from "@/modules/webhooks/application/ports/webhook-repository.port";

type TenantRow = { tenant_id: string };
type ContactRow = { id: string };
type ConversationRow = { id: string };

export class PostgresWebhookRepository implements WebhookRepository {
  constructor(private readonly pool: Pool) {}

  async process(event: GhlWebhookEvent): Promise<WebhookProcessResult> {
    const client = await this.pool.connect();
    let tenantId: string | undefined;

    try {
      await client.query("BEGIN");
      tenantId = await this.resolveTenant(client, event.locationId);
      await this.setTenantContext(client, tenantId);

      const rawEvent = await client.query<{ id: string }>(
        `INSERT INTO public.raw_webhooks
           (tenant_id, external_id, event_type, location_id, signature, payload, status)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'received')
         ON CONFLICT (tenant_id, external_id) DO NOTHING
         RETURNING id`,
        [
          tenantId,
          event.externalId,
          event.eventType,
          event.locationId,
          event.signature,
          JSON.stringify(event.payload),
        ],
      );

      if (rawEvent.rowCount === 0) {
        await client.query("COMMIT");
        console.info(`Duplicate event [${event.externalId}] ignored.`);
        return { duplicate: true, tenantId };
      }

      if (event.inboundMessage) {
        await this.persistInboundMessage(client, tenantId, event.inboundMessage);
      }

      await client.query(
        `UPDATE public.raw_webhooks
            SET status = 'processed', processed_at = now(), error_message = NULL
          WHERE id = $1`,
        [rawEvent.rows[0].id],
      );
      await client.query("COMMIT");
      return { duplicate: false, tenantId };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (tenantId) await this.recordFailedEvent(event, tenantId, error);
      throw error;
    } finally {
      client.release();
    }
  }

  private async resolveTenant(client: PoolClient, locationId: string): Promise<string> {
    const result = await client.query<TenantRow>(
      "SELECT public.resolve_ghl_tenant_id($1) AS tenant_id",
      [locationId],
    );
    const tenantId = result.rows[0]?.tenant_id;
    if (!tenantId) throw new GhlTenantNotFoundError(locationId);
    return tenantId;
  }

  private async setTenantContext(client: PoolClient, tenantId: string): Promise<void> {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  }

  private async persistInboundMessage(
    client: PoolClient,
    tenantId: string,
    message: InboundMessage,
  ): Promise<void> {
    const contact = await client.query<ContactRow>(
      `INSERT INTO public.contacts AS c
         (tenant_id, ghl_contact_id, phone, email, preferred_language, consent_state)
       VALUES ($1, $2, $3, $4, 'unknown', 'unknown')
       ON CONFLICT (tenant_id, ghl_contact_id) DO UPDATE SET
         phone = COALESCE(EXCLUDED.phone, c.phone),
         email = COALESCE(EXCLUDED.email, c.email),
         updated_at = now()
       RETURNING id`,
      [tenantId, message.contactId, message.phone ?? null, message.email ?? null],
    );

    if (contact.rowCount !== 1 || !contact.rows[0]) {
      throw new Error("GHL contact was not persisted");
    }

    const conversation = await this.findOrCreateConversation(
      client,
      tenantId,
      contact.rows[0].id,
      message.channel,
    );

    await client.query(
      `INSERT INTO public.messages
         (tenant_id, conversation_id, external_id, direction, sender_type, content, semantic_hash, status)
       VALUES ($1, $2, $3, 'inbound', 'client', $4, $5, 'received')
       ON CONFLICT DO NOTHING`,
      [tenantId, conversation.id, message.externalId, message.content, message.semanticHash],
    );

    await client.query(
      `UPDATE public.conversations
          SET last_activity = now(), state = 'open'
        WHERE id = $1`,
      [conversation.id],
    );
  }

  private async findOrCreateConversation(
    client: PoolClient,
    tenantId: string,
    contactId: string,
    channel: string,
  ): Promise<ConversationRow> {
    const existing = await client.query<ConversationRow>(
      `SELECT id
         FROM public.conversations
        WHERE tenant_id = $1 AND contact_id = $2 AND channel = $3
        ORDER BY last_activity DESC NULLS LAST
        LIMIT 1
        FOR UPDATE`,
      [tenantId, contactId, channel],
    );
    if (existing.rowCount === 1 && existing.rows[0]) return existing.rows[0];

    const created = await client.query<ConversationRow>(
      `INSERT INTO public.conversations (tenant_id, contact_id, channel, owner, state, last_activity)
       VALUES ($1, $2, $3, 'ghl', 'open', now())
       RETURNING id`,
      [tenantId, contactId, channel],
    );
    if (created.rowCount !== 1 || !created.rows[0]) {
      throw new Error("GHL conversation was not persisted");
    }
    return created.rows[0];
  }

  private async recordFailedEvent(event: GhlWebhookEvent, tenantId: string, error: unknown): Promise<void> {
    const failureClient = await this.pool.connect();
    try {
      await failureClient.query("BEGIN");
      await this.setTenantContext(failureClient, tenantId);
      await failureClient.query(
        `INSERT INTO public.raw_webhooks
           (tenant_id, external_id, event_type, location_id, signature, payload, status, error_message)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'failed', $7)
         ON CONFLICT (tenant_id, external_id) DO UPDATE SET
           status = 'failed',
           error_message = EXCLUDED.error_message`,
        [
          tenantId,
          event.externalId,
          event.eventType,
          event.locationId,
          event.signature,
          JSON.stringify(event.payload),
          error instanceof Error ? error.message.slice(0, 1000) : "unknown error",
        ],
      );
      await failureClient.query("COMMIT");
    } catch {
      await failureClient.query("ROLLBACK").catch(() => undefined);
    } finally {
      failureClient.release();
    }
  }
}
