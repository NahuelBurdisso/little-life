export function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function distance(
  a: { x: number; y: number },
  b: { x: number; y: number },
): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return Math.sqrt(dx * dx + dy * dy);
}

export function midpoint(
  a: { x: number; y: number },
  b: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
  };
}

export function weightedRandom<T>(
  items: Array<{ value: T; weight: number }>,
): T {
  if (items.length === 0) {
    throw new Error("weightedRandom called with empty array");
  }

  const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) {
    throw new Error("weightedRandom: total weight must be positive");
  }

  let random = Math.random() * totalWeight;

  for (const item of items) {
    random -= item.weight;
    if (random <= 0) {
      return item.value;
    }
  }

  // Fallback to last item (handles floating point edge cases)
  return items[items.length - 1].value;
}

export function pixelToTile(
  pos: { x: number; y: number },
  tileSize: number,
): { x: number; y: number } {
  return {
    x: Math.floor(pos.x / tileSize),
    y: Math.floor(pos.y / tileSize),
  };
}
