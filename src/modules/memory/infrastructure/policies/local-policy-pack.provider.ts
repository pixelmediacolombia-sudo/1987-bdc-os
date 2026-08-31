import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PolicyPackProviderPort } from "@/modules/memory/application/ports/policy-pack.provider.port";
import type { PolicyPack } from "@/modules/memory/domain/hydrated-context";

const POLICY_FILES: Record<string, string> = {
  default_v1: "default_policy_v1.json",
  "v0.1": "policy_v0.1.json",
  v1: "policy_v1.json",
  koons_policy_v1: "koons_policy_v1.json",
  country_club_cars_v8: "country_club_cars_v8.json",
};

export class LocalPolicyPackProvider implements PolicyPackProviderPort {
  constructor(private readonly policiesDirectory = path.resolve(process.cwd(), "policies")) {}

  async load(policyVersion: string): Promise<PolicyPack> {
    const fileName = POLICY_FILES[policyVersion];
    if (!fileName) throw new Error(`No local policy pack is mapped for version ${policyVersion}`);
    const policy = JSON.parse(await readFile(path.join(this.policiesDirectory, fileName), "utf8")) as Partial<PolicyPack>;
    if (policy.version !== policyVersion) throw new Error(`Policy pack ${fileName} has an unexpected version`);
    return policy as PolicyPack;
  }
}
