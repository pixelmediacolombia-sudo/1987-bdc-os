import type { Pool } from "pg";
import type { ConversationAiShadowRecord, ConversationAiShadowRepositoryPort } from "@/modules/control/application/conversation-ai-model-contract";

export class PostgresConversationAiShadowRepository implements ConversationAiShadowRepositoryPort {
  constructor(private readonly pool: Pool) {}

  async save(record: ConversationAiShadowRecord): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [record.tenantId]);
      await client.query(
        `INSERT INTO public.conversation_ai_shadow_runs
          (tenant_id, contact_id, inbound_external_id, extraction_model, drafting_model, prompt_version,
           extraction, model_facts, rule_facts, rule_response, model_response, draft_accepted, safety_issues,
           input_tokens, output_tokens)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10, $11, $12, $13::jsonb, $14, $15)`,
        [
          record.tenantId,
          record.contactId,
          record.inboundExternalId ?? null,
          record.extractionModel,
          record.draftingModel,
          record.promptVersion,
          JSON.stringify(record.extraction ?? null),
          JSON.stringify(record.modelFacts),
          JSON.stringify(record.ruleFacts),
          record.ruleResponse ?? null,
          record.modelResponse ?? null,
          record.draftAccepted,
          JSON.stringify(record.safetyIssues),
          record.inputTokens ?? null,
          record.outputTokens ?? null,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
