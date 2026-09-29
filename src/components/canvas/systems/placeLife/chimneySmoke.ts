import type { DataContext } from "../types";
import { chimneySmokes, computePlaceStates, readClimate } from "./placeState";

/**
 * Which chimneys are smoking, refreshed a couple of times a second.
 *
 * The smoke itself is drawn by the particle engine from synthetic 'chimney' locations that
 * GameCanvas rebuilds every frame; this only answers "should building N smoke right now?",
 * from who is inside and what they are doing (see `chimneySmokes`) rather than from the
 * day phase alone. Recomputing per frame would be wasteful and per poll would lag behind
 * the frame loop's data, so it re-reads the shared data on a short timer instead.
 */

const REFRESH_MS = 500;

export class ChimneySmokePlan {
  private readonly ids = new Set<number>();
  private nextAt = 0;

  /** Recompute if the timer ran out. `now` is any monotonic millisecond clock. */
  refresh(now: number, data: DataContext): void {
    if (now < this.nextAt) return;
    this.nextAt = now + REFRESH_MS;
    this.ids.clear();
    if (!data.world || data.locations.length === 0) return;
    const climate = readClimate(data.world, data.events);
    for (const st of computePlaceStates(data.locations, data.agents, climate)) {
      if (chimneySmokes(st, climate)) this.ids.add(st.id);
    }
  }

  smokes(locationId: number): boolean {
    return this.ids.has(locationId);
  }
}
