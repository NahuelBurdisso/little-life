function sanitizeNumber(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || isNaN(value) || !isFinite(value)) {
    return fallback;
  }
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function validateNeedsUpdate(
  needs: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...needs };

  const needFields = [
    "hunger",
    "energy",
    "social",
    "comfort",
    "fun",
    "mood",
    "stress",
  ];

  for (const field of needFields) {
    if (field in result) {
      result[field] = sanitizeNumber(result[field], 0, 100, 50);
    }
  }

  return result;
}

export function validateRelationshipUpdate(
  rel: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...rel };

  // Fields clamped to -100..100
  const signedFields = ["friendshipAB", "friendshipBA", "trustAB", "trustBA"];
  for (const field of signedFields) {
    if (field in result) {
      result[field] = sanitizeNumber(result[field], -100, 100, 0);
    }
  }

  // Fields clamped to 0..100
  const unsignedFields = ["romanceAB", "romanceBA", "familiarity"];
  for (const field of unsignedFields) {
    if (field in result) {
      result[field] = sanitizeNumber(result[field], 0, 100, 0);
    }
  }

  return result;
}

export function validateEconomyUpdate(
  econ: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...econ };

  // Money: non-negative integer
  if ("money" in result) {
    const money = result["money"];
    if (typeof money !== "number" || isNaN(money) || !isFinite(money)) {
      result["money"] = 0;
    } else {
      result["money"] = Math.max(0, Math.round(money));
    }
  }

  // Filter out inventory items with quantity <= 0
  if ("inventory" in result && Array.isArray(result["inventory"])) {
    result["inventory"] = (
      result["inventory"] as Array<{ item: string; quantity: number }>
    ).filter(
      (entry) => typeof entry.quantity === "number" && entry.quantity > 0,
    );
  }

  return result;
}
