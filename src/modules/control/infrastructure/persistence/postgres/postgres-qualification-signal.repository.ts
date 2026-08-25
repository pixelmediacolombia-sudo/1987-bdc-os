import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  CapiDeliveryEvent,
  GhlTagDeliveryEvent,
  QualificationCompletion,
  QualificationCompletionPort,
  QualificationSignalRepository,
} from "@/modules/control/application/ports/qualification-signal.port";
import { buildMetaCapiPayload } from "@/modules/decisions/domain/meta-capi";
import { findMetaCapiEnvConfig, type MetaCapiTenantConfig } from "@/modules/control/infrastructure/meta-capi.config";

type ContactSignalRow = {
  id: string;
  phone: string | null;
  email: string | null;
  ctwa_clid: string | null;
};

type DealerMetaRow = {
  dealer_document: string;
  meta_capi_enabled: boolean;
  meta_dataset_id: string | null;
  encrypted_meta_access_token: string | null;
  meta_event_name: string | null;
  meta_test_event_code: string | null;
};
type SofiaSignalRow = {
  lead_level: "A" | "B" | "C";
  push_accepted: boolean | null;
  has_trade_in: boolean | null;
};

export class PostgresQualificationSignalRepository implements QualificationCompletionPort, QualificationSignalRepository {
  constructor(
    private readonly pool: Pool,
    private readonly metaCapiDealers: MetaCapiTenantConfig[] = [],
    private readonly metaCapiEventName = "Lead_Calificado",
  ) {}

