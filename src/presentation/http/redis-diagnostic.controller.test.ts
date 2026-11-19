import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { RedisDiagnosticController } from "@/presentation/http/redis-diagnostic.controller";

type ResponseCapture = {
  statusCode: number;
  body?: unknown;
};

function requestWithToken(token?: string): Request {
  return {
    get: () => token,
  } as unknown as Request;
}

function responseCapture(): { response: Response; capture: ResponseCapture } {
  const capture: ResponseCapture = { statusCode: 200 };
  const response = {
    locals: { internalDiagnosticIdentity: {
      tenantId: "00000000-0000-4000-8000-000000000001",
      actor: "ops",
      requestId: "00000000-0000-4000-8000-000000000002",
    } },
    status(code: number) {
      capture.statusCode = code;
      return response;
    },
    json(body: unknown) {
      capture.body = body;
      return response;
    },
  } as unknown as Response;
  return { response, capture };
}

test("rejects Redis diagnostics when no authenticated admin identity is attached", async () => {
  const controller = new RedisDiagnosticController({
    ping: async () => "PONG",
    zcard: async () => 0,
  });
  const { response, capture } = responseCapture();
  response.locals.internalDiagnosticIdentity = undefined;

  await controller.health(requestWithToken(), response);

  assert.equal(capture.statusCode, 404);
  assert.deepEqual(capture.body, { error: "Not found" });
});

test("returns sanitized Redis reachability and queue counts", async () => {
  const controller = new RedisDiagnosticController({
    ping: async () => "PONG",
    zcard: async (key) => key.endsWith("pending") ? 2 : 0,
  });
  const { response, capture } = responseCapture();

  await controller.health(requestWithToken(), response);

  const body = capture.body as { checked_at: string };
  assert.equal(capture.statusCode, 200);
  assert.equal((capture.body as { redis_reachable: boolean }).redis_reachable, true);
  assert.equal((capture.body as { ping: string }).ping, "PONG");
  assert.deepEqual((capture.body as { queues: unknown }).queues, {
    webhook_pending: 2,
    webhook_dead_letter: 0,
  });
  assert.match(body.checked_at, /^20/);
});

test("does not expose Redis connection errors", async () => {
  const controller = new RedisDiagnosticController({
    ping: async () => { throw new Error("redis://user:password@private-host"); },
    zcard: async () => 0,
  });
  const { response, capture } = responseCapture();

  await controller.health(requestWithToken(), response);

  assert.equal(capture.statusCode, 503);
  assert.deepEqual(capture.body, {
    test: "Redis Connectivity",
    redis_reachable: false,
    error: "Redis health check failed",
  });
});
