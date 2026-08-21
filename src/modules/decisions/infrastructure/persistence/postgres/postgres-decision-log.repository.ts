import type { Pool } from "pg";
import type { DecisionLogRepositoryPort, DecisionLogInput } from "@/modules/decisions/application/ports/decision-log-repository.port";

export class PostgresDecisionLogRepository implements DecisionLogRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async append(input: DecisionLogInput): Promise<{ rlsEnforced: true }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.tenantId]);
      await client.query(
        `INSERT INTO public.decision_logs
           (tenant_id, contact_id, input_version, allowed_actions, selected_action, reason, model_trace)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)`,
        [
          input.tenantId,
          input.contactId,
          input.inputVersion,
          JSON.stringify(input.decision.allowedActions),
          input.decision.selectedAction,
          input.decision.reason,
          JSON.stringify(input.modelTrace),
        ],
      );
      await client.query("COMMIT");
      return { rlsEnforced: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
