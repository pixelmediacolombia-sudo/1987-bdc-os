export type ContactInput = {
  displayName?: string | null;
  phone?: string | null;
  email?: string | null;
  preferredLanguage?: string | null;
};

const PHONE = /^\+?[0-9().\-\s]{7,40}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function optionalText(value: unknown, maximum: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (text.length > maximum) return undefined;
  return text || null;
}

export function parseContactInput(body: unknown): { value?: ContactInput; error?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Revisa los datos del contacto." };
  const input = body as Record<string, unknown>;
  const value: ContactInput = {};
  if (Object.hasOwn(input, "displayName")) {
    const name = optionalText(input.displayName, 120);
    if (name === undefined || (typeof input.displayName === "string" && input.displayName.trim().length > 120)) return { error: "El nombre debe tener hasta 120 caracteres." };
    value.displayName = name;
  }
  if (Object.hasOwn(input, "phone")) {
    const phone = optionalText(input.phone, 40);
    if (phone === undefined || (phone && !PHONE.test(phone))) return { error: "Escribe un teléfono válido." };
    value.phone = phone;
  }
  if (Object.hasOwn(input, "email")) {
    const email = optionalText(input.email, 254);
    if (email === undefined || (email && !EMAIL.test(email))) return { error: "Escribe un correo válido." };
    value.email = email?.toLowerCase() ?? null;
  }
  if (Object.hasOwn(input, "preferredLanguage")) {
    const language = optionalText(input.preferredLanguage, 16);
    if (language === undefined || (language && language !== "unknown" && !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language))) return { error: "Selecciona un idioma válido." };
    value.preferredLanguage = language?.toLowerCase() ?? null;
  }
  return { value };
}

export function hasReachableAddress(contact: Pick<ContactInput, "phone" | "email">): boolean {
  return Boolean(contact.phone || contact.email);
}
