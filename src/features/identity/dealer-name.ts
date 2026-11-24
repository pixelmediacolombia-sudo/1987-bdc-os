const VERIFIED_DEALER_NAMES_BY_GHL_LOCATION = new Map<string, string>([
  ["ZxadcudjvBz7KFCB1od4", "Action Pre-Owned Cars"],
  ["MyxWNKacThim798E8KC6", "Off Lease Motors - Fredericksburg"],
  ["xN2LSSl62okzv9GnOJPU", "Easterns Automotive Group - Location 3 (city unconfirmed)"],
  ["113zMWQlhKKBUu5wOYtR", "Easterns Automotive Group - Millersville"],
  ["LiaoSID3nvAhad49ZpNJ", "Off Lease Motors - Stafford"],
  ["MRHcOwdTqaN5cug3eSWW", "Easterns Automotive Group - Frederick MD"],
  ["k9DePpsNBu9qWT1C6pW0", "Country Club DMV"],
  ["9v8zH9Y5eLiiJwZTZDci", "Arlington Motors of Woodbridge"],
  ["bTNJHpNZ8FaS1PUHkuUq", "Koons Automotive of Culpeper"],
  ["xuHo0opTO2g5edIuPJRl", "Koons of Fredericksburg"],
  ["C89276AhU942sfwFMQ9m", "Legacy tenant - dealer identity unconfirmed"],
]);

/** Prefer a manually managed name; infer only exact, verified GHL location IDs. */
export function resolveDealerName(dealerName: string | null | undefined, ghlLocationId: string | null | undefined): string | null {
  const explicitName = dealerName?.trim();
  if (explicitName) return explicitName;
  if (!ghlLocationId) return null;
  return VERIFIED_DEALER_NAMES_BY_GHL_LOCATION.get(ghlLocationId) ?? null;
}
