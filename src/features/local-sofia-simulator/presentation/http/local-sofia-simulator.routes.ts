import express, { type Request, type Response } from "express";
import type { Pool } from "pg";
import { activeSession } from "@/features/identity/presentation/http/routes/route-helpers";
import type { LocalSofiaSimulatorService } from "@/features/local-sofia-simulator/application/local-sofia-simulator.service";

function safeModelHost(value?: string): string | null {
  try { return value ? new URL(value).host : null; } catch { return null; }
}

export function createLocalSofiaSimulatorRouter(
  pool: Pool,
  simulator: LocalSofiaSimulatorService | undefined,
  modelBaseUrl?: string,
): express.Router {
  const router = express.Router();

  router.use(async (request: Request, response: Response, next: express.NextFunction) => {
    const user = await activeSession(pool, request);
    if (!user) { response.status(401).json({ error: "Inicia sesión para usar el simulador local." }); return; }
    if (user.account_type !== "admin") { response.status(403).json({ error: "El simulador local requiere una cuenta de administrador." }); return; }
    next();
  });

  router.get("/local/sofia-simulator/status", (_request: Request, response: Response) => {
    response.status(200).json({
      enabled: Boolean(simulator),
      localOnly: true,
      sendsMessages: false,
      contactName: "Andrea Demo",
      modelHost: safeModelHost(modelBaseUrl),
      modelMode: simulator ? "OpenAI interpreta; Sofia genera la respuesta con reglas del backend." : "Apagado por configuración local.",
    });
  });

  router.post("/local/sofia-simulator/turn", async (request: Request, response: Response) => {
    if (!simulator) {
      response.status(409).json({ error: "Activa SOFIA_ENABLED y CONVERSATIONAL_AI_ENABLED en el backend local para probar." });
      return;
    }
    const message = typeof request.body?.message === "string" ? request.body.message : "";
    const conversationId = typeof request.body?.conversationId === "string" ? request.body.conversationId : undefined;
    if (!message.trim() || message.length > 2000) {
      response.status(400).json({ error: "Escribe un mensaje de hasta 2000 caracteres." });
      return;
    }
    try {
      response.status(200).json(await simulator.turn(message, conversationId));
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "No pudimos procesar el turno local.";
      response.status(422).json({ error: messageText });
    }
  });

  router.post("/local/sofia-simulator/reset", (request: Request, response: Response) => {
    const conversationId = typeof request.body?.conversationId === "string" ? request.body.conversationId : undefined;
    simulator?.reset(conversationId);
    response.status(200).json({ reset: true, localOnly: true });
  });

  return router;
}
