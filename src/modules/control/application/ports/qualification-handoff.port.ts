import type { SofiaLeadLevel } from "@/modules/decisions/domain/sofia-conversation";

export type QualificationHandoffInput = {
  tenantId: string;
  contactId: string;
  leadLevel: Extract<SofiaLeadLevel, "A" | "B">;
  stage: "Calificado";
  customerMessage: string;
};

/**
 * Boundary for the CRM handoff. Local tests record this boundary; a provider
 * must be composed explicitly before any real GHL stage mutation is allowed.
 */
export interface QualificationHandoffPort {
  markQualified(input: QualificationHandoffInput): Promise<void>;
}
