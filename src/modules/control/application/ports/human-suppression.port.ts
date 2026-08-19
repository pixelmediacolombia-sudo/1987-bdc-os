import type { HumanInterruptionTrigger } from "@/modules/webhooks/domain/ghl-webhook-event";

export type HumanSuppressionInput = {
  tenantId: string;
  contactId: string;
  trigger: HumanInterruptionTrigger;
};

export interface HumanSuppressionPort {
  suppress(input: HumanSuppressionInput): Promise<void>;
}
