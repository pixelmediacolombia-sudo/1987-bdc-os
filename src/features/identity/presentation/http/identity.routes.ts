import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import express, { type Request, type Response } from "express";
import { hashScryptPassword, verifyScryptPassword } from "@/features/identity/infrastructure/crypto/scrypt-password";
import type { DealerInvitationMailer } from "@/features/identity/infrastructure/email/smtp-dealer-invitation-mailer";

const SESSION_COOKIE = "bdc_os_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_FAILED_ATTEMPTS = 10;
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const failedAttempts = new Map<string, { count: number; resetAt: number }>();

type IdentityUser = { id: string; email: string; display_name: string; account_type: "admin" | "user" };
type Invitation = { id: string; tenant_id: string; email: string; display_name: string; dealer_name: string };
const INVITATION_TTL_HOURS = 72;

function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function invitationUrl(publicAppUrl: string, token: string): string {
  const origin = new URL(publicAppUrl);
  if (origin.protocol !== "https:" && origin.hostname !== "localhost" && origin.hostname !== "127.0.0.1") {
    throw new Error("BDC_APP_URL must use HTTPS outside localhost");
  }
  const url = new URL("/auth/invitations/accept", origin);
  url.searchParams.set("token", token);
  return url.toString();
}

async function requireAdmin(pool: Pool, request: Request, response: Response): Promise<IdentityUser | undefined> {
  const user = await activeSession(pool, request);
  if (!user) {
    response.status(401).json({ error: "Inicia sesión para continuar." });
    return undefined;
  }
  if (user.account_type !== "admin") {
    response.status(403).json({ error: "Esta acción requiere una cuenta administradora." });
    return undefined;
  }
  return user;
}

function cookieValue(request: Request): string | undefined {
  const cookieHeader = request.headers.cookie ?? "";
  const part = cookieHeader.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${SESSION_COOKIE}=`));
  return part ? decodeURIComponent(part.slice(SESSION_COOKIE.length + 1)) : undefined;
}

function sessionCookie(token: string | undefined, production: boolean): string {
  const secure = production ? "; Secure" : "";
  return token
    ? `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure}`
    : `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function failureKey(request: Request, email: string): string {
  return `${request.ip ?? request.socket.remoteAddress ?? "unknown"}:${email}`;
}

function rateLimited(request: Request, email: string): boolean {
  const current = failedAttempts.get(failureKey(request, email));
  if (!current) return false;
  if (current.resetAt <= Date.now()) {
    failedAttempts.delete(failureKey(request, email));
    return false;
  }
  return current.count >= MAX_FAILED_ATTEMPTS;
}

function recordFailure(request: Request, email: string): void {
  const key = failureKey(request, email);
  const current = failedAttempts.get(key);
  if (!current || current.resetAt <= Date.now()) {
    failedAttempts.set(key, { count: 1, resetAt: Date.now() + FAILED_ATTEMPT_WINDOW_MS });
    return;
  }
  current.count += 1;
}

async function activeSession(pool: Pool, request: Request): Promise<IdentityUser | undefined> {
  const token = cookieValue(request);
  if (!token || token.length > 256) return undefined;
  const result = await pool.query<IdentityUser>(
    `SELECT u.id::text, u.email, u.display_name, u.account_type
       FROM public.app_sessions AS s
       JOIN public.app_users AS u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND s.revoked_at IS NULL
        AND s.expires_at > now()
        AND u.status = 'active'
      LIMIT 1`,
    [tokenDigest(token)],
  );
  return result.rows[0];
}

