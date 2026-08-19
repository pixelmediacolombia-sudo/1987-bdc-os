import type { Request, Response } from "express";
import { InMemoryWebhookQueue } from "@/modules/webhooks/application/in-memory-webhook.queue";
import type { WebhookQueuePort } from "@/modules/webhooks/application/ports/webhook-queue.port";
import type { ProcessGHLWebhookUseCase } from "@/modules/webhooks/application/process-ghl-webhook.use-case";
import type { RawBodyRequest } from "@/modules/webhooks/presentation/http/validate-ghl-signature.middleware";

export class WebhookController {
  constructor(
    private readonly processUseCase: ProcessGHLWebhookUseCase,
    private readonly queue: WebhookQueuePort = new InMemoryWebhookQueue(),
  ) {}

  receiveGhlWebhook = async (req: Request, res: Response): Promise<void> => {
    const rawBody = (req as RawBodyRequest).rawBody;
    const signature = req.get("x-ghl-signature") ?? req.get("x-wh-signature") ?? "";

    if (!rawBody) {
      res.status(400).json({ error: "Raw webhook body is unavailable" });
      return;
    }

    try {
      const queued = await this.queue.enqueue(rawBody, signature, async () => {
        await this.processUseCase.execute({ payload: req.body, rawBody, signature });
      });

      // GHL uses the HTTP response as the delivery ACK. Durable production
      // queues persist the raw event before this response is emitted.
      res.status(200).json({ ok: true, queued: true, duplicate_in_flight: !queued });
    } catch {
      res.status(503).json({ error: "Webhook queue unavailable" });
    }
  };
}
