import express from "express";
import type { GhlOAuthController } from "@/features/ghl-oauth/presentation/http/ghl-oauth.controller";
import { createGhlOAuthRouter } from "@/features/ghl-oauth/presentation/http/ghl-oauth.routes";

export function createHttpApp(controller: GhlOAuthController) {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "100kb" }));
  app.get("/health", (_req, res) => res.status(200).json({ ok: true }));
  app.use("/oauth", createGhlOAuthRouter(controller));
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}
