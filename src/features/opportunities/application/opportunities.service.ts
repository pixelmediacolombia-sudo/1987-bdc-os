export const OPPORTUNITY_STAGES = ["new", "working", "closing", "won", "lost"] as const;
export type OpportunityStage = typeof OPPORTUNITY_STAGES[number];

export const DEFAULT_OPPORTUNITY_STAGES = [
  { stageKey: "new", label: "Nuevo", position: 0 },
  { stageKey: "working", label: "En proceso", position: 1 },
  { stageKey: "closing", label: "Cierre", position: 2 },
  { stageKey: "won", label: "Ganada", position: 3 },
  { stageKey: "lost", label: "Perdida", position: 4 },
] as const;

export function parseOpportunityStage(value: unknown): OpportunityStage | undefined {
  return typeof value === "string" && (OPPORTUNITY_STAGES as readonly string[]).includes(value)
    ? value as OpportunityStage
    : undefined;
}
