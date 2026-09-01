import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  GhlWebhookEvent,
  HumanInterruption,
  InboundMessage,
} from "@/modules/webhooks/domain/ghl-webhook-event";
import { GhlTenantNotFoundError } from "@/modules/webhooks/domain/ghl-webhook-event";
import type {
  WebhookProcessResult,
  WebhookStage,
  WebhookStageClaim,
  WebhookRepository,
} from "@/modules/webhooks/application/ports/webhook-repository.port";
import type { OutboundMessageRegistryPort } from "@/modules/control/application/ports/outbound-message-registry.port";

type TenantRow = { tenant_id: string };
type ContactRow = { id: string };
type ConversationRow = { id: string };
type RawWebhookRow = {
  id: string;
  status: WebhookStage;
  suppression_required: boolean;
};

export class PostgresWebhookRepository implements WebhookRepository {
  constructor(
    private readonly pool: Pool,
    private readonly outboundRegistry?: OutboundMessageRegistryPort,
  ) {}

  async process(event: GhlWebhookEvent): Promise<WebhookProcessResult> {
    const client = await this.pool.connect();
    let tenantId: string | undefined;

    try {
      await client.query("BEGIN");
      tenantId = await this.resolveTenant(client, event.locationId);
      await this.setTenantContext(client, tenantId);

      const rawEvent = await client.query<RawWebhookRow>(
        `INSERT INTO public.raw_webhooks
           (tenant_id, external_id, event_type, location_id, signature, payload, status, suppression_required)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, 'received', false)
         ON CONFLICT (tenant_id, external_id) DO NOTHING
         RETURNING id, status, suppression_required`,
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
        const existing = await client.query<RawWebhookRow>(
          `SELECT id, status, suppression_required
             FROM public.raw_webhooks
            WHERE tenant_id = $1 AND external_id = $2
            FOR UPDATE`,
          [tenantId, event.externalId],
        );
        const row = existing.rows[0];
        if (!row) throw new Error("Persisted webhook row was not found after conflict");

        if (row.status !== "failed" && row.status !== "received") {
          await client.query("COMMIT");
          console.info(`Webhook event [${event.externalId}] resumed at stage=${row.status}`);
          return {
            duplicate: true,
            tenantId,
            suppressAi: row.suppression_required,
            stage: row.status,
          };
        }

        await client.query(
          `UPDATE public.raw_webhooks
              SET status = 'received', error_message = NULL, stage_claim = NULL, stage_claimed_at = NULL
            WHERE id = $1`,
          [row.id],
        );
        rawEvent.rows = [row];
      }

      if (event.inboundMessage) {
        await this.persistInboundMessage(client, tenantId, event.inboundMessage);
      }

      const suppressAi = event.humanInterruption
        ? await this.persistHumanInterruption(client, tenantId, event.humanInterruption)
        : undefined;

      const controlTag = event.humanInterruption?.controlTag?.trim().toLowerCase();
      // Keep inbound events in the existing durable `received` stage until
      // the Redis burst buffer acknowledges the downstream handoff.
      const nextStage: WebhookStage = controlTag === "stop_ai" && event.contactId
        ? "policy_pending"
        : suppressAi
          ? "policy_applied"
          : event.inboundMessage
            ? "received"
            : "processed";

      await client.query(
        `UPDATE public.raw_webhooks
            SET status = $2,
                suppression_required = $3,
                processed_at = CASE WHEN $2 = 'processed' THEN now() ELSE NULL END,
                error_message = NULL,
                stage_claim = NULL,
                stage_claimed_at = NULL
          WHERE id = $1`,
        [rawEvent.rows[0]?.id, nextStage, suppressAi ?? false],
      );
      await client.query("COMMIT");
      return { duplicate: rawEvent.rowCount === 0, tenantId, suppressAi, stage: nextStage };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (tenantId) await this.recordFailedEvent(event, tenantId, error);
      throw error;
    } finally {
      client.release();
    }
  }

