import type { Request, Response } from "express";
import type { ProcessGHLWebhookUseCase } from "@/modules/webhooks/application/process-ghl-webhook.use-case";
import type { RawBodyRequest } from "@/modules/webhooks/presentation/http/validate-ghl-signature.middleware";

export class WebhookController {
  constructor(private readonly processUseCase: ProcessGHLWebhookUseCase) {}

  receiveGhlWebhook = async (req: Request, res: Response): Promise<void> => {
    const rawBody = (req as RawBodyRequest).rawBody;
    const signature = req.get("x-ghl-signature") ?? req.get("x-signature") ?? "";

    if (!rawBody) {
      res.status(400).json({ error: "Raw webhook body is unavailable" });
      return;
    }

    try {
      const result = await this.processUseCase.execute({
        payload: req.body,
        rawBody,
        signature,
      });

      if (result.duplicate) {
        res.status(200).json({ ok: true, duplicate: true, external_id: result.externalId });
        return;
      }

      res.status(200).json({ ok: true, processed: true, external_id: result.externalId });
    } catch (error) {
      console.error("GHL webhook processing failed", error instanceof Error ? error.message : "unknown error");
      res.status(400).json({ error: "Invalid GHL webhook" });
    }
  };
}
