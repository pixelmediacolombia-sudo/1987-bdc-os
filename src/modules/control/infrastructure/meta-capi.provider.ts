import axios from "axios";
import type { MetaCapiPayload } from "@/modules/decisions/domain/meta-capi";

export class QualificationDeliveryError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "QualificationDeliveryError";
  }

  get retryable(): boolean {
    return this.status === 429 || (this.status !== undefined && this.status >= 500);
  }

  get rateLimited(): boolean {
    return this.status === 429;
  }
}

export type MetaCapiDeliveryInput = {
  datasetId: string;
  accessToken: string;
  payload: MetaCapiPayload;
  testEventCode?: string;
};

export class MetaCapiProvider {
  async send(input: MetaCapiDeliveryInput): Promise<{ fbtraceId?: string }> {
    const body = {
      ...input.payload,
      access_token: input.accessToken,
      ...(input.testEventCode ? { test_event_code: input.testEventCode } : {}),
    };
    try {
      const response = await axios.post<{ events_received?: number; fbtrace_id?: string }>(
        `https://graph.facebook.com/v21.0/${encodeURIComponent(input.datasetId)}/events`,
        body,
        { headers: { Accept: "application/json", "Content-Type": "application/json" } },
      );
      if (response.data.events_received !== undefined && response.data.events_received < 1) {
        throw new QualificationDeliveryError("Meta CAPI accepted the request but received no events", 502);
      }
      return { ...(response.data.fbtrace_id ? { fbtraceId: response.data.fbtrace_id } : {}) };
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const responseMessage = typeof error.response?.data === "object" && error.response?.data !== null
          ? JSON.stringify(error.response.data)
          : error.message;
        throw new QualificationDeliveryError(
          `Meta CAPI request failed: ${responseMessage.replace(input.accessToken, "[REDACTED]")}`,
          status,
        );
      }
      throw error;
    }
  }
}
