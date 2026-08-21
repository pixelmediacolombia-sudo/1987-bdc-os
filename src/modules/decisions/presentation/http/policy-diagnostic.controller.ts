import type { Request, Response } from "express";
import type { PolicyEvaluatorPort } from "@/modules/decisions/application/policy-evaluation.service";

type DiagnosticPayload = {
  at?: string;
  message?: string;
  down_payment?: number | string;
  control_tag?: string;
};

export class PolicyDiagnosticController {
  constructor(
    private readonly evaluator: PolicyEvaluatorPort,
    private readonly diagnosticToken?: string,
  ) {}

  evaluate = async (req: Request, res: Response): Promise<void> => {
    if (!this.diagnosticToken || req.get("x-policy-diagnostic-token") !== this.diagnosticToken) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const tenantId = queryString(req, "tenant_id");
    const ghlContactId = queryString(req, "contact_id");
    if (!tenantId || !ghlContactId) {
      res.status(400).json({ error: "tenant_id and contact_id are required" });
      return;
    }

    try {
      const payload = parsePayload(queryString(req, "payload"));
      const at = payload.at ? new Date(payload.at) : undefined;
      if (payload.at && (!at || Number.isNaN(at.getTime()))) {
        res.status(400).json({ error: "payload.at must be a valid ISO timestamp" });
        return;
      }
      const downPayment = payload.down_payment === undefined
        ? undefined
        : typeof payload.down_payment === "number"
          ? payload.down_payment
          : Number(payload.down_payment.replace(/[$,\s]/g, ""));
      if (downPayment !== undefined && !Number.isFinite(downPayment)) {
        res.status(400).json({ error: "payload.down_payment must be numeric" });
        return;
      }

      const decision = await this.evaluator.evaluateForContact({
        tenantId,
        ghlContactId,
        source: "diagnostic",
        ...(at ? { now: at } : {}),
        ...(payload.message ? { inboundMessage: payload.message } : {}),
        ...(downPayment !== undefined ? { downPayment } : {}),
        ...(payload.control_tag ? { controlTag: payload.control_tag } : {}),
      });

      res.status(200).json({
        test: decision.gate === "QUIET_HOURS"
          ? "Quiet Hours Enforcement in Render Production"
          : "Policy Gate Evaluation in Render Production",
        timestamp_concesionario: decision.localTimestamp,
        allowed_actions_returned: decision.allowedActions,
        reply_blocked: decision.replyBlocked,
        selected_action: decision.selectedAction,
        reason: decision.reason,
        decision_logged_successfully: decision.decisionLoggedSuccessfully,
        rls_enforced: decision.rlsEnforced,
      });
    } catch (error) {
      res.status(422).json({ error: error instanceof Error ? error.message : "Policy evaluation failed" });
    }
  };
}

function queryString(req: Request, name: string): string | undefined {
  const value = req.query[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parsePayload(value: string | undefined): DiagnosticPayload {
  if (!value) return {};
  if (value.length > 8_192) throw new Error("payload is too large");
  const parsed: unknown = JSON.parse(value);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("payload must be a JSON object");
  }
  return parsed as DiagnosticPayload;
}
