import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { MetaOAuthClient } from "@/features/meta/application/oauth/meta-oauth.client";

test("Meta OAuth builds an authorization URL with only the requested permissions", () => {
  const client = new MetaOAuthClient("app-1", "secret-1", "http://localhost:3000/oauth/meta/callback", "http://127.0.0.1:9999", "v27.0", "https://www.facebook.com");
  const url = new URL(client.authorizationUrl("signed-state", ["pages_messaging", "instagram_manage_messages"]));
  assert.equal(url.origin, "https://www.facebook.com");
  assert.equal(url.pathname, "/v27.0/dialog/oauth");
  assert.equal(url.searchParams.get("state"), "signed-state");
  assert.equal(url.searchParams.get("scope"), "pages_messaging,instagram_manage_messages");
});

test("Meta OAuth exchange and asset discovery run against local simulated production URLs", async (context) => {
  const requests: Array<{ path: string; query: URLSearchParams }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    requests.push({ path: url.pathname, query: url.searchParams });
    const routes: Record<string, unknown> = {
      "/v27.0/oauth/access_token": url.searchParams.get("grant_type") === "fb_exchange_token"
        ? { access_token: "long-user-token", expires_in: 5184000 }
        : { access_token: "short-user-token", expires_in: 3600 },
      "/v27.0/me/accounts": { data: [{ id: "page-1", name: "Dealer page", access_token: "page-token-1", instagram_business_account: { id: "ig-account-1" } }] },
      "/v27.0/me/businesses": { data: [{ id: "business-1" }] },
      "/v27.0/business-1/owned_whatsapp_business_accounts": { data: [{ id: "waba-1" }] },
      "/v27.0/waba-1/phone_numbers": { data: [{ id: "phone-1" }] },
      "/v27.0/me/permissions": { data: [
        { permission: "pages_messaging", status: "granted" },
        { permission: "instagram_manage_messages", status: "granted" },
        { permission: "whatsapp_business_messaging", status: "granted" },
        { permission: "pages_manage_posts", status: "declined" },
      ] },
    };
    const payload = routes[url.pathname];
    response.writeHead(payload ? 200 : 404, { "content-type": "application/json" });
    response.end(JSON.stringify(payload ?? { error: { message: "not found" } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const client = new MetaOAuthClient("app-1", "app-secret", "http://localhost:3000/oauth/meta/callback", `http://127.0.0.1:${address.port}`);

  const short = await client.exchangeCode("one-use-code");
  const long = await client.exchangeLongLivedToken(short.accessToken);
  const assets = await client.listAssets(long.accessToken);

  assert.equal(short.accessToken, "short-user-token");
  assert.equal(long.accessToken, "long-user-token");
  assert.deepEqual(assets.pages, [{ id: "page-1", name: "Dealer page", accessToken: "page-token-1", instagramBusinessId: "ig-account-1" }]);
  assert.deepEqual(assets.whatsappPhoneNumberIds, ["phone-1"]);
  assert.deepEqual(assets.grantedScopes, ["pages_messaging", "instagram_manage_messages", "whatsapp_business_messaging"]);
  assert.ok(requests.every((request) => request.path.startsWith("/v27.0/")));
  assert.ok(requests.some((request) => request.query.get("code") === "one-use-code"));
  assert.ok(requests.some((request) => request.query.get("fb_exchange_token") === "short-user-token"));
});
