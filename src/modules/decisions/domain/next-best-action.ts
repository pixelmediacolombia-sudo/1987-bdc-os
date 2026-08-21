export type NextBestAction =
  | "REPLY"
  | "WAIT"
  | "ASK_OBJECTIVE"
  | "SEARCH_INVENTORY"
  | "OFFER_ALTERNATIVES"
  | "OFFER_APPOINTMENT"
  | "BOOK_APPOINTMENT"
  | "CREATE_TASK"
  | "HANDOFF"
  | "SCHEDULE_FOLLOWUP"
  | "CANCEL_FOLLOWUP"
  | "UPDATE_CRM"
  | "STOP";

export const ALL_NEXT_BEST_ACTIONS: readonly NextBestAction[] = [
  "REPLY",
  "WAIT",
  "ASK_OBJECTIVE",
  "SEARCH_INVENTORY",
  "OFFER_ALTERNATIVES",
  "OFFER_APPOINTMENT",
  "BOOK_APPOINTMENT",
  "CREATE_TASK",
  "HANDOFF",
  "SCHEDULE_FOLLOWUP",
  "CANCEL_FOLLOWUP",
  "UPDATE_CRM",
  "STOP",
] as const;

export const QUIET_HOURS_ACTIONS: readonly NextBestAction[] = [
  "WAIT",
  "SCHEDULE_FOLLOWUP",
  "HANDOFF",
] as const;

export const FINANCIAL_BOUNDARY_ACTIONS: readonly NextBestAction[] = [
  "HANDOFF",
  "REPLY",
] as const;
