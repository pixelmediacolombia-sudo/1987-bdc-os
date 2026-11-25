import assert from "node:assert/strict";
import axios from "axios";
import { test } from "node:test";
import { buildMetaCapiPayload } from "@/modules/decisions/domain/meta-capi";
import { MetaCapiProvider, QualificationDeliveryError } from "@/modules/control/infrastructure/meta-capi.provider";

const payload = buildMetaCapiPayload({
  eventName: "LeadSubmitted",
  eventId: "synthetic-event",
  eventTime: new Date("2026-11-25T12:00:00.000Z"),
  dealer: "synthetic-tenant",
  contactId: "synthetic-contact",
  ctwaClid: "synthetic-click",
  objectivesAnswered: 1,
});

for (const scenario of [
  { name: "invalid dataset", status: 400 },
  { name: "insufficient permission", status: 403 },
]) {
  test("Meta CAPI " + scenario.name + " is handled without a network request", async () => {
    const originalPost = axios.post;
    let requestedUrl = "";
    const axiosMutable = axios as unknown as {
      post: (url: string, body: unknown, config: unknown) => Promise<unknown>;
    };
    axiosMutable.post = async (url) => {
      requestedUrl = url;
      throw Object.assign(new Error("synthetic request failure"), {
        isAxiosError: true,
        response: {
          status: scenario.status,
          data: { error: { message: "synthetic permission or dataset error" } },
        },
      });
    };

    try {
      await assert.rejects(
        new MetaCapiProvider().send({
          datasetId: "synthetic-invalid-dataset",
          accessToken: "synthetic-secret-token",
          payload,
        }),
        (error: unknown) => {
          assert.ok(error instanceof QualificationDeliveryError);
          assert.equal(error.status, scenario.status);
          assert.match(error.message, /synthetic permission or dataset error/);
          assert.doesNotMatch(error.message, /synthetic-secret-token/);
          return true;
        },
      );
      assert.equal(
        requestedUrl,
        "https://graph.facebook.com/v21.0/synthetic-invalid-dataset/events",
      );
    } finally {
      axiosMutable.post = originalPost as unknown as typeof axiosMutable.post;
    }
  });
}
