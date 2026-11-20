import type { PolicyContext } from "@/modules/decisions/domain/policy-context";

export interface PolicyContextRepositoryPort {
  load(tenantId: string, providerContactId: string): Promise<PolicyContext>;
}
