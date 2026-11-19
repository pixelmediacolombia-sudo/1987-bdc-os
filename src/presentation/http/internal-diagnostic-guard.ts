import { timingSafeEqual, randomUUID } from "node:crypto";
import type { Request, Response, NextFunction, RequestHandler } from "express";

export type InternalDiagnosticCredential = {
  token: string;
  actor: string;
};

export type InternalDiagnosticIdentity = {
  tenantId: string;
  actor: string;
  requestId: string;
};

export type InternalDiagnosticAuditPort = {
  start(input: {
    tenantId: string;
    actor: string;
    requestId: string;
    method: string;
    route: string;
    remoteAddress: string;
  }): Promise<string>;
  finish(input: {
    tenantId: string;
    auditId: string;
    statusCode: number;
  }): Promise<void>;
};

export type InternalDiagnosticGuardOptions = {
  credentials: Record<string, InternalDiagnosticCredential>;
  audit: InternalDiagnosticAuditPort;
  allowedRemoteIps?: string[];
  production?: boolean;
  limitPerMinute?: number;
  now?: () => number;
};

const TENANT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createInternalDiagnosticGuard(options: InternalDiagnosticGuardOptions): RequestHandler {
  const credentials = new Map(
    Object.entries(options.credentials).map(([tenantId, credential]) => [tenantId.toLowerCase(), credential]),
  );
  const allowedIps = new Set((options.allowedRemoteIps ?? []).map(normalizeIp));
  const requestTimes = new Map<string, number[]>();
  const limit = options.limitPerMinute ?? 30;
  const now = options.now ?? Date.now;

  return (req, res, next) => authorize(req, res, next);

  async function authorize(req: Request, res: Response, next: NextFunction): Promise<void> {
    const tenantId = singleQueryValue(req, "tenant_id");
    const bearerToken = parseBearerToken(req.get("authorization"));
    const credential = tenantId && TENANT_ID_PATTERN.test(tenantId)
      ? credentials.get(tenantId.toLowerCase())
      : undefined;
    if (!tenantId || !credential || !sameSecret(bearerToken, credential.token)) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const remoteAddress = normalizeIp(req.socket.remoteAddress ?? "");
    if (options.production && (!allowedIps.size || !allowedIps.has(remoteAddress))) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const requestId = randomUUID();
    let auditId: string;
    try {
      auditId = await options.audit.start({
        tenantId,
        actor: credential.actor,
        requestId,
        method: req.method,
        route: req.originalUrl.split("?", 1)[0] ?? req.path,
        remoteAddress,
      });
    } catch {
      res.status(503).json({ error: "Diagnostic audit is unavailable" });
      return;
    }

    const identity: InternalDiagnosticIdentity = { tenantId, actor: credential.actor, requestId };
    res.locals.internalDiagnosticIdentity = identity;
    res.setHeader("x-request-id", requestId);
    res.once("finish", () => {
      void options.audit.finish({ tenantId, auditId, statusCode: res.statusCode }).catch(() => {
        // The start record remains durable if result finalization fails.
      });
    });

    const timestamp = now();
    const rateKey = `${tenantId.toLowerCase()}:${credential.actor}`;
    const recent = (requestTimes.get(rateKey) ?? []).filter((value) => timestamp - value < 60_000);
    if (recent.length >= limit) {
      requestTimes.set(rateKey, recent);
      res.status(429).json({ error: "Diagnostic rate limit exceeded", request_id: requestId });
      return;
    }
    recent.push(timestamp);
    requestTimes.set(rateKey, recent);
    next();
  }
}

export function internalDiagnosticIdentity(res: Response): InternalDiagnosticIdentity | undefined {
  const identity: unknown = res.locals.internalDiagnosticIdentity;
  if (!identity || typeof identity !== "object") return undefined;
  const value = identity as Partial<InternalDiagnosticIdentity>;
  return typeof value.tenantId === "string" && typeof value.actor === "string" && typeof value.requestId === "string"
    ? value as InternalDiagnosticIdentity
    : undefined;
}

function singleQueryValue(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseBearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+([^\s]+)$/i);
  return match?.[1];
}

function sameSecret(provided: string | undefined, expected: string): boolean {
  if (!provided) return false;
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function normalizeIp(value: string): string {
  return value.startsWith("::ffff:") ? value.slice(7) : value;
}
