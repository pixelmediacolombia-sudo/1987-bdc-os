import type { PolicyPack } from "@/modules/memory/domain/hydrated-context";

export interface PolicyPackProviderPort {
  load(policyVersion: string): Promise<PolicyPack>;
}