  async enqueueWithinTransaction(client: PoolClient, input: QualificationCompletion): Promise<void> {
    const contact = await client.query<ContactSignalRow>(
      `SELECT id::text AS id, phone, email, ctwa_clid
         FROM public.contacts
        WHERE tenant_id = $1 AND ghl_contact_id = $2
        LIMIT 1`,
      [input.tenantId, input.ghlContactId],
    );
    const contactRow = contact.rows[0];
    if (!contactRow) throw new Error("Qualification completion contact was not found");

    const dealer = await client.query<DealerMetaRow>(
      `SELECT meta_dataset_id, encrypted_meta_access_token, meta_event_name, meta_test_event_code
         FROM public.tenants
        WHERE dealer_id = $1
        LIMIT 1`,
      [input.tenantId],
    );
    const dealerRow = dealer.rows[0];
    if (!dealerRow) throw new Error("Qualification completion dealer was not found");

    const sofia = await client.query<SofiaSignalRow>(
      `SELECT lead_level, push_accepted, has_trade_in
         FROM public.sofia_conversation_state
        WHERE tenant_id = $1 AND contact_id = $2
        LIMIT 1`,
      [input.tenantId, contactRow.id],
    );
    // Sofia level C is intentionally excluded from both the qualification
    // signal and its operational tag. A missing Sofia row preserves the
    // existing Ticket 8.5 compatibility path until Sofia is enabled.
    if (sofia.rows[0]?.lead_level === "C") return;

    const answered = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
         FROM public.objectives
        WHERE tenant_id = $1 AND contact_id = $2 AND answered = true`,
      [input.tenantId, contactRow.id],
    );
    const completion = await client.query<{ qualification_completed_at: Date | null }>(
      `SELECT qualification_completed_at
         FROM public.objectives
        WHERE id = $1 AND tenant_id = $2
        LIMIT 1`,
      [input.ledgerEntryId, input.tenantId],
    );
    const eventTime = completion.rows[0]?.qualification_completed_at ?? new Date();
    const eventName = this.metaCapiEventName || dealerRow.meta_event_name?.trim() || "Lead_Calificado";
    const payload = buildMetaCapiPayload({
      eventName,
      eventId: input.ledgerEntryId,
      eventTime,
      dealer: input.tenantId,
      contactId: contactRow.id,
      phone: contactRow.phone ?? undefined,
      email: contactRow.email ?? undefined,
      ctwaClid: contactRow.ctwa_clid ?? undefined,
      objectivesAnswered: Number.parseInt(answered.rows[0]?.count ?? "0", 10),
      ...(sofia.rows[0]?.lead_level ? { leadLevel: sofia.rows[0].lead_level } : {}),
      ...(sofia.rows[0]?.push_accepted === null || sofia.rows[0]?.push_accepted === undefined ? {} : { pushAccepted: sofia.rows[0].push_accepted }),
      ...(sofia.rows[0]?.has_trade_in === null || sofia.rows[0]?.has_trade_in === undefined ? {} : { hasTradeIn: sofia.rows[0].has_trade_in }),
    });

    await client.query(
      `INSERT INTO public.capi_events
         (dealer_id, contact_id, ledger_entry_id, event_name, event_id, event_time, payload_sent)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
       ON CONFLICT (dealer_id, event_id) DO NOTHING`,
      [input.tenantId, contactRow.id, input.ledgerEntryId, eventName, input.ledgerEntryId, eventTime, JSON.stringify(payload)],
    );
    await client.query(
      `INSERT INTO public.ghl_qualification_tag_events
         (dealer_id, contact_id, ghl_contact_id, ledger_entry_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (dealer_id, ledger_entry_id) DO NOTHING`,
      [input.tenantId, contactRow.id, input.ghlContactId, input.ledgerEntryId],
    );
  }

  async listDealerIds(): Promise<string[]> {
    const result = await this.pool.query<{ dealer_id: string }>(
      "SELECT dealer_id::text AS dealer_id FROM public.list_qualification_signal_dealers()",
    );
    return result.rows.map((row) => row.dealer_id);
  }

  async claimNextCapiEvent(dealerId: string): Promise<CapiDeliveryEvent | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenantContext(client, dealerId);
      const claimToken = randomUUID();
      const candidates = await client.query<{
        id: string;
        event_id: string;
        event_name: string;
        payload_sent: Record<string, unknown>;
        meta_dataset_id: string | null;
        encrypted_meta_access_token: string | null;
        meta_test_event_code: string | null;
        meta_capi_enabled: boolean;
        ghl_location_id: string;
        dealer_document: string;
      }>(
        `SELECT e.id, e.event_id, e.event_name, e.payload_sent,
                t.meta_dataset_id, t.encrypted_meta_access_token, t.meta_test_event_code,
                t.meta_capi_enabled, t.ghl_location_id, to_jsonb(t)::text AS dealer_document
             FROM public.capi_events AS e
             JOIN public.tenants AS t ON t.dealer_id = e.dealer_id
            WHERE e.dealer_id = $1
              AND e.status = 'pending'
              AND e.next_attempt_at <= now()
               AND (e.claimed_at IS NULL OR e.claimed_at < now() - interval '60 seconds')
            ORDER BY e.created_at
            LIMIT 100
            FOR UPDATE OF e SKIP LOCKED`,
        [dealerId],
      );
      const selected = candidates.rows
        .map((candidate) => ({ candidate, env: findMetaCapiEnvConfig(candidate.dealer_document, this.metaCapiDealers, candidate.ghl_location_id) }))
        .find(({ candidate, env }) => Boolean(env || (candidate.meta_capi_enabled && candidate.meta_dataset_id && candidate.encrypted_meta_access_token)))?.candidate;
      if (!selected) {
        await client.query("COMMIT");
        return undefined;
      }

      const result = await client.query<{
        id: string;
        event_id: string;
        event_name: string;
        payload_sent: Record<string, unknown>;
        meta_dataset_id: string | null;
        encrypted_meta_access_token: string | null;
        meta_test_event_code: string | null;
        meta_capi_enabled: boolean;
        ghl_location_id: string;
        dealer_document: string;
      }>(
        `UPDATE public.capi_events AS e
            SET claim_token = $2, claimed_at = now(), updated_at = now()
          FROM public.tenants AS t
         WHERE e.id = $1 AND t.dealer_id = e.dealer_id
        RETURNING e.id, e.event_id, e.event_name, e.payload_sent,
                  t.meta_dataset_id, t.encrypted_meta_access_token, t.meta_test_event_code,
                  t.meta_capi_enabled, t.ghl_location_id, to_jsonb(t)::text AS dealer_document`,
        [selected.id, claimToken],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      if (!row) return undefined;
      const envConfig = findMetaCapiEnvConfig(row.dealer_document, this.metaCapiDealers, row.ghl_location_id);
      return {
        id: row.id,
        dealerId,
        eventId: row.event_id,
        eventName: row.event_name,
        payloadSent: row.payload_sent,
        ...(envConfig?.datasetId || row.meta_dataset_id ? { datasetId: envConfig?.datasetId ?? row.meta_dataset_id! } : {}),
        ...(envConfig?.accessToken ? { accessToken: envConfig.accessToken } : {}),
        ...(!envConfig && row.encrypted_meta_access_token ? { encryptedAccessToken: row.encrypted_meta_access_token } : {}),
        ...(row.meta_test_event_code ? { testEventCode: row.meta_test_event_code } : {}),
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async markCapiSent(eventId: string, dealerId: string, fbtraceId?: string): Promise<void> {
    await this.updateDelivery("capi_events", dealerId, eventId, "sent", undefined, fbtraceId);
  }

  async markCapiFailure(input: {
    dealerId: string;
    eventId: string;
    error: string;
    retryable: boolean;
    rateLimited?: boolean;
  }): Promise<void> {
    await this.updateDelivery("capi_events", input.dealerId, input.eventId, undefined, input);
  }

  async claimNextGhlTagEvent(dealerId: string): Promise<GhlTagDeliveryEvent | undefined> {
    return this.claimTagEvent(dealerId);
  }

  async markGhlTagSent(eventId: string, dealerId: string): Promise<void> {
    await this.updateDelivery("ghl_qualification_tag_events", dealerId, eventId, "sent");
  }

  async markGhlTagFailure(input: {
    dealerId: string;
    eventId: string;
    error: string;
    retryable: boolean;
    rateLimited?: boolean;
  }): Promise<void> {
    await this.updateDelivery("ghl_qualification_tag_events", input.dealerId, input.eventId, undefined, input);
  }

  private async claimTagEvent(dealerId: string): Promise<GhlTagDeliveryEvent | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenantContext(client, dealerId);
      const result = await client.query<{
        id: string;
        ghl_contact_id: string;
        ledger_entry_id: string;
      }>(
        `WITH candidate AS (
           SELECT id FROM public.ghl_qualification_tag_events
            WHERE dealer_id = $1 AND status = 'pending' AND next_attempt_at <= now()
              AND (claimed_at IS NULL OR claimed_at < now() - interval '60 seconds')
            ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED
         )
         UPDATE public.ghl_qualification_tag_events AS e
            SET claim_token = $2, claimed_at = now(), updated_at = now()
           FROM candidate
          WHERE e.id = candidate.id
        RETURNING e.id, e.ghl_contact_id, e.ledger_entry_id`,
        [dealerId, randomUUID()],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row
        ? { id: row.id, dealerId, ghlContactId: row.ghl_contact_id, ledgerEntryId: row.ledger_entry_id }
        : undefined;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async updateDelivery(
    table: "capi_events" | "ghl_qualification_tag_events",
    dealerId: string,
    eventId: string,
    success?: "sent",
    failure?: { error: string; retryable: boolean; rateLimited?: boolean },
    fbtraceId?: string,
  ): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.setTenantContext(client, dealerId);
      if (success === "sent") {
        const traceSet = table === "capi_events" ? ", fbtrace_id = COALESCE($4, fbtrace_id)" : "";
        await client.query(
          `UPDATE public.${table}
              SET status = 'sent'${traceSet},
                  claim_token = NULL, claimed_at = NULL, updated_at = now()
            WHERE dealer_id = $1 AND ${table === "capi_events" ? "event_id" : "id"} = $2`,
          table === "capi_events" ? [dealerId, eventId, null, fbtraceId ?? null] : [dealerId, eventId],
        );
      } else if (failure) {
        const increment = failure.rateLimited ? 0 : 1;
        await client.query(
          `UPDATE public.${table}
              SET attempts = attempts + $3,
                  status = CASE WHEN NOT $4::boolean THEN 'failed'
                                WHEN attempts + $3 >= 5 THEN 'abandoned'
                                ELSE 'pending' END,
                  last_error = $5,
                  next_attempt_at = CASE
                    WHEN $7::boolean THEN now() + interval '5 minutes'
                    WHEN attempts + $3 = 1 THEN now() + interval '1 minute'
                    WHEN attempts + $3 = 2 THEN now() + interval '5 minutes'
                    WHEN attempts + $3 = 3 THEN now() + interval '15 minutes'
                    WHEN attempts + $3 = 4 THEN now() + interval '1 hour'
                    ELSE now() + interval '6 hours'
                  END,
                  claim_token = NULL, claimed_at = NULL, updated_at = now()
            WHERE dealer_id = $1 AND ${table === "capi_events" ? "event_id" : "id"} = $2`,
          [dealerId, eventId, increment, failure.retryable, failure.error.slice(0, 1000), null, failure.rateLimited ?? false],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private async setTenantContext(client: PoolClient, dealerId: string): Promise<void> {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [dealerId]);
  }
}
