export type CountryClubFollowUpAttempt = 1 | 2 | 3;
export type CountryClubLanguage = "es" | "en";

export const COUNTRY_CLUB_FOLLOW_UP_SCHEDULE: ReadonlyArray<{
  attempt: CountryClubFollowUpAttempt;
  delayMs: number;
}> = [
  { attempt: 1, delayMs: 2 * 60 * 60 * 1000 },
  { attempt: 2, delayMs: 24 * 60 * 60 * 1000 },
  { attempt: 3, delayMs: 3 * 24 * 60 * 60 * 1000 },
];

export function buildCountryClubFollowUp(input: {
  attempt: CountryClubFollowUpAttempt;
  pendingQuestion?: string;
  language: CountryClubLanguage;
}): string {
  if (input.attempt === 3) {
    return input.language === "en"
      ? "We are here whenever you are ready - happy to help when the time is right."
      : "Cualquier cosa aquí estamos, con mucho gusto le ayudamos cuando esté listo.";
  }
  const pendingQuestion = input.pendingQuestion?.trim();
  if (!pendingQuestion) throw new Error("A pending question is required before the third follow-up");
  return input.language === "en"
    ? `Just following up on this: ${pendingQuestion}`
    : `Solo doy seguimiento a esto: ${pendingQuestion}`;
}

export function canSendCountryClubFollowUp(attempt: number): attempt is CountryClubFollowUpAttempt {
  return Number.isInteger(attempt) && attempt >= 1 && attempt <= 3;
}
