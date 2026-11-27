import type { PoolClient } from "pg";
import { DEFAULT_OPPORTUNITY_STAGES } from "@/features/opportunities/application/opportunities.service";

export async function ensureOpportunityStages(client: PoolClient, tenantId: string): Promise<void> {
  for (const stage of DEFAULT_OPPORTUNITY_STAGES) {
    await client.query(
      `INSERT INTO public.opportunity_stages (tenant_id,stage_key,label,position)
       VALUES ($1::uuid,$2,$3,$4) ON CONFLICT (tenant_id,stage_key) DO NOTHING`,
      [tenantId, stage.stageKey, stage.label, stage.position],
    );
  }
}
