/** The visible world rect, recomputed once per frame by GameCanvas. */
export interface ViewRect {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Camera zoom (world→screen scale). */
  scale: number;
}

/**
 * Whether a world point (plus `margin` px around it) is on screen. Canvas systems use
 * it to skip animating and to hide what can't be seen — the cheapest frame is the one
 * that isn't drawn.
 */
export function inView(v: ViewRect, x: number, y: number, margin = 32): boolean {
  return x >= v.x - margin && x <= v.x + v.w + margin && y >= v.y - margin && y <= v.y + v.h + margin;
}

/**
 * Detail level for ambient decoration by zoom: at a far zoom single pixels of a bird
 * or a flower petal are noise, so decorative systems thin out or stop.
 * 0 = far (≤0.6x), 1 = normal, 2 = close (≥1.6x).
 */
export function detailLevel(scale: number): 0 | 1 | 2 {
  if (scale <= 0.6) return 0;
  if (scale >= 1.6) return 2;
  return 1;
}
