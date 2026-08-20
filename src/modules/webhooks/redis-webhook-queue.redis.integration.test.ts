import assert from "node:assert/strict";
import { test } from "node:test";
import { IoredisClient } from "@/modules/control/infrastructure/redis/ioredis-client";
import { RedisWebhookQueue } from "@/modules/webhooks/infrastructure/redis/redis-webhook-queue";

const enabled = process.env.RUN_REDIS_INTEGRATION_TESTS === "true" && Boolean(process.env.REDIS_URL?.trim());

test("Redis real: webhook queue procesa y ACKea solo después del handler", { skip: !enabled }, async () => {
  const redis = new IoredisClient(process.env.REDIS_URL as string);
  const queue = new RedisWebhookQueue(redis, { maxAttempts: 2, backoffMs: 25, maxBackoffMs: 100 });
  let calls = 0;
  try {
    await queue.enqueue(Buffer.from("render-redis-webhook"), "render-signature");
    await queue.start(async (job) => {
      calls += 1;
      assert.equal(job.rawBody.toString("utf8"), "render-redis-webhook");
      assert.equal(job.signature, "render-signature");
    });
    for (let attempt = 0; attempt < 200 && calls === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(calls, 1);
  } finally {
    await queue.stop();
    await redis.close();
  }
});
