import type { Request, Response } from "express";
import type { GhlOAuthPresentationService } from "@/features/ghl-oauth/presentation/services/ghl-oauth.presentation.service";

export class GhlOAuthController {
  constructor(
    private readonly service: GhlOAuthPresentationService,
  ) {}

  initiateHandler = (req: Request, res: Response): void => {
    const tenantId = typeof req.query.tenant_id === "string" ? req.query.tenant_id : undefined;
    const locationId = typeof req.query.location_id === "string" ? req.query.location_id : undefined;
    if (!tenantId && !locationId) {
      res.status(400).json({ error: "tenant_id or location_id is required for OAuth onboarding" });
      return;
    }
    void this.service.initiate({ ...(tenantId ? { tenantId } : {}), ...(locationId ? { locationId } : {}) })
      .then((result) => res.redirect(result.authorizationUrl))
      .catch((error) => {
        console.error("GHL OAuth initiation failed", error instanceof Error ? error.message : "unknown error");
        res.status(404).json({ error: "GHL location is not provisioned for OAuth" });
      });
  };

  completeHandler = async (req: Request, res: Response): Promise<void> => {
    const code = typeof req.query.code === "string" ? req.query.code : undefined;
    const state = typeof req.query.state === "string" ? req.query.state : undefined;
    const oauthError = typeof req.query.error === "string" ? req.query.error : undefined;

    if (oauthError) {
      res.status(400).json({ error: "GHL OAuth authorization was denied" });
      return;
    }
    if (!code || !state) {
      res.status(400).json({ error: "Missing OAuth code or state" });
      return;
    }

    console.log("GHL OAuth callback received");

    try {
      const result = await this.service.complete({ code, state });
      console.log(`GHL OAuth installation persisted for location ${result.locationId}`);
      res.status(200).json({
        ok: true,
        message: "GHL installation completed",
        tenant_id: result.tenantId,
        ghl_location_id: result.locationId,
      });
    } catch (error) {
      console.error("GHL OAuth callback failed", error instanceof Error ? error.message : "unknown error");
      res.status(500).json({ error: "GHL OAuth installation failed" });
    }
  };
}
