import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import express, { type Request, type Response } from "express";
import { verifyScryptPassword } from "@/features/identity/infrastructure/crypto/scrypt-password";

const SESSION_COOKIE = "bdc_os_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const MAX_FAILED_ATTEMPTS = 10;
const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const failedAttempts = new Map<string, { count: number; resetAt: number }>();

type IdentityUser = { id: string; email: string; display_name: string; account_type: "admin" | "user" };

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

export function createIdentityRouter(pool: Pool, options: { production: boolean }): express.Router {
  const router = express.Router();

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

  return router;
}
