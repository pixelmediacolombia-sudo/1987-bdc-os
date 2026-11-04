import assert from "node:assert/strict";
import { test } from "node:test";
import { GhlQualificationTagProvider } from "@/features/ghl-oauth/infrastructure/ghl/ghl-qualification-tag.provider";

test("qualification handoff does not re-add an existing GHL tag", async () => {
  const calls: string[] = [];
  const provider = new GhlQualificationTagProvider({
    request: async (_tenantId: string, config: { method?: string }) => {
      calls.push(config.method ?? "");
      return { data: { tags: ["qualification_completed"] } };
    },
  } as never);

  await provider.markQualified({
    tenantId: "tenant-a",
    contactId: "contact-a",
    leadLevel: "A",
    stage: "Calificado",
    customerMessage: "Ya le paso la información al gerente.",
  });
  assert.deepEqual(calls, ["GET"]);
});

test("qualification handoff adds the tag once when GHL does not have it", async () => {
  const calls: string[] = [];
  const provider = new GhlQualificationTagProvider({
    request: async (_tenantId: string, config: { method?: string }) => {
      calls.push(config.method ?? "");
      return { data: config.method === "GET" ? { tags: [] } : {} };
    },
  } as never);

  await provider.markQualified({
    tenantId: "tenant-a",
    contactId: "contact-a",
    leadLevel: "A",
    stage: "Calificado",
    customerMessage: "Ya le paso la información al gerente.",
  });
  assert.deepEqual(calls, ["GET", "POST"]);
});
