import nodemailer from "nodemailer";

export type DealerInvitationEmail = {
  to: string;
  displayName: string;
  dealerName: string;
  invitationUrl: string;
  expiresInHours: number;
};

export interface DealerInvitationMailer {
  send(input: DealerInvitationEmail): Promise<void>;
}

export type SmtpInvitationEnvironment = {
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM_EMAIL?: string;
  SMTP_FROM_NAME?: string;
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]!);
}

export function createSmtpDealerInvitationMailer(
  environment: SmtpInvitationEnvironment = process.env,
): DealerInvitationMailer | undefined {
  if (!environment.SMTP_HOST?.trim()) return undefined;
  const fromEmail = environment.SMTP_FROM_EMAIL?.trim();
  if (!fromEmail) throw new Error("SMTP_FROM_EMAIL is required when SMTP_HOST is configured");

  const port = Number(environment.SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT must be a valid TCP port");
  const username = environment.SMTP_USER?.trim();
  const password = environment.SMTP_PASSWORD;
  if (Boolean(username) !== Boolean(password)) throw new Error("SMTP_USER and SMTP_PASSWORD must both be configured or both be empty");
  const transporter = nodemailer.createTransport({
    host: environment.SMTP_HOST.trim(),
    port,
    secure: environment.SMTP_SECURE?.trim().toLowerCase() === "true",
    ...(username && password ? { auth: { user: username, pass: password } } : {}),
  });
  const fromName = environment.SMTP_FROM_NAME?.trim() || "BDC OS";

  return {
    async send(input) {
      const dealerName = escapeHtml(input.dealerName);
      const displayName = escapeHtml(input.displayName);
      const safeUrl = escapeHtml(input.invitationUrl);
      await transporter.sendMail({
        from: { name: fromName, address: fromEmail },
        to: input.to,
        subject: `Invitación para acceder a ${input.dealerName} en BDC OS`,
        text: `Hola ${input.displayName},\n\n${input.dealerName} te invitó a BDC OS. Define tu contraseña personal desde este enlace: ${input.invitationUrl}\n\nEl enlace vence en ${input.expiresInHours} horas y solo se puede usar una vez. Si no esperabas esta invitación, ignora este correo.`,
        html: `<!doctype html><html lang="es"><meta charset="utf-8"><body style="margin:0;background:#f5f5f3;color:#191919;font:16px Arial,sans-serif"><main style="max-width:520px;margin:40px auto;padding:32px;background:#fff;border:1px solid #e4e3df;border-radius:14px"><p style="font-size:12px;font-weight:bold;letter-spacing:2px">BDC OS</p><h1 style="font-size:25px">Activa tu acceso</h1><p>Hola ${displayName},</p><p><strong>${dealerName}</strong> te invitó a usar BDC OS. Crea una contraseña personal para completar la configuración de tu cuenta.</p><p style="margin:28px 0"><a href="${safeUrl}" style="display:inline-block;padding:13px 18px;background:#171717;color:#fff;text-decoration:none;border-radius:7px;font-weight:bold">Definir contraseña</a></p><p style="font-size:13px;color:#6c6c66">Este enlace es de un solo uso y vence en ${input.expiresInHours} horas. Si no esperabas esta invitación, puedes ignorar este correo.</p></main></body></html>`,
      });
    },
  };
}
