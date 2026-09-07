import type {
  ConversationalModelDraftInput,
  ConversationalModelExtraction,
  ConversationalModelExtractionInput,
  ConversationalModelPort,
  ConversationalModelUsage,
} from "@/modules/control/application/conversation-ai-model-contract";

type ChatCompletionResponse = {
  choices?: Array<{ message?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
};

/** OpenAI-compatible adapter; provider and model remain runtime configuration. */
export class OpenAICompatibleConversationalModel implements ConversationalModelPort {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    public readonly extractionModel: string,
    public readonly draftingModel: string,
    private readonly timeoutMs = 20_000,
  ) {
    if (!baseUrl.trim() || !apiKey.trim()) throw new Error("Conversational model adapter requires base URL and API key");
    if (!extractionModel.trim() || !draftingModel.trim()) throw new Error("Conversational model adapter requires extraction and drafting models");
  }

  async extract(input: ConversationalModelExtractionInput): Promise<{ value: ConversationalModelExtraction; usage?: ConversationalModelUsage }> {
    const response = await this.complete(this.extractionModel, [
      {
        role: "system",
        content: [
          "You are the extraction component of a dealership qualification assistant.",
          "Return JSON only with exactly: facts, intent, missingFields.",
          "Extract only facts explicitly present in the customer message; do not infer approval, price, inventory, lead level, or a next action.",
          "Use null or omit fields that are not explicit. Facts are advisory and code validates them.",
        ].join(" "),
      },
      { role: "user", content: JSON.stringify(input) },
    ], true);
    const parsed = parseObject(response.content);
    return {
      value: {
        facts: isObject(parsed.facts) ? parsed.facts as ConversationalModelExtraction["facts"] : {},
        intent: typeof parsed.intent === "string" ? parsed.intent.slice(0, 120) : "unknown",
        missingFields: Array.isArray(parsed.missingFields) ? parsed.missingFields.filter((value): value is string => typeof value === "string").slice(0, 20) : [],
      },
      ...(response.usage ? { usage: response.usage } : {}),
    };
  }

  async draft(input: ConversationalModelDraftInput): Promise<{ value: string; usage?: ConversationalModelUsage }> {
    const response = await this.complete(this.draftingModel, [
      {
        role: "system",
        content: [
          "You write one short Spanish or English dealership qualification reply as Sofía.",
          "The supplied resolvedFacts, pendingObjectives, requiredAction, requiredQuestion, deterministicResponse, and recentOutboundResponses are authoritative.",
          "The Question Ledger and deterministic rules already decided what happens next. You must not choose a different question, action, lead level, or handoff state.",
          "If requiredAction is ask, ask only requiredQuestion, rephrasing it briefly if needed. If requiredAction is handoff or follow_up, do not ask a question. If the instruction is unclear, return deterministicResponse exactly.",
          "Acknowledge the customer before asking at most one question. Match the customer's length and use their own vehicle wording when available.",
          "Do not reuse recentOutboundResponses or any question already answered by resolvedFacts.",
          "Never invent numbers, prices, down payments, monthly payments, URLs, inventory availability, approval promises, appointments, calls, or alternative vehicles.",
          "Do not decide qualification or what to send. Follow the supplied deterministicResponse and required action; if uncertain, reproduce the deterministicResponse exactly.",
          "Return plain text only, with no labels or analysis.",
        ].join(" "),
      },
      { role: "user", content: JSON.stringify(input) },
    ], false);
    return { value: response.content.trim(), ...(response.usage ? { usage: response.usage } : {}) };
  }

  private async complete(model: string, messages: Array<{ role: "system" | "user"; content: string }>, jsonMode: boolean): Promise<{ content: string; usage?: ConversationalModelUsage }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Conversational model request failed with status ${response.status}`);
      const data = await response.json() as ChatCompletionResponse;
      const content = extractContent(data.choices?.[0]?.message?.content);
      if (!content) throw new Error("Conversational model returned empty content");
      return { content, ...(data.usage ? { usage: usageFromResponse(data.usage) } : {}) };
    } finally {
      clearTimeout(timeout);
    }
  }
}

function extractContent(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const text = value.map((part) => isObject(part) && typeof part.text === "string" ? part.text : "").join("").trim();
  return text || undefined;
}

function parseObject(value: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(value);
  if (!isObject(parsed)) throw new Error("Conversational model extraction was not a JSON object");
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function usageFromResponse(usage: { prompt_tokens?: unknown; completion_tokens?: unknown }): ConversationalModelUsage {
  return {
    ...(typeof usage.prompt_tokens === "number" ? { inputTokens: usage.prompt_tokens } : {}),
    ...(typeof usage.completion_tokens === "number" ? { outputTokens: usage.completion_tokens } : {}),
  };
}
