import type {
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
          "You are the language understanding and extraction component of a dealership qualification assistant.",
          "Return JSON only with exactly: facts, intent, missingFields.",
          "Extract facts explicitly present in the latest customer message, including facts embedded in combined sentences and facts sent before the question was asked.",
          "Return only facts newly stated or corrected in the latest customer message; do not echo unchanged values from knownFacts.",
          "Normalize common loose spelling and dealership shorthand: corrola/tayota -> Corolla/Toyota, enganshe -> enganche, troca -> work truck category, down/de enganche -> down_payment_declared.",
          "Convert Spanish number words and mixed language amounts to canonical numbers: quinientos=500, mil quinientos=1500, dos mil=2000. Prefer the latest value when the customer corrects a previous amount, for example 'dije 1500, mejor 2000'.",
          "Understand negations and corrections: 'no tengo talones pero sí carta del trabajo' means has_income_proof=true; never overwrite a fact with an inference.",
          "Use only these fact names: contact_name, vehicle_category, vehicle_model_interest, vehicle_year, down_payment_declared, has_trade_in, first_time_buyer, purchase_timeline, has_income_proof, contact_value, employment_months, trade_in_description, trade_in_model, trade_in_year, trade_in_financed, has_co_signer, vehicle_use. Use down_payment_declared, never 'enganche' or 'down_payment'.",
          "Do not infer approval, price, inventory, lead level, or a next action.",
          "Facts are advisory and code validates them. Return canonical values, omit unknown fields, and never return prose outside the JSON object.",
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
