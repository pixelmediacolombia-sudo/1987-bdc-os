export type SharedDealerFollowUpAttempt = 1 | 2 | 3;
export type SharedDealerLanguage = "es" | "en";

export const SHARED_DEALER_FOLLOW_UP_SCHEDULE: ReadonlyArray<{
  attempt: SharedDealerFollowUpAttempt;
  delayMs: number;
}> = [
  { attempt: 1, delayMs: 2 * 60 * 60 * 1000 },
  { attempt: 2, delayMs: 24 * 60 * 60 * 1000 },
  { attempt: 3, delayMs: 3 * 24 * 60 * 60 * 1000 },
];

export function buildSharedDealerFollowUp(input: {
  attempt: SharedDealerFollowUpAttempt;
  pendingQuestion?: string;
  language: SharedDealerLanguage;
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

export function canSendSharedDealerFollowUp(attempt: number): attempt is SharedDealerFollowUpAttempt {
  return Number.isInteger(attempt) && attempt >= 1 && attempt <= 3;
}
