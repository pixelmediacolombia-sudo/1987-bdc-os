import type { HydrationRepositoryPort } from "@/modules/memory/application/ports/hydration-repository.port";
import type { PolicyPackProviderPort } from "@/modules/memory/application/ports/policy-pack.provider.port";
import type { HydratedContext } from "@/modules/memory/domain/hydrated-context";

export const DEFAULT_TRANSCRIPT_LIMIT = 12;

export class ConversationHydrator {
  constructor(
    private readonly repository: HydrationRepositoryPort,
    private readonly policyPackProvider: PolicyPackProviderPort,
    private readonly transcriptLimit = DEFAULT_TRANSCRIPT_LIMIT,
  ) {
    if (!Number.isInteger(transcriptLimit) || transcriptLimit < 8 || transcriptLimit > 12) {
      throw new Error("Transcript limit must be an integer between 8 and 12");
    }
  }

  async hydrate(tenantId: string, contactId: string): Promise<HydratedContext> {
    const normalizedTenantId = requiredIdentifier(tenantId, "tenantId");
    const normalizedContactId = requiredIdentifier(contactId, "contactId");
    const [tenant, contactConversation] = await Promise.all([
      this.repository.loadTenant(normalizedTenantId),
      this.repository.loadContactConversation(normalizedTenantId, normalizedContactId),
    ]);
    const [transcript, activeFacts, objectivesLedger] = await Promise.all([
      this.repository.loadRecentTranscript(normalizedTenantId, contactConversation.conversation.id, this.transcriptLimit),
      this.repository.loadActiveFacts(normalizedTenantId, contactConversation.contact.id),
      this.repository.loadObjectives(normalizedTenantId, contactConversation.contact.id),
    ]);
    const policies = await this.policyPackProvider.load(tenant.policyVersion);

    return {
      tenant: { ...tenant, policies },
      contact: contactConversation.contact,
      conversation: contactConversation.conversation,
      transcript,
      activeFacts: Object.fromEntries(activeFacts.map((fact) => [fact.key, fact.value])),
      objectivesLedger,
    };
  }
}

function requiredIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} cannot be empty`);
  return normalized;
}
