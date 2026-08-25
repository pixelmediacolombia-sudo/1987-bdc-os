import type { Pool } from "pg";
import type { NextBestAction } from "@/modules/decisions/domain/next-best-action";
import type { QualificationCompletionPort } from "@/modules/control/application/ports/qualification-signal.port";

export type ObjectiveState = {
  objectiveType: string;
  asked: boolean;
  answered: boolean;
  skipped: boolean;
  /** Set only when the buyer explicitly corrects a previously terminal answer. */
  correctionRequested?: boolean;
  /** Explicit completion boundary supplied by the qualification flow. */
  qualificationCompleted?: boolean;
  qualificationCompletedAt?: Date;
};

export type ObjectiveActionDecision = {
  allowed: boolean;
  action: NextBestAction;
  reason: string;
};

export class QuestionLedgerService {
  constructor(
    private readonly pool: Pool,
    private readonly completionPort?: QualificationCompletionPort,
  ) {}

  async checkObjectiveState(
    tenantId: string,
    contactId: string,
    objectiveType: string,
  ): Promise<ObjectiveState> {
    const normalizedTenantId = requiredIdentifier(tenantId, "tenantId");
    const normalizedContactId = requiredIdentifier(contactId, "contactId");
    const normalizedObjectiveType = requiredIdentifier(objectiveType, "objectiveType");
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await this.setTenantContext(client, normalizedTenantId);
      const result = await client.query<{
        objective_type: string;
        asked: boolean;
        answered: boolean;
        skipped: boolean;
        qualification_completed: boolean;
        qualification_completed_at: Date | null;
      }>(
        `SELECT objective_type, asked, answered, skipped, qualification_completed, qualification_completed_at
           FROM public.objectives
          WHERE tenant_id = $1 AND contact_id = $2 AND objective_type = $3
          LIMIT 1`,
        [normalizedTenantId, normalizedContactId, normalizedObjectiveType],
      );
      await client.query("COMMIT");
      const row = result.rows[0];
      return row
        ? {
            objectiveType: row.objective_type,
            asked: row.asked,
            answered: row.answered,
            skipped: row.skipped,
            qualificationCompleted: row.qualification_completed,
            ...(row.qualification_completed_at ? { qualificationCompletedAt: row.qualification_completed_at } : {}),
          }
        : {
            objectiveType: normalizedObjectiveType,
            asked: false,
            answered: false,
            skipped: false,
          };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateObjectiveState(
    tenantId: string,
    contactId: string,
    objectiveType: string,
    fields: Partial<ObjectiveState>,
  ): Promise<void> {
    const normalizedTenantId = requiredIdentifier(tenantId, "tenantId");
    const normalizedContactId = requiredIdentifier(contactId, "contactId");
    const normalizedObjectiveType = requiredIdentifier(objectiveType, "objectiveType");
    validateBooleanPatch(fields);
    const correctionRequested = fields.correctionRequested === true;
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await this.setTenantContext(client, normalizedTenantId);
      const ledgerWrite = await client.query<{ id: string }>(
        `INSERT INTO public.objectives AS objective
           (tenant_id, contact_id, objective_type, asked, answered, skipped, qualification_completed, qualification_completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $8, $9)
         ON CONFLICT (tenant_id, contact_id, objective_type) DO UPDATE SET
           asked = CASE WHEN $7::boolean THEN EXCLUDED.asked
                        ELSE objective.asked OR EXCLUDED.asked END,
           answered = CASE WHEN $7::boolean THEN EXCLUDED.answered
                           ELSE objective.answered OR EXCLUDED.answered END,
           skipped = CASE WHEN $7::boolean THEN EXCLUDED.skipped
                          ELSE objective.skipped OR EXCLUDED.skipped END,
           qualification_completed = objective.qualification_completed OR EXCLUDED.qualification_completed,
           qualification_completed_at = COALESCE(objective.qualification_completed_at, EXCLUDED.qualification_completed_at),
           updated_at = now()
         RETURNING id`,
        [
          normalizedTenantId,
          normalizedContactId,
          normalizedObjectiveType,
          fields.asked ?? false,
          fields.answered ?? false,
          fields.skipped ?? false,
          correctionRequested,
          fields.qualificationCompleted ?? false,
          fields.qualificationCompleted === true ? new Date() : null,
        ],
      );
      if (fields.qualificationCompleted === true) {
        const ledgerEntryId = ledgerWrite.rows[0]?.id;
        if (!ledgerEntryId) throw new Error("Qualification completion did not return a ledger entry id");
        if (!this.completionPort) throw new Error("Qualification completion signal is not configured");
        await this.completionPort.enqueueWithinTransaction(client, {
          tenantId: normalizedTenantId,
          ghlContactId: normalizedContactId,
          ledgerEntryId,
        });
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  canAskObjective(state: ObjectiveState): boolean {
    return !isObjectiveTerminal(state);
  }

  guardAction(
    state: ObjectiveState,
    requestedAction: NextBestAction,
    fallbackAction: "WAIT" | "HANDOFF" = "WAIT",
  ): ObjectiveActionDecision {
    if (requestedAction !== "ASK_OBJECTIVE" || this.canAskObjective(state)) {
      return { allowed: true, action: requestedAction, reason: "Objective is not terminal" };
    }
    return {
      allowed: false,
      action: fallbackAction,
      reason: `ASK_OBJECTIVE blocked for ${state.objectiveType}: objective is already answered or skipped`,
    };
  }

  private async setTenantContext(client: { query: (sql: string, values?: unknown[]) => Promise<unknown> }, tenantId: string): Promise<void> {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
  }
}

export function isObjectiveTerminal(state: Pick<ObjectiveState, "answered" | "skipped">): boolean {
  return state.answered || state.skipped;
}

function requiredIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} cannot be empty`);
  return normalized;
}

function validateBooleanPatch(fields: Partial<ObjectiveState>): void {
  for (const key of ["asked", "answered", "skipped", "correctionRequested", "qualificationCompleted"] as const) {
    const value = fields[key];
    if (value !== undefined && typeof value !== "boolean") {
      throw new Error(`Objective field ${key} must be boolean`);
    }
  }
}