export function createIdentityRouter(pool: Pool, options: { production: boolean; publicAppUrl?: string; invitationMailer?: DealerInvitationMailer }): express.Router {
  const router = express.Router();
  const publicAppUrl = options.publicAppUrl ?? (options.production ? undefined : "http://localhost:3000");

  router.post("/login", async (request: Request, response: Response) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!email || !password || email.length > 254 || password.length > 1024) {
      response.status(400).json({ error: "Ingresa un correo y una contraseña válidos." });
      return;
    }
    if (rateLimited(request, email)) {
      response.status(429).json({ error: "Demasiados intentos. Espera unos minutos y vuelve a probar." });
      return;
    }

    try {
      const result = await pool.query<IdentityUser & { password_hash: string | null; status: string }>(
        `SELECT id::text, email, display_name, account_type, password_hash, status
           FROM public.app_users
          WHERE lower(email) = $1
          LIMIT 1`,
        [email],
      );
      const user = result.rows[0];
      const passwordMatches = user?.status === "active" && user.password_hash
        ? await verifyScryptPassword(password, user.password_hash)
        : false;
      if (!user || !passwordMatches) {
        recordFailure(request, email);
        response.status(401).json({ error: "Correo o contraseña incorrectos." });
        return;
      }

      failedAttempts.delete(failureKey(request, email));
      const token = randomBytes(32).toString("base64url");
      await pool.query(
        `INSERT INTO public.app_sessions (user_id, token_hash, expires_at)
         VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
        [user.id, tokenDigest(token), SESSION_TTL_SECONDS],
      );
      response.setHeader("Set-Cookie", sessionCookie(token, options.production));
      response.status(200).json({
        authenticated: true,
        user: { id: user.id, email: user.email, displayName: user.display_name, accountType: user.account_type },
      });
    } catch {
      response.status(500).json({ error: "No pudimos iniciar sesión. Inténtalo de nuevo." });
    }
  });

  router.get("/session", async (request: Request, response: Response) => {
    try {
      const user = await activeSession(pool, request);
      if (!user) {
        response.setHeader("Set-Cookie", sessionCookie(undefined, options.production));
        response.status(401).json({ authenticated: false });
        return;
      }
      response.status(200).json({
        authenticated: true,
        user: { id: user.id, email: user.email, displayName: user.display_name, accountType: user.account_type },
      });
    } catch {
      response.status(500).json({ error: "No pudimos verificar la sesión." });
    }
  });

  router.post("/logout", async (request: Request, response: Response) => {
    const token = cookieValue(request);
    try {
      if (token && token.length <= 256) {
        await pool.query(
          "UPDATE public.app_sessions SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL",
          [tokenDigest(token)],
        );
      }
      response.setHeader("Set-Cookie", sessionCookie(undefined, options.production));
      response.status(200).json({ authenticated: false });
    } catch {
      response.status(500).json({ error: "No pudimos cerrar la sesión." });
    }
  });

  router.get("/admin/dealers", async (request: Request, response: Response) => {
    try {
      if (!await requireAdmin(pool, request, response)) return;
      const result = await pool.query(
        `SELECT t.dealer_id::text AS id, t.dealer_name AS name, t.status,
                COUNT(DISTINCT m.user_id)::int AS user_count,
                COUNT(DISTINCT i.id) FILTER (
                  WHERE i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
                )::int AS pending_invitation_count
           FROM public.tenants AS t
           LEFT JOIN public.user_tenant_memberships AS m ON m.tenant_id = t.dealer_id
           LEFT JOIN public.dealer_invitations AS i ON i.tenant_id = t.dealer_id
          GROUP BY t.dealer_id
          ORDER BY lower(COALESCE(t.dealer_name, ''))`,
      );
      response.status(200).json({ dealers: result.rows });
    } catch {
      response.status(500).json({ error: "No pudimos cargar los dealers." });
    }
  });

  router.post("/admin/dealers", async (request: Request, response: Response) => {
    const dealerName = typeof request.body?.dealerName === "string" ? request.body.dealerName.trim() : "";
    const ownerName = typeof request.body?.ownerName === "string" ? request.body.ownerName.trim() : "";
    const email = typeof request.body?.ownerEmail === "string" ? request.body.ownerEmail.trim().toLowerCase() : "";
    if (!dealerName || dealerName.length > 160 || !ownerName || ownerName.length > 160 || !validEmail(email)) {
      response.status(400).json({ error: "Ingresa el nombre del dealer, el nombre del responsable y un correo válido." });
      return;
    }

    const admin = await requireAdmin(pool, request, response).catch(() => undefined);
    if (!admin) {
      if (!response.headersSent) response.status(500).json({ error: "No pudimos verificar la sesión." });
      return;
    }
    if (!publicAppUrl) {
      response.status(503).json({ error: "Configura BDC_APP_URL antes de emitir invitaciones." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query<{ account_type: string; status: string }>(
        "SELECT account_type, status FROM public.app_users WHERE lower(email) = $1 LIMIT 1",
        [email],
      );
      if (existing.rows[0]) {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "Ese correo ya tiene una cuenta. Invítalo desde el dealer correspondiente." });
        return;
      }
      const tenant = await client.query<{ id: string }>(
        `INSERT INTO public.tenants
           (dealer_id, ghl_location_id, dealer_name, timezone, policy_version, status,
            sofia_enabled, qualification_flow_enabled, qualification_signal_enabled)
         VALUES (gen_random_uuid(), NULL, $1, 'America/Bogota', 'pending_dealer_setup', 'active', false, false, false)
         RETURNING dealer_id::text AS id`,
        [dealerName],
      );
      const dealerId = tenant.rows[0]?.id;
      if (!dealerId) throw new Error("Tenant insert did not return an id");
      const rawToken = randomBytes(32).toString("base64url");
      await client.query(
        `INSERT INTO public.dealer_invitations
           (tenant_id, email, display_name, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 hour'))`,
        [dealerId, email, ownerName, tokenDigest(rawToken), admin.id, INVITATION_TTL_HOURS],
      );
      await client.query("COMMIT");
      const url = invitationUrl(publicAppUrl, rawToken);
      let delivery: "sent" | "manual" | "failed" = "manual";
      if (options.invitationMailer) {
        try {
          await options.invitationMailer.send({ to: email, displayName: ownerName, dealerName, invitationUrl: url, expiresInHours: INVITATION_TTL_HOURS });
          delivery = "sent";
        } catch {
          delivery = "failed";
        }
      }
      response.status(201).json({
        dealer: { id: dealerId, name: dealerName, status: "onboarding" },
        invitation: { email, expiresInHours: INVITATION_TTL_HOURS, delivery, ...(delivery === "sent" ? {} : { url }) },
      });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      response.status(500).json({ error: "No pudimos crear el dealer y su invitación." });
    } finally {
      client.release();
    }
  });

  router.post("/admin/dealers/:dealerId/invitations", async (request: Request, response: Response) => {
    const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
    const displayName = typeof request.body?.displayName === "string" ? request.body.displayName.trim() : "";
    if (!validEmail(email) || !displayName || displayName.length > 160) {
      response.status(400).json({ error: "Ingresa el nombre del usuario y un correo válido." });
      return;
    }
    let admin: IdentityUser | undefined;
    try {
      admin = await requireAdmin(pool, request, response);
    } catch {
      response.status(500).json({ error: "No pudimos verificar la sesión." });
      return;
    }
    if (!admin) return;
    if (!publicAppUrl) {
      response.status(503).json({ error: "Configura BDC_APP_URL antes de emitir invitaciones." });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const tenant = await client.query<{ id: string; dealer_name: string | null }>(
        "SELECT dealer_id::text AS id, dealer_name FROM public.tenants WHERE dealer_id = $1 FOR UPDATE",
        [request.params.dealerId],
      );
      if (!tenant.rows[0]) {
        await client.query("ROLLBACK");
        response.status(404).json({ error: "No encontramos ese dealer." });
        return;
      }
      const existing = await client.query<{ account_type: string; status: string }>(
        "SELECT account_type, status FROM public.app_users WHERE lower(email) = $1 LIMIT 1",
        [email],
      );
      if (existing.rows[0]?.account_type === "admin") {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "No se puede invitar una cuenta administradora como usuario de dealer." });
        return;
      }
      if (existing.rows[0]?.status === "disabled") {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "La cuenta está deshabilitada y requiere asistencia del administrador." });
        return;
      }
      const prior = await client.query(
        `UPDATE public.dealer_invitations SET revoked_at = now()
          WHERE tenant_id = $1 AND lower(email) = $2 AND accepted_at IS NULL AND revoked_at IS NULL`,
        [tenant.rows[0].id, email],
      );
      void prior;
      const rawToken = randomBytes(32).toString("base64url");
      await client.query(
        `INSERT INTO public.dealer_invitations
           (tenant_id, email, display_name, token_hash, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 hour'))`,
        [tenant.rows[0].id, email, displayName, tokenDigest(rawToken), admin.id, INVITATION_TTL_HOURS],
      );
      await client.query("COMMIT");
      const url = invitationUrl(publicAppUrl, rawToken);
      let delivery: "sent" | "manual" | "failed" = "manual";
      if (options.invitationMailer) {
        try {
          await options.invitationMailer.send({ to: email, displayName, dealerName: tenant.rows[0].dealer_name ?? "tu dealer", invitationUrl: url, expiresInHours: INVITATION_TTL_HOURS });
          delivery = "sent";
        } catch {
          delivery = "failed";
        }
      }
      response.status(201).json({ invitation: { email, expiresInHours: INVITATION_TTL_HOURS, delivery, ...(delivery === "sent" ? {} : { url }) } });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      response.status(500).json({ error: "No pudimos emitir la invitación." });
    } finally {
      client.release();
    }
  });

  router.get("/invitations/accept", async (request: Request, response: Response) => {
    const token = typeof request.query.token === "string" ? request.query.token : "";
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) {
      response.status(400).type("text/plain").send("El enlace de invitación no es válido.");
      return;
    }
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    response.status(200).type("html").send(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Activar cuenta | BDC OS</title><style>body{font:16px system-ui,sans-serif;background:#f5f5f3;color:#191919;margin:0;min-height:100vh;display:grid;place-items:center}.card{box-sizing:border-box;background:white;width:min(440px,calc(100% - 32px));padding:32px;border:1px solid #e4e3df;border-radius:16px}h1{font-size:26px;margin:0 0 8px}p{color:#666;line-height:1.5}label{display:block;font-size:14px;margin:20px 0 6px}input{box-sizing:border-box;width:100%;padding:13px;border:1px solid #d7d6d1;border-radius:8px;font:inherit}button{width:100%;margin-top:22px;padding:14px;background:#171717;color:white;border:0;border-radius:8px;font:600 15px system-ui;cursor:pointer}#message{min-height:24px;color:#9b3e26;font-size:14px}</style><main class="card"><h1>Activa tu cuenta</h1><p>Define una contraseña personal para acceder a BDC OS. Usa al menos 12 caracteres.</p><form id="accept"><label for="password">Contraseña</label><input id="password" name="password" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required><label for="confirm">Confirma la contraseña</label><input id="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="1024" required><button>Crear cuenta</button><p id="message" role="status"></p></form></main><script>const token=${JSON.stringify(token)};document.getElementById('accept').addEventListener('submit',async event=>{event.preventDefault();const password=document.getElementById('password').value;const confirm=document.getElementById('confirm').value;const message=document.getElementById('message');if(password!==confirm){message.textContent='Las contraseñas no coinciden.';return}message.textContent='Activando cuenta…';try{const response=await fetch('/auth/invitations/accept',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token,password})});const data=await response.json();message.textContent=response.ok?(data.existingAccount?'Dealer vinculado. Inicia sesión con tu contraseña habitual.':'Cuenta activada. Ya puedes iniciar sesión.'):(data.error||'No se pudo activar la cuenta.')}catch{message.textContent='No pudimos conectar con BDC OS.'}});</script></html>`);
  });

  router.post("/invitations/accept", async (request: Request, response: Response) => {
    const token = typeof request.body?.token === "string" ? request.body.token : "";
    const password = typeof request.body?.password === "string" ? request.body.password : "";
    if (!/^[A-Za-z0-9_-]{40,64}$/.test(token) || password.length < 12 || password.length > 1024) {
      response.status(400).json({ error: "El enlace o la contraseña no son válidos. Usa al menos 12 caracteres." });
      return;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const invitation = await client.query<Invitation>(
        `SELECT i.id::text, i.tenant_id::text, i.email, i.display_name, t.dealer_name
           FROM public.dealer_invitations AS i
           JOIN public.tenants AS t ON t.dealer_id = i.tenant_id
          WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()
          FOR UPDATE OF i`,
        [tokenDigest(token)],
      );
      const invite = invitation.rows[0];
      if (!invite) {
        await client.query("ROLLBACK");
        response.status(400).json({ error: "La invitación venció, ya se utilizó o fue revocada. Solicita otra al administrador." });
        return;
      }
      const account = await client.query<{ id: string; account_type: string; status: string }>(
        "SELECT id::text, account_type, status FROM public.app_users WHERE lower(email) = $1 FOR UPDATE",
        [invite.email.toLowerCase()],
      );
      if (account.rows[0]?.account_type === "admin" || account.rows[0]?.status === "disabled") {
        await client.query("ROLLBACK");
        response.status(409).json({ error: "Esta cuenta requiere asistencia del administrador." });
        return;
      }
      let userId = account.rows[0]?.id;
      const existingAccount = Boolean(userId);
      if (!userId) {
        const passwordHash = await hashScryptPassword(password);
        const created = await client.query<{ id: string }>(
          `INSERT INTO public.app_users (email, display_name, password_hash, account_type, status)
           VALUES ($1, $2, $3, 'user', 'active') RETURNING id::text AS id`,
          [invite.email.toLowerCase(), invite.display_name, passwordHash],
        );
        userId = created.rows[0]?.id;
        if (!userId) throw new Error("User insert did not return an id");
      }
      await client.query(
        "INSERT INTO public.user_tenant_memberships (user_id, tenant_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [userId, invite.tenant_id],
      );
      await client.query("UPDATE public.dealer_invitations SET accepted_at = now() WHERE id = $1", [invite.id]);
      await client.query("COMMIT");
      response.status(200).json({ activated: true, existingAccount, dealerName: invite.dealer_name });
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      response.status(500).json({ error: "No pudimos activar la cuenta." });
    } finally {
      client.release();
    }
  });

  return router;
}
