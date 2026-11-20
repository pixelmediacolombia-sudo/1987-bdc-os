import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { MetaGraphApiClient, MetaGraphApiError, type MetaGraphMessageInput } from "@/features/meta/infrastructure/meta-graph-api.client";
import { MetaOutboundMessageProvider } from "@/features/meta/infrastructure/meta-outbound-message.provider";

test("Meta Graph client sends Messenger text to a configurable Graph URL", async () => {
  let captured: { url?: URL; body?: Record<string, unknown> } = {};
  const client = new MetaGraphApiClient("https://graph.test", "v27.0", async (input, init) => {
    captured = { url: new URL(String(input)), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return Response.json({ message_id: "m-mid-1" });
  });
  const result = await client.sendText({ channel: "messenger", senderId: "page-1", recipientId: "psid-1", accessToken: "page-token", text: "Hola" });
  assert.deepEqual(result, { messageId: "m-mid-1" });
  assert.equal(captured.url?.pathname, "/v27.0/page-1/messages");
  assert.equal(captured.url?.searchParams.get("access_token"), "page-token");
  assert.deepEqual(captured.body, { recipient: { id: "psid-1" }, messaging_type: "RESPONSE", message: { text: "Hola" } });
});

test("Meta Graph client sends WhatsApp Cloud API text with the product marker", async () => {
  let body: Record<string, unknown> | undefined;
  const client = new MetaGraphApiClient("https://graph.test", "v27.0", async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ messages: [{ id: "wamid.1" }] });
  });
  assert.deepEqual(await client.sendText({ channel: "whatsapp", senderId: "phone-id", recipientId: "15551234567", accessToken: "wa-token", text: "Hola" }), { messageId: "wamid.1" });
  assert.deepEqual(body, { messaging_product: "whatsapp", recipient: { id: "15551234567" }, type: "text", text: { body: "Hola" } });
});

test("Meta Graph client sends Instagram messages through the Instagram business account", async () => {
  let captured: { url?: URL; body?: Record<string, unknown> } = {};
  const client = new MetaGraphApiClient("https://graph.test", "v27.0", async (input, init) => {
    captured = { url: new URL(String(input)), body: JSON.parse(String(init?.body)) as Record<string, unknown> };
    return Response.json({ message_id: "ig-mid-1" });
  });
  await client.sendText({ channel: "instagram", senderId: "ig-business-1", recipientId: "igsid-1", accessToken: "ig-token", text: "Hola" });
  assert.equal(captured.url?.pathname, "/v27.0/ig-business-1/messages");
  assert.deepEqual(captured.body, { recipient: { id: "igsid-1" }, messaging_type: "RESPONSE", message: { text: "Hola" } });
});

test("Meta outbound provider resolves each dealer's independent channel credentials", async () => {
  const sent: string[] = [];
  const provider = new MetaOutboundMessageProvider({
    getForTenant: async (tenantId) => tenantId === "dealer-1"
      ? { pageAccessToken: "page-token", instagramAccessToken: "ig-token", whatsappAccessToken: "wa-token", pageId: "page-1", instagramBusinessId: "ig-1", whatsappPhoneNumberId: "phone-1" }
      : undefined,
  }, {
    sendText: async (input: MetaGraphMessageInput) => { sent.push(`${input.channel}:${input.senderId}:${input.recipientId}`); return { messageId: `mid-${sent.length}` }; },
  } as never);
  const first = await provider.send({ tenantId: "dealer-1", contactId: "psid-1", content: "Hola", channel: "FB" } as never);
  const second = await provider.send({ tenantId: "dealer-1", contactId: "wa-1", content: "Hola", channel: "WhatsApp" } as never);
  const third = await provider.send({ tenantId: "dealer-1", contactId: "igsid-1", content: "Hola", channel: "IG" } as never);
  assert.deepEqual(sent, ["messenger:page-1:psid-1", "whatsapp:phone-1:wa-1", "instagram:ig-1:igsid-1"]);
  assert.deepEqual([first.providerMessageId, second.providerMessageId, third.providerMessageId], ["mid-1", "mid-2", "mid-3"]);
});

test("Meta Graph errors retain HTTP status and never echo the access token", async () => {
  const client = new MetaGraphApiClient("https://graph.test", "v27.0", async () => Response.json({ error: { message: "Rejected page-token-secret" } }, { status: 401 }));
  await assert.rejects(
    client.sendText({ channel: "messenger", senderId: "page-1", recipientId: "psid-1", accessToken: "page-token-secret", text: "Hola" }),
    (error: unknown) => error instanceof MetaGraphApiError && error.status === 401 && !error.message.includes("page-token-secret"),
  );
});

test("Meta Graph API production endpoint can be replaced with a local HTTP simulator", async (context) => {
  const requests: Array<{ url: string; body: string }> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({ url: request.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ message_id: "simulated-meta-message" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new MetaGraphApiClient(`http://127.0.0.1:${address.port}`, "v27.0");

  const result = await client.sendText({ channel: "messenger", senderId: "page-test", recipientId: "psid-test", accessToken: "local-token", text: "Prueba local" });

  assert.deepEqual(result, { messageId: "simulated-meta-message" });
  assert.equal(requests.length, 1);
  assert.match(requests[0]!.url, /^\/v27\.0\/page-test\/messages\?access_token=local-token$/);
  assert.deepEqual(JSON.parse(requests[0]!.body), { recipient: { id: "psid-test" }, messaging_type: "RESPONSE", message: { text: "Prueba local" } });
});
