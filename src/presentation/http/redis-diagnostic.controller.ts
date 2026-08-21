import type { Request, Response } from "express";

export type RedisDiagnosticPort = {
  ping(): Promise<string>;
  zcard(key: string): Promise<number>;
};

export class RedisDiagnosticController {
  constructor(
    private readonly redis: RedisDiagnosticPort,
    private readonly diagnosticToken?: string,
  ) {}

  health = async (req: Request, res: Response): Promise<void> => {
    if (!this.diagnosticToken || req.get("x-policy-diagnostic-token") !== this.diagnosticToken) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    try {
      const [ping, webhookQueuePending, webhookQueueDeadLetter] = await Promise.all([
        this.redis.ping(),
        this.redis.zcard("queue:webhook:pending"),
        this.redis.zcard("queue:webhook:dead-letter"),
      ]);

      res.status(200).json({
        test: "Redis Connectivity in Render Production",
        redis_reachable: ping === "PONG",
        ping,
        queues: {
          webhook_pending: webhookQueuePending,
          webhook_dead_letter: webhookQueueDeadLetter,
        },
        checked_at: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({
        test: "Redis Connectivity in Render Production",
        redis_reachable: false,
        error: "Redis health check failed",
      });
    }
  };
}