  async claimStage(input: Omit<WebhookStageClaim, "token">): Promise<WebhookStageClaim | undefined> {
    const token = randomUUID();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenantContext(client, input.tenantId);
      const result = await client.query(
        `UPDATE public.raw_webhooks
            SET stage_claim = $4, stage_claimed_at = now()
          WHERE tenant_id = $1
            AND external_id = $2
            AND status = $3
            AND (stage_claim IS NULL OR stage_claimed_at < now() - interval '60 seconds')
          RETURNING id`,
        [input.tenantId, input.externalId, input.stage, token],
      );
      await client.query("COMMIT");
      if (result.rowCount !== 1) return undefined;
      return { ...input, token };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async completeStage(input: WebhookStageClaim, nextStage: WebhookStage): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenantContext(client, input.tenantId);
      const result = await client.query(
        `UPDATE public.raw_webhooks
            SET status = $5,
                stage_claim = NULL,
                stage_claimed_at = NULL,
                error_message = NULL,
                processed_at = CASE WHEN $5 = 'processed' THEN now() ELSE processed_at END
          WHERE tenant_id = $1
            AND external_id = $2
            AND status = $3
            AND stage_claim = $4`,
        [input.tenantId, input.externalId, input.stage, input.token, nextStage],
      );
      if (result.rowCount !== 1) throw new Error(`Webhook stage transition lost for ${input.externalId}`);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseStage(input: WebhookStageClaim): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenantContext(client, input.tenantId);
      await client.query(
        `UPDATE public.raw_webhooks
            SET stage_claim = NULL, stage_claimed_at = NULL
          WHERE tenant_id = $1
            AND external_id = $2
            AND status = $3
            AND stage_claim = $4`,
        [input.tenantId, input.externalId, input.stage, input.token],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
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
         (tenant_id, ghl_contact_id, phone, email, ctwa_clid, ctwa_source_id, ctwa_captured_at, preferred_language, consent_state)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'unknown', 'unknown')
       ON CONFLICT (tenant_id, ghl_contact_id) DO UPDATE SET
         phone = COALESCE(EXCLUDED.phone, c.phone),
         email = COALESCE(EXCLUDED.email, c.email),
         ctwa_clid = COALESCE(c.ctwa_clid, EXCLUDED.ctwa_clid),
         ctwa_source_id = COALESCE(c.ctwa_source_id, EXCLUDED.ctwa_source_id),
         ctwa_captured_at = COALESCE(c.ctwa_captured_at, EXCLUDED.ctwa_captured_at),
         updated_at = now()
       RETURNING id`,
      [
        tenantId,
        message.contactId,
        message.phone ?? null,
        message.email ?? null,
        message.ctwaClid ?? null,
        message.ctwaSourceId ?? null,
        message.ctwaCapturedAt ?? null,
      ],
    );

    if (contact.rowCount !== 1 || !contact.rows[0]) {
      throw new Error("GHL contact was not persisted");
    }

    const conversation = await this.findOrCreateConversation(
      client,
      tenantId,
      contact.rows[0].id,
      message.conversationId ?? `event:${message.externalId}`,
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
          SET last_activity = now(),
              state = CASE WHEN state = 'paused' THEN state ELSE 'open' END
        WHERE id = $1`,
      [conversation.id],
    );
  }

  private async findOrCreateConversation(
    client: PoolClient,
    tenantId: string,
    contactId: string,
    ghlConversationId: string,
    channel: string,
  ): Promise<ConversationRow> {
    const normalizedChannel = normalizeConversationChannel(channel);
    // GHL retries can arrive with the same conversation id after a restart or
    // a transient failure. Resolve the provider identity first so a changed
    // contact/channel projection cannot create a second local conversation.
    const byGhlId = await client.query<ConversationRow>(
      `SELECT id
         FROM public.conversations
        WHERE tenant_id = $1 AND ghl_conversation_id = $2
        LIMIT 1
        FOR UPDATE`,
      [tenantId, ghlConversationId],
    );
    if (byGhlId.rowCount === 1 && byGhlId.rows[0]) return byGhlId.rows[0];

    const existing = await client.query<ConversationRow>(
      `SELECT id
         FROM public.conversations
        WHERE tenant_id = $1 AND contact_id = $2 AND channel = $3
        ORDER BY last_activity DESC NULLS LAST
        LIMIT 1
        FOR UPDATE`,
      [tenantId, contactId, normalizedChannel],
    );
    if (existing.rowCount === 1 && existing.rows[0]) return existing.rows[0];

    const created = await client.query<ConversationRow>(
      `INSERT INTO public.conversations
         (tenant_id, contact_id, ghl_conversation_id, channel, owner, state, last_activity)
       VALUES ($1, $2, $3, $4, 'ghl', 'open', now())
       ON CONFLICT (tenant_id, ghl_conversation_id) DO NOTHING
       RETURNING id`,
      [tenantId, contactId, ghlConversationId, normalizedChannel],
    );
    if (created.rowCount === 1 && created.rows[0]) return created.rows[0];

    const conflicted = await client.query<ConversationRow>(
      `SELECT id
         FROM public.conversations
        WHERE tenant_id = $1 AND ghl_conversation_id = $2
        LIMIT 1
        FOR UPDATE`,
      [tenantId, ghlConversationId],
    );
    if (conflicted.rowCount === 1 && conflicted.rows[0]) return conflicted.rows[0];
    throw new Error("GHL conversation was not persisted");
  }

  private async persistHumanInterruption(
    client: PoolClient,
    tenantId: string,
    interruption: HumanInterruption,
  ): Promise<boolean> {
    const automationOutbound = Boolean(
      interruption.trigger === "staff_message" &&
      interruption.staffMessage &&
      this.outboundRegistry &&
      await this.outboundRegistry.wasIssuedBy1987({
        tenantId,
        contactId: interruption.contactId,
        semanticHash: interruption.staffMessage.semanticHash,
        providerMessageId: interruption.staffMessage.providerMessageId ?? interruption.staffMessage.externalId,
        content: interruption.staffMessage.content,
      }),
    );
    const contact = await client.query<ContactRow>(
      `INSERT INTO public.contacts AS c
         (tenant_id, ghl_contact_id, phone, email, preferred_language, consent_state)
       VALUES ($1, $2, $3, $4, 'unknown', 'unknown')
       ON CONFLICT (tenant_id, ghl_contact_id) DO UPDATE SET
         phone = COALESCE(EXCLUDED.phone, c.phone),
         email = COALESCE(EXCLUDED.email, c.email),
         updated_at = now()
       RETURNING id`,
      [tenantId, interruption.contactId, interruption.staffMessage?.phone ?? null, interruption.staffMessage?.email ?? null],
    );
    if (contact.rowCount !== 1 || !contact.rows[0]) throw new Error("Human interruption contact was not persisted");

    let conversation = await this.findHumanConversation(
      client,
      tenantId,
      contact.rows[0].id,
      interruption.conversationId,
    );

    if (!conversation && interruption.staffMessage) {
      conversation = await this.findOrCreateConversation(
        client,
        tenantId,
        contact.rows[0].id,
        interruption.conversationId ?? `event:${interruption.staffMessage.externalId}`,
        interruption.staffMessage.channel,
      );
    }

    if (conversation && interruption.staffMessage) {
      await client.query(
        `INSERT INTO public.messages
           (tenant_id, conversation_id, external_id, direction, sender_type, content, semantic_hash, status)
         VALUES ($1, $2, $3, 'outbound', $4, $5, $6, 'received')
         ON CONFLICT DO NOTHING`,
        [tenantId, conversation.id, interruption.staffMessage.externalId, automationOutbound ? "agent" : "staff", interruption.staffMessage.content, interruption.staffMessage.semanticHash],
      );
    }

    if (conversation && !automationOutbound) {
      await client.query(
        `UPDATE public.conversations
            SET state = 'paused', owner = $2, last_activity = now()
          WHERE id = $1`,
        [conversation.id, interruption.ownerId ?? "staff"],
      );
    }

    if (!automationOutbound) await client.query(
      `INSERT INTO public.decision_logs
         (tenant_id, contact_id, input_version, allowed_actions, selected_action, reason, model_trace)
       VALUES ($1, $2, 'control-v1', '[]'::jsonb, 'pause_ai', $3, $4::jsonb)`,
      [
        tenantId,
        contact.rows[0].id,
        `AI execution cancelled: Human operator took control (Trigger: ${interruption.trigger === "staff_message" ? "Staff Message" : "Control Tag"})`,
        JSON.stringify({ trigger: interruption.trigger, controlTag: interruption.controlTag ?? null, conversationId: conversation?.id ?? null }),
      ],
    );
    return !automationOutbound;
  }

  private async findHumanConversation(
    client: PoolClient,
    tenantId: string,
    contactId: string,
    ghlConversationId?: string,
  ): Promise<ConversationRow | undefined> {
    const result = await client.query<ConversationRow>(
      `SELECT id
         FROM public.conversations
        WHERE tenant_id = $1
          AND contact_id = $2
          AND ($3::text IS NULL OR ghl_conversation_id = $3)
        ORDER BY last_activity DESC NULLS LAST
        LIMIT 1
        FOR UPDATE`,
      [tenantId, contactId, ghlConversationId ?? null],
    );
    return result.rows[0];
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

function normalizeConversationChannel(channel: string): string {
  const normalized = channel.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const aliases: Record<string, string> = {
    whatsapp: "whatsapp",
    whatsapp_business: "whatsapp",
    fb: "messenger",
    facebook: "messenger",
    messenger: "messenger",
    facebook_messenger: "messenger",
    fb_messenger: "messenger",
    meta_messenger: "messenger",
    ig: "instagram",
    instagram: "instagram",
    instagram_dm: "instagram",
    instagram_direct: "instagram",
  };
  return aliases[normalized] ?? normalized;
}
