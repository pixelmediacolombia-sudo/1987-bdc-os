import { createHash } from "node:crypto";
import type { Pool } from "pg";

export type SemanticRepetitionValidationInput = {
  tenantId: string;
  contactId: string;
  content: string;
  externalId?: string;
  fallbackAction?: "WAIT" | "HANDOFF";
};

export type SemanticRepetitionMatch = {
  content: string;
  messageHash: string;
  similarity: number;
};

export type SemanticRepetitionValidationResult = {
  accepted: boolean;
  action: "SEND" | "WAIT" | "HANDOFF";
  candidateHash: string;
  threshold: number;
  match?: SemanticRepetitionMatch;
  reason: string;
};

export interface SemanticRepetitionGuard {
  validate(input: SemanticRepetitionValidationInput): Promise<SemanticRepetitionValidationResult>;
}

type RecentOutboundMessageRow = { content: string };
type ContactRow = { id: string };

export class SemanticRepetitionValidator implements SemanticRepetitionGuard {
  constructor(
    private readonly pool: Pool,
    private readonly options: { threshold?: number; fallbackAction?: "WAIT" | "HANDOFF" } = {},
  ) {}

  async validate(input: SemanticRepetitionValidationInput): Promise<SemanticRepetitionValidationResult> {
    const tenantId = requiredIdentifier(input.tenantId, "tenantId");
    const contactId = requiredIdentifier(input.contactId, "contactId");
    const content = requiredIdentifier(input.content, "content");
    const threshold = this.getThreshold();
    const fallbackAction = input.fallbackAction ?? this.options.fallbackAction ?? "WAIT";
    const candidateHash = hashContent(content);
    const client = await this.pool.connect();

    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
      const contact = await client.query<ContactRow>(
        `SELECT id::text AS id
           FROM public.contacts
          WHERE tenant_id = $1 AND ghl_contact_id = $2
          LIMIT 1`,
        [tenantId, contactId],
      );
      const contactRow = contact.rows[0];
      if (!contactRow) throw new Error(`Semantic repetition contact ${contactId} was not found`);
      const recent = await client.query<RecentOutboundMessageRow>(
        `SELECT m.content
           FROM public.messages AS m
           JOIN public.conversations AS cv
             ON cv.id = m.conversation_id AND cv.tenant_id = m.tenant_id
          WHERE m.tenant_id = $1
            AND cv.contact_id = $2
            AND m.direction = 'outbound'
            AND m.sender_type IN ('agent', 'assistant')
          ORDER BY m.created_at DESC, m.id DESC
          LIMIT 5`,
        [tenantId, contactRow.id],
      );

      const match = findRepeatedMessage(content, recent.rows, threshold);
      if (!match) {
        await client.query("COMMIT");
        return {
          accepted: true,
          action: "SEND",
          candidateHash,
          threshold,
          reason: "No recent outbound agent message exceeded the semantic repetition threshold",
        };
      }

      const reason = `Semantic repetition veto: similarity ${(match.similarity * 100).toFixed(1)}% exceeds threshold ${(threshold * 100).toFixed(1)}%`;
      await client.query(
        `INSERT INTO public.decision_logs
           (tenant_id, contact_id, external_id, input_version, allowed_actions, selected_action, reason, model_trace)
         VALUES ($1, $2, $3, 'semantic-repetition-v1', $4::jsonb, $5, $6, $7::jsonb)
         ON CONFLICT DO NOTHING`,
        [
          tenantId,
          contactRow.id,
          input.externalId ?? null,
          JSON.stringify(["WAIT", "HANDOFF"]),
          fallbackAction,
          reason,
          JSON.stringify({
            engine: "semantic-repetition-v1",
            candidateHash,
            matchedMessageHash: match.messageHash,
            similarity: match.similarity,
            threshold,
            fallbackAction,
            llmInvoked: false,
          }),
        ],
      );
      await client.query("COMMIT");
      return {
        accepted: false,
        action: fallbackAction,
        candidateHash,
        threshold,
        match,
        reason,
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private getThreshold(): number {
    const configured = this.options.threshold ?? readThresholdFromEnvironment();
    if (!Number.isFinite(configured) || configured < 0 || configured > 1) {
      throw new Error("SEMANTIC_SIMILARITY_THRESHOLD must be a number between 0 and 1");
    }
    return configured;
  }
}

export function hashContent(content: string): string {
  return createHash("sha256").update(normalizeText(content), "utf8").digest("hex");
}

export function normalizedTokenJaccard(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return intersection / (leftTokens.size + rightTokens.size - intersection);
}

/** Sørensen-Dice gives short wording changes more weight than set Jaccard. */
export function normalizedTokenDice(left: string, right: string): number {
  const leftTokens = new Set(tokenize(left));
  const rightTokens = new Set(tokenize(right));
  if (leftTokens.size === 0 && rightTokens.size === 0) return 1;
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  let intersection = 0;
  for (const token of leftTokens) if (rightTokens.has(token)) intersection += 1;
  return (2 * intersection) / (leftTokens.size + rightTokens.size);
}

function findRepeatedMessage(
  candidate: string,
  recent: RecentOutboundMessageRow[],
  threshold: number,
): SemanticRepetitionMatch | undefined {
  let best: SemanticRepetitionMatch | undefined;
  for (const row of recent) {
    const similarity = Math.max(
      normalizedTokenJaccard(candidate, row.content),
      normalizedTokenDice(candidate, row.content),
    );
    if (similarity < threshold || (best && similarity <= best.similarity)) continue;
    best = { content: row.content, messageHash: hashContent(row.content), similarity };
  }
  return best;
}

function readThresholdFromEnvironment(): number {
  const raw = process.env.SEMANTIC_SIMILARITY_THRESHOLD?.trim();
  if (!raw) return 0.8;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error("SEMANTIC_SIMILARITY_THRESHOLD must be a number between 0 and 1");
  return value;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function tokenize(value: string): string[] {
  const normalized = normalizeText(value);
  return normalized ? normalized.split(" ") : [];
}

function requiredIdentifier(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${name} cannot be empty`);
  return normalized;
}
