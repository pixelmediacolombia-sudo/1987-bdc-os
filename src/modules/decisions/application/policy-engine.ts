import type { NextBestAction } from "@/modules/decisions/domain/next-best-action";
import {
  ALL_NEXT_BEST_ACTIONS,
  FINANCIAL_BOUNDARY_ACTIONS,
  QUIET_HOURS_ACTIONS,
} from "@/modules/decisions/domain/next-best-action";
import type { PolicyContext } from "@/modules/decisions/domain/policy-context";

export type PolicyEvaluationOverrides = {
  now?: Date;
  controlTag?: string;
  inboundMessage?: string;
  downPayment?: number;
  requestedAction?: NextBestAction;
  objectiveType?: string;
};

export type PolicyDecision = {
  allowedActions: NextBestAction[];
  selectedAction: NextBestAction | null;
  reason: string;
  localTimestamp: string;
  replyBlocked: boolean;
  gate: "COMPLIANCE" | "QUIET_HOURS" | "FINANCIAL" | "PASSED";
  constraints?: {
    replyDisclaimer?: {
      code: string;
      text: string;
    };
  };
};

const OPT_OUT_PATTERN = /\b(?:STOP|SALIR|CANCELAR)\b/i;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export class PolicyEngine {
  evaluate(context: PolicyContext, overrides: PolicyEvaluationOverrides = {}): PolicyDecision {
    const now = overrides.now ?? new Date();
    if (Number.isNaN(now.getTime())) throw new Error("Policy evaluation date is invalid");

    const localTimestamp = formatLocalTimestamp(now, context.tenant.timezone);
    const controlTag = overrides.controlTag?.trim().toLowerCase();
    const lastInboundMessage = overrides.inboundMessage ?? context.lastInboundMessage;

    if (controlTag === "stop_ai") {
      return this.stopDecision(localTimestamp, "AI stopped: Compliance Tag 'stop_ai' detected in GHL");
    }
    if (["denied", "revoked"].includes(context.contact.consentState.trim().toLowerCase())) {
      return this.stopDecision(localTimestamp, `AI stopped: consent_state=${context.contact.consentState}`);
    }
    if (lastInboundMessage && OPT_OUT_PATTERN.test(lastInboundMessage)) {
      return this.stopDecision(localTimestamp, "AI stopped: opt-out keyword detected in latest inbound message");
    }

    if (isQuietHours(now, context.tenant.timezone, context.tenant.policies.quietHours)) {
      const financial = this.financialBoundary(context, overrides);
      if (financial) {
        return {
          ...financial,
          allowedActions: ["HANDOFF"],
          reason: `${financial.reason}; quiet hours also block REPLY`,
          localTimestamp,
          replyBlocked: true,
          gate: "QUIET_HOURS",
        };
      }
      return {
        allowedActions: [...QUIET_HOURS_ACTIONS],
        selectedAction: null,
        reason: "Quiet hours active: REPLY is blocked until the next commercial window",
        localTimestamp,
        replyBlocked: true,
        gate: "QUIET_HOURS",
      };
    }

    const financial = this.financialBoundary(context, overrides);
    if (financial) return { ...financial, localTimestamp, replyBlocked: true, gate: "FINANCIAL" };

    return {
      allowedActions: [...ALL_NEXT_BEST_ACTIONS],
      selectedAction: null,
      reason: "All deterministic policy gates passed",
      localTimestamp,
      replyBlocked: false,
      gate: "PASSED",
    };
  }

  private stopDecision(localTimestamp: string, reason: string): PolicyDecision {
    return {
      allowedActions: ["STOP"],
      selectedAction: "STOP",
      reason,
      localTimestamp,
      replyBlocked: true,
      gate: "COMPLIANCE",
    };
  }

  private financialBoundary(
    context: PolicyContext,
    overrides: PolicyEvaluationOverrides,
  ): Omit<PolicyDecision, "localTimestamp" | "replyBlocked" | "gate"> | undefined {
    const payment = overrides.downPayment ?? readDownPayment(context.activeFacts);
    const minimum = context.tenant.policies.downPayment.min;
    const isZero = payment === 0;
    const isBelowApprovedBand = payment !== undefined && minimum !== null && payment < minimum;
    if (!isZero && !isBelowApprovedBand) return undefined;

    return {
      allowedActions: [...FINANCIAL_BOUNDARY_ACTIONS],
      selectedAction: null,
      reason: isZero
        ? "Financial boundary: down payment is 0; REPLY requires the approved disclaimer"
        : `Financial boundary: down payment is below the approved minimum of ${minimum}`,
      constraints: {
        replyDisclaimer: context.tenant.policies.financialBoundaries?.disclaimer ?? {
          code: "FINANCING_REVIEW_REQUIRED",
          text: "Financing terms are subject to dealer review and lender approval.",
        },
      },
    };
  }
}

function readDownPayment(facts: Record<string, string>): number | undefined {
  const raw = facts.down_payment ?? facts.downPayment ?? facts["DOWN_PAYMENT"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const normalized = raw.replace(/[$,\s]/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}

function isQuietHours(
  date: Date,
  timezone: string,
  quietHours: { enabled: boolean; start: string | null; end: string | null },
): boolean {
  if (!quietHours.enabled || !quietHours.start || !quietHours.end) return false;
  if (!TIME_PATTERN.test(quietHours.start) || !TIME_PATTERN.test(quietHours.end)) {
    throw new Error("Quiet hours must use HH:mm values");
  }
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  const currentMinutes = toMinutes(local);
  const startMinutes = toMinutes(quietHours.start);
  const endMinutes = toMinutes(quietHours.end);
  if (startMinutes === endMinutes) return true;
  return startMinutes < endMinutes
    ? currentMinutes >= startMinutes && currentMinutes < endMinutes
    : currentMinutes >= startMinutes || currentMinutes < endMinutes;
}

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map(Number);
  return hours * 60 + minutes;
}

function formatLocalTimestamp(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZoneName: "longOffset",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const offset = normalizeOffset(values.timeZoneName ?? "GMT");
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}${offset}`;
}

function normalizeOffset(value: string): string {
  if (value === "GMT") return "+00:00";
  const match = /^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/.exec(value);
  if (!match) throw new Error(`Unsupported timezone offset ${value}`);
  return `${match[1]}${match[2].padStart(2, "0")}:${match[3] ?? "00"}`;
}
