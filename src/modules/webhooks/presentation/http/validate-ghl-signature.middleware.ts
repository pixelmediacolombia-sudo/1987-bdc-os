import type { NextFunction, Request, RequestHandler, Response } from "express";
import { isValidGhlSignature } from "@/modules/webhooks/domain/ghl-signature.validator";

export type RawBodyRequest = Request & { rawBody?: Buffer };

export function captureRawBody(req: Request, _res: Response, buffer: Buffer): void {
  (req as RawBodyRequest).rawBody = Buffer.from(buffer);
}

export function validateGhlSignature(secret: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawBody = (req as RawBodyRequest).rawBody;
    const signature = req.get("x-ghl-signature") ?? req.get("x-signature");

    if (!rawBody || !signature || !isValidGhlSignature(rawBody, signature, secret)) {
      res.status(401).json({ error: "Invalid GHL webhook signature" });
      return;
    }

    next();
  };
}
