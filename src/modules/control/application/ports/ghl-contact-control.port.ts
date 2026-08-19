export type GhlHumanOwnershipUpdate = {
  contactId: string;
  ownerId?: string;
};

/**
 * Future write-scope seam. Current GHL scopes are read-only, so Ticket 6 only
 * updates local PostgreSQL state and never calls this port.
 */
export interface GhlContactControlPort {
  markHumanOwnership(input: GhlHumanOwnershipUpdate): Promise<void>;
}
