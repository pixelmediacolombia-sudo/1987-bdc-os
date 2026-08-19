import type { NextFunction, Request, RequestHandler, Response } from "express";
import {
  GHL_ED25519_PUBLIC_KEY,
  GHL_LEGACY_RSA_PUBLIC_KEY,
  isValidGhlSignature,
} from "@/modules/webhooks/domain/ghl-signature.validator";

export type RawBodyRequest = Request & { rawBody?: Buffer };

export function captureRawBody(req: Request, _res: Response, buffer: Buffer): void {
  (req as RawBodyRequest).rawBody = Buffer.from(buffer);
}

export type GhlSignatureKeys = {
  ed25519PublicKey: string;
  legacyRsaPublicKey: string;
};

const DEFAULT_KEYS: GhlSignatureKeys = {
  ed25519PublicKey: GHL_ED25519_PUBLIC_KEY,
  legacyRsaPublicKey: GHL_LEGACY_RSA_PUBLIC_KEY,
};

export function validateGhlSignature(keys: GhlSignatureKeys = DEFAULT_KEYS): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rawBody = (req as RawBodyRequest).rawBody;
    const currentSignature = req.get("x-ghl-signature");
    const legacySignature = req.get("x-wh-signature");
    const signature = currentSignature ?? legacySignature;
    const header = currentSignature ? "x-ghl-signature" : legacySignature ? "x-wh-signature" : undefined;

    if (!rawBody || !signature || !header || !isValidGhlSignature(rawBody, signature, header, keys)) {
      res.status(401).json({ error: "Invalid GHL webhook signature" });
      return;
    }

    next();
  };
}

export function parseCapturedJsonBody(req: Request, res: Response, next: NextFunction): void {
  const rawBody = (req as RawBodyRequest).rawBody;
  if (!rawBody) {
    res.status(400).json({ error: "Raw webhook body is unavailable" });
    return;
  }

  try {
    req.body = JSON.parse(rawBody.toString("utf8")) as unknown;
    next();
  } catch {
    res.status(400).json({ error: "Webhook body must be valid JSON" });
  }
}
