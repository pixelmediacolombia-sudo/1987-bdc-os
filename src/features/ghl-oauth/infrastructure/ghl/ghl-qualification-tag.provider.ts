import axios from "axios";
import type { GhlApiClient } from "@/features/ghl-oauth/infrastructure/ghl/ghl-api.client";
import { QualificationDeliveryError } from "@/modules/control/infrastructure/meta-capi.provider";

export class GhlQualificationTagProvider {
  constructor(private readonly apiClient: GhlApiClient) {}

  async addQualificationCompletedTag(input: {
    tenantId: string;
    ghlContactId: string;
  }): Promise<void> {
    try {
      await this.apiClient.request(input.tenantId, {
        method: "POST",
        url: `https://services.leadconnectorhq.com/contacts/${encodeURIComponent(input.ghlContactId)}/tags`,
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Version: "2021-07-28",
        },
        data: { tags: ["qualification_completed"] },
      });
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        throw new QualificationDeliveryError(`GHL qualification tag request failed: ${error.message}`, status);
      }
      throw error;
    }
  }
}
