import type { NextFunction, Request, Response } from "express";

export type RawBodyRequest = Request & { rawBody?: Buffer };

export function captureRawBody(request: Request, _response: Response, buffer: Buffer): void {
  (request as RawBodyRequest).rawBody = Buffer.from(buffer);
}

export function parseCapturedJsonBody(request: Request, response: Response, next: NextFunction): void {
  const rawBody = (request as RawBodyRequest).rawBody;
  if (!rawBody) {
    response.status(400).json({ error: "Raw webhook body is unavailable" });
    return;
  }
  try {
    request.body = JSON.parse(rawBody.toString("utf8")) as unknown;
    next();
  } catch {
    response.status(400).json({ error: "Webhook body must be valid JSON" });
  }
}
