import type { Request, Response } from "express";
import type { GhlOAuthPresentationService } from "@/features/ghl-oauth/presentation/services/ghl-oauth.presentation.service";

function oauthFailureCode(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("GHL response missing")) return "ghl_token_response_invalid";
  if (message.includes("OAuth location does not match")) return "location_mismatch";
  if (message.includes("OAuth tenant was not found")) return "tenant_not_found";
  if (message.includes("pre-provisioned tenant")) return "tenant_not_bound";
  if (message.includes("GHL token exchange failed")) return "ghl_token_exchange_failed";
  if (message.includes("OAuth installation persistence failed")) return "oauth_persistence_failed";
  return "oauth_installation_failed";
}

export class GhlOAuthController {
  constructor(
    private readonly service: GhlOAuthPresentationService,
    private readonly dashboardInstallReceipt?: (code: string, redirectUri: string) => Promise<void>,
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
    // The developer-portal Marketplace link supplies code only. Accept it ONLY as
    // a narrowly verified dashboard-install receipt, never as tenant onboarding,
    // a user login, or a fallback after a failed state verification.
    if(code && req.query.state===undefined && this.dashboardInstallReceipt){
      const callbacks:Record<string,string>={
        "one987-bdc-os.onrender.com/callback":"https://one987-bdc-os.onrender.com/oauth/callback",
        "bdc.1987marketing.com/return":"https://bdc.1987marketing.com/oauth/return",
      };
      const redirectUri=callbacks[req.hostname+req.path];
      if(redirectUri){
        try{
          await this.dashboardInstallReceipt(code,redirectUri);
          res.redirect(303,"https://app.1987marketing.com/v2/location/cd9Slb2Fk2vNY3l4ukG9/dashboard/6add8337dc4b01c8b1e5bd51");
        }catch(error){
          let failureCode="provider_exchange_failed";
          if(error instanceof Error&&error.message==="Dashboard installation scope rejected")failureCode="scope_rejected";
          if(error instanceof Error&&error.message==="Dashboard installation location rejected")failureCode="location_rejected";
          // Never log Axios errors, token responses, authorization codes or credentials.
          const providerError=error as {response?:{status?:number;data?:{error?:unknown}}};
          const providerStatus=typeof providerError?.response?.status==="number"?providerError.response.status:undefined;
          const raw=providerError?.response?.data?.error;
          const providerCode=typeof raw==="string"&&["invalid_grant","invalid_client","unauthorized_client","invalid_request","invalid_scope"].includes(raw)?raw:undefined;
          const diagnostics=failureCode!=="provider_exchange_failed"&&error instanceof Error?error.cause:undefined;
          console.warn("GHL dashboard installation receipt rejected",{failureCode,providerStatus,providerCode,diagnostics});
          res.status(403).json({error:"Dashboard installation could not be verified. Select only Lucki Mazda and the users.readonly permission.",error_code:failureCode,...(providerStatus?{provider_status:providerStatus}:{})});
        }
        return;
      }
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
      const failureCode = oauthFailureCode(error);
      console.error("GHL OAuth callback failed", failureCode);
      res.status(500).json({ error: "GHL OAuth installation failed", error_code: failureCode });
    }
  };
}
