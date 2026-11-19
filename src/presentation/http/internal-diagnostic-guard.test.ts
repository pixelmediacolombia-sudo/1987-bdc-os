import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import {
  createInternalDiagnosticGuard,
  type InternalDiagnosticAuditPort,
} from "@/presentation/http/internal-diagnostic-guard";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const TOKEN_A = "a".repeat(40);
const TOKEN_B = "b".repeat(40);

type Capture = {
  statusCode: number;
  body?: unknown;
  headers: Record<string, string>;
  finish?: () => void;
  identity?: unknown;
};

function request(tenantId: string, token: string, ip = "10.1.2.3"): Request {
  return {
    query: { tenant_id: tenantId },
    get: (name: string) => name.toLowerCase() === "authorization" ? `Bearer ${token}` : undefined,
    socket: { remoteAddress: ip },
    method: "GET",
    path: "/outbound-deliveries/uncertain",
    originalUrl: `/outbound-deliveries/uncertain?tenant_id=${tenantId}&secret=do-not-audit`,
  } as unknown as Request;
}

function response(): { value: Response; capture: Capture } {
  const capture: Capture = { statusCode: 200, headers: {} };
  const value = {
    locals: {} as Record<string, unknown>,
    status(code: number) { capture.statusCode = code; return value; },
    json(body: unknown) { capture.body = body; return value; },
    setHeader(name: string, headerValue: string) { capture.headers[name.toLowerCase()] = headerValue; return value; },
    once(event: string, listener: () => void) { if (event === "finish") capture.finish = listener; return value; },
    get statusCode() { return capture.statusCode; },
  } as unknown as Response;
  return { value, capture };
}

function auditPort(overrides: Partial<InternalDiagnosticAuditPort> = {}): InternalDiagnosticAuditPort {
  return {
    start: async () => "audit-id",
    finish: async () => undefined,
    ...overrides,
  };
}

function nextSpy(): { next: () => void; count: () => number } {
  let calls = 0;
  return { next: () => { calls += 1; }, count: () => calls };
}

test("a tenant credential cannot authorize another tenant", async () => {
  const app = createInternalDiagnosticGuard({
    credentials: {
      [TENANT_A]: { token: TOKEN_A, actor: "ops-a" },
      [TENANT_B]: { token: TOKEN_B, actor: "ops-b" },
    },
    audit: auditPort(),
  });
  const { value, capture } = response();
  const next = nextSpy();

  await app(request(TENANT_B, TOKEN_A), value, next.next);

  assert.equal(capture.statusCode, 404);
  assert.deepEqual(capture.body, { error: "Not found" });
  assert.equal(next.count(), 0);
});

test("authenticated access is tenant-scoped, audited, and binds the configured actor", async () => {
  const started: Array<Record<string, unknown>> = [];
  const finished: Array<Record<string, unknown>> = [];
  const app = createInternalDiagnosticGuard({
    credentials: { [TENANT_A]: { token: TOKEN_A, actor: "Juan Operaciones" } },
    audit: auditPort({
      start: async (input) => { started.push(input); return "audit-row-1"; },
      finish: async (input) => { finished.push(input); },
    }),
  });
  const { value, capture } = response();
  const next = nextSpy();

  await app(request(TENANT_A, TOKEN_A), value, next.next);
  assert.equal(next.count(), 1);
  assert.equal(typeof capture.headers["x-request-id"], "string");
  assert.deepEqual(value.locals.internalDiagnosticIdentity, {
    tenantId: TENANT_A,
    actor: "Juan Operaciones",
    requestId: capture.headers["x-request-id"],
  });
  assert.equal(started[0]?.route, "/outbound-deliveries/uncertain");
  assert.doesNotMatch(String(started[0]?.route), /secret|tenant_id/);

  capture.finish?.();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(finished, [{ tenantId: TENANT_A, auditId: "audit-row-1", statusCode: 200 }]);
});

test("diagnostic audit failure fails closed before the handler runs", async () => {
  const app = createInternalDiagnosticGuard({
    credentials: { [TENANT_A]: { token: TOKEN_A, actor: "ops-a" } },
    audit: auditPort({ start: async () => { throw new Error("database unavailable"); } }),
  });
  const { value, capture } = response();
  const next = nextSpy();

  await app(request(TENANT_A, TOKEN_A), value, next.next);

  assert.equal(capture.statusCode, 503);
  assert.equal(next.count(), 0);
});

test("production diagnostic access requires the exact allowed remote IP", async () => {
  const app = createInternalDiagnosticGuard({
    credentials: { [TENANT_A]: { token: TOKEN_A, actor: "ops-a" } },
    audit: auditPort(),
    production: true,
    allowedRemoteIps: ["10.1.2.3"],
  });
  const denied = response();
  const next = nextSpy();
  await app(request(TENANT_A, TOKEN_A, "203.0.113.8"), denied.value, next.next);
  assert.equal(denied.capture.statusCode, 404);
  assert.equal(next.count(), 0);

  const accepted = response();
  await app(request(TENANT_A, TOKEN_A, "::ffff:10.1.2.3"), accepted.value, next.next);
  assert.equal(next.count(), 1);
});

test("authenticated diagnostics are rate-limited per tenant and actor", async () => {
  let timestamp = 1_000;
  const app = createInternalDiagnosticGuard({
    credentials: { [TENANT_A]: { token: TOKEN_A, actor: "ops-a" } },
    audit: auditPort(),
    limitPerMinute: 1,
    now: () => timestamp,
  });
  const first = response();
  const next = nextSpy();
  await app(request(TENANT_A, TOKEN_A), first.value, next.next);
  assert.equal(next.count(), 1);

  const second = response();
  await app(request(TENANT_A, TOKEN_A), second.value, next.next);
  assert.equal(second.capture.statusCode, 429);
  assert.deepEqual(second.capture.body, {
    error: "Diagnostic rate limit exceeded",
    request_id: second.capture.headers["x-request-id"],
  });

  timestamp += 60_001;
  const third = response();
  await app(request(TENANT_A, TOKEN_A), third.value, next.next);
  assert.equal(next.count(), 2);
});
