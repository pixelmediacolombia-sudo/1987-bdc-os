import type { Request, Response } from "express";
import { InMemoryWebhookQueue } from "@/modules/webhooks/application/in-memory-webhook.queue";
import type { ProcessGHLWebhookUseCase } from "@/modules/webhooks/application/process-ghl-webhook.use-case";
import type { RawBodyRequest } from "@/modules/webhooks/presentation/http/validate-ghl-signature.middleware";

export class WebhookController {
  constructor(
    private readonly processUseCase: ProcessGHLWebhookUseCase,
    private readonly queue = new InMemoryWebhookQueue(),
  ) {}

  receiveGhlWebhook = (req: Request, res: Response): void => {
    const rawBody = (req as RawBodyRequest).rawBody;
    const signature = req.get("x-ghl-signature") ?? req.get("x-wh-signature") ?? "";

    if (!rawBody) {
      res.status(400).json({ error: "Raw webhook body is unavailable" });
      return;
    }

    const queued = this.queue.enqueue(rawBody, async () => {
      await this.processUseCase.execute({
        payload: req.body,
        rawBody,
        signature,
      });
    });

    // GHL uses the HTTP response as the delivery ACK. All parsing, tenant
    // resolution, persistence, and downstream work stays outside this cycle.
    res.status(200).json({ ok: true, queued: true, duplicate_in_flight: !queued });
  };
}
