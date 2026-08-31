import type { Pool } from "pg";
import type { SofiaFacts, SofiaLeadLevel } from "@/modules/decisions/domain/sofia-conversation";
import type { SofiaConversationState, SofiaStateRepositoryPort } from "@/modules/control/application/ports/sofia-state-repository.port";

type SofiaStateRow = {
  turn_count: number;
  fields: SofiaFacts;
  lead_level: SofiaLeadLevel;
  push_accepted: boolean | null;
  has_trade_in: boolean | null;
  hard_rule_failure: boolean;
  last_response: string | null;
};

export class PostgresSofiaStateRepository implements SofiaStateRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async load(tenantId: string, contactId: string): Promise<SofiaConversationState | undefined> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const result = await client.query<SofiaStateRow>(
        `SELECT state.turn_count, state.fields, state.lead_level, state.push_accepted,
                state.has_trade_in, state.hard_rule_failure, state.last_response
           FROM public.sofia_conversation_state AS state
           JOIN public.contacts AS contact ON contact.id = state.contact_id
          WHERE state.tenant_id = $1 AND contact.ghl_contact_id = $2
          LIMIT 1`,
        [tenantId, contactId],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row
        ? {
            turnCount: row.turn_count,
            facts: row.fields,
            leadLevel: row.lead_level,
            ...(row.push_accepted === null ? {} : { pushAccepted: row.push_accepted }),
            ...(row.has_trade_in === null ? {} : { hasTradeIn: row.has_trade_in }),
            hardRuleFailure: row.hard_rule_failure,
            ...(row.last_response === null ? {} : { lastResponse: row.last_response }),
          }
        : undefined;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async save(tenantId: string, contactId: string, state: SofiaConversationState): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      await client.query(
        `INSERT INTO public.sofia_conversation_state
           (tenant_id, contact_id, turn_count, fields, lead_level, push_accepted, has_trade_in, hard_rule_failure, last_response, last_inbound_at)
         SELECT $1, contact.id, $3, $4::jsonb, $5, $6, $7, $8, $9, now()
           FROM public.contacts AS contact
          WHERE contact.tenant_id = $1 AND contact.ghl_contact_id = $2
         ON CONFLICT (tenant_id, contact_id) DO UPDATE SET
           turn_count = EXCLUDED.turn_count,
           fields = EXCLUDED.fields,
           lead_level = EXCLUDED.lead_level,
           push_accepted = EXCLUDED.push_accepted,
           has_trade_in = EXCLUDED.has_trade_in,
           hard_rule_failure = EXCLUDED.hard_rule_failure,
           last_response = EXCLUDED.last_response,
           last_inbound_at = now(),
           updated_at = now()`,
        [tenantId, contactId, state.turnCount, JSON.stringify(state.facts), state.leadLevel, state.pushAccepted ?? null, state.hasTradeIn ?? null, state.hardRuleFailure, state.lastResponse ?? null],
      );
      for (const [key, value] of Object.entries(state.facts)) {
        if (!PERSISTED_FACT_KEYS.has(key) || value === undefined) continue;
        await client.query(
          `INSERT INTO public.facts
             (tenant_id, contact_id, key, value, active, observed_at)
           SELECT $1, contact.id, $3, $4, true, now()
             FROM public.contacts AS contact
            WHERE contact.tenant_id = $1 AND contact.ghl_contact_id = $2
           ON CONFLICT (tenant_id, contact_id, key) WHERE active = true DO UPDATE SET
             value = EXCLUDED.value,
             active = true,
             observed_at = now()`,
          [tenantId, contactId, key, String(value)],
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
}

const PERSISTED_FACT_KEYS = new Set([
  "contact_name",
  "vehicle_category",
  "vehicle_model_interest",
  "vehicle_use",
  "down_payment_declared",
  "down_payment_accepted",
  "down_payment_push_target",
  "push_accepted",
  "has_trade_in",
  "trade_in_description",
  "trade_in_financed",
  "contact_channel",
  "contact_value",
  "first_time_buyer",
  "employment_months",
  "has_income_proof",
  "has_id_document",
  "has_income_proof_document",
  "purchase_timeline",
  "has_co_signer",
  "visit_intent",
  "handoff_completed",
]);
