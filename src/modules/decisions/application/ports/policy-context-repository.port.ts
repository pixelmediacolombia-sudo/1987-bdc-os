import type { PolicyContext } from "@/modules/decisions/domain/policy-context";

export interface PolicyContextRepositoryPort {
  load(tenantId: string, ghlContactId: string): Promise<PolicyContext>;
}
