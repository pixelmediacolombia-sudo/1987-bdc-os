import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PolicyPackProviderPort } from "@/modules/memory/application/ports/policy-pack.provider.port";
import type { PolicyPack } from "@/modules/memory/domain/hydrated-context";

const SHARED_POLICY_VERSION = "shared_dealer_v1";
const SHARED_POLICY_FILE = "shared_dealer_v1.json";

export class LocalPolicyPackProvider implements PolicyPackProviderPort {
  constructor(private readonly policiesDirectory = path.resolve(process.cwd(), "policies")) {}

  async load(policyVersion: string): Promise<PolicyPack> {
    // During rollout, old tenant version labels all resolve to the same
    // baseline. Future dealer customization can layer on this provider.
    void policyVersion;
    const policy = JSON.parse(await readFile(path.join(this.policiesDirectory, SHARED_POLICY_FILE), "utf8")) as Partial<PolicyPack>;
    if (policy.version !== SHARED_POLICY_VERSION) throw new Error(`Policy pack ${SHARED_POLICY_FILE} has an unexpected version`);
    return policy as PolicyPack;
  }
}
