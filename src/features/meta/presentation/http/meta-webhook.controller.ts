import type { Request, Response } from "express";
import type { WebhookQueuePort } from "@/modules/webhooks/application/ports/webhook-queue.port";
import type { ProcessInboundWebhookUseCase } from "@/modules/webhooks/application/process-inbound-webhook.use-case";
import type { RawBodyRequest } from "@/modules/webhooks/presentation/http/raw-body.middleware";
import { parseMetaWebhookPayload } from "@/features/meta/domain/meta-webhook.parser";

export class MetaWebhookController {
  constructor(
    private readonly processUseCase: ProcessInboundWebhookUseCase,
    private readonly queue: WebhookQueuePort,
    private readonly verifyToken?: string,
  ) {}

  verify = (request: Request, response: Response): void => {
    const mode = request.query["hub.mode"];
    const token = request.query["hub.verify_token"];
    const challenge = request.query["hub.challenge"];
    if (mode === "subscribe" && this.verifyToken && token === this.verifyToken && typeof challenge === "string") {
      response.status(200).type("text/plain").send(challenge);
      return;
    }
    response.status(403).json({ error: "Meta webhook verification failed" });
  };

  receive = async (request: Request, response: Response): Promise<void> => {
    const rawBody = (request as RawBodyRequest).rawBody;
    const signature = request.get("x-hub-signature-256") ?? "";
    if (!rawBody) {
      response.status(400).json({ error: "Raw Meta webhook body is unavailable" });
      return;
    }
    try {
      const queued = await this.queue.enqueue(rawBody, signature, async () => {
        await this.process(rawBody, signature);
      });
      response.status(200).json({ ok: true, queued: true, duplicate_in_flight: !queued });
    } catch {
      response.status(503).json({ error: "Meta webhook queue unavailable" });
    }
  };

  async process(rawBody: Buffer, signature: string): Promise<void> {
    const payload: unknown = JSON.parse(rawBody.toString("utf8"));
    for (const event of parseMetaWebhookPayload(payload, rawBody, signature)) {
      await this.processUseCase.execute(event);
    }
  }
}
