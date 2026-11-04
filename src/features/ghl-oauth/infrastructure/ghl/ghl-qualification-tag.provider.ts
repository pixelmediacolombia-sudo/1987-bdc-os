import axios from "axios";
import type { GhlApiClient } from "@/features/ghl-oauth/infrastructure/ghl/ghl-api.client";
import { QualificationDeliveryError } from "@/modules/control/infrastructure/meta-capi.provider";
import type { QualificationHandoffInput, QualificationHandoffPort } from "@/modules/control/application/ports/qualification-handoff.port";

type GhlContactResponse = { tags?: unknown };

export class GhlQualificationTagProvider implements QualificationHandoffPort {
  constructor(private readonly apiClient: GhlApiClient) {}

  async addQualificationCompletedTag(input: {
    tenantId: string;
    ghlContactId: string;
  }): Promise<void> {
    try {
      const existing = await this.apiClient.request<GhlContactResponse>(input.tenantId, {
        method: "GET",
        url: `https://services.leadconnectorhq.com/contacts/${encodeURIComponent(input.ghlContactId)}`,
        headers: { Accept: "application/json", Version: "2021-07-28" },
      });
      const tags = Array.isArray(existing.data.tags)
        ? existing.data.tags.filter((tag): tag is string => typeof tag === "string")
        : [];
      // GHL workflows triggered by tag addition should not be re-fired merely
      // because a previously qualified lead is evaluated again.
      if (tags.includes("qualification_completed")) return;
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

  async markQualified(input: QualificationHandoffInput): Promise<void> {
    await this.addQualificationCompletedTag({ tenantId: input.tenantId, ghlContactId: input.contactId });
  }
}
