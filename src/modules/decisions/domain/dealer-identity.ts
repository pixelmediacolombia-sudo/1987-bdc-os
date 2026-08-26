export type DealerIdentityInput = {
  dealerId: string;
  ghlLocationId?: string;
};

// Location ids are routing metadata, not credentials. Keep the display name
// tied to the same verified location map used to resolve a tenant so a global
// SOFIA_DEALER_NAME cannot leak one dealer's identity into another tenant.
const DEALER_NAMES_BY_LOCATION: Record<string, string> = {
  k9DePpsNBu9qWT1C6pW0: "Country Club Cars Inc",
  LiaoSID3nvAhad49ZpNJ: "Off Lease",
  MyxWNKacThim798E8KC6: "Off Lease",
  bTNJHpNZ8FaS1PUHkuUq: "Koons Automotive of Culpeper",
  xuHo0opTO2g5edIuPJRl: "Koons Fredericksburg",
  ZxadcudjvBz7KFCB1od4: "Action Pre-Owned",
  "9v8zH9Y5eLiiJwZTZDci": "Arlington Woodbridge",
  MRHcOwdTqaN5cug3eSWW: "Easterns",
  "113zMWQlhKKBUu5wOYtR": "Easterns",
  xN2LSSl62okzv9GnOJPU: "Easterns",
};

export function resolveDealerDisplayName(input: DealerIdentityInput): string | undefined {
  const locationId = input.ghlLocationId?.trim();
  return locationId ? DEALER_NAMES_BY_LOCATION[locationId] : undefined;
}
