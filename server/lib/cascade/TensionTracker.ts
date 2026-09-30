// server/lib/cascade/TensionTracker.ts
import type { PersonalityProfile } from '../personality';
import type { TensionState } from './cascadeTypes';
import { asId, asNumber, asRecord, decodeStamp, encodeStamp } from '../../engine/snapshotCodec';

const MAX_SOURCES = 5;
/**
 * Game minutes an agent must wait after snapping before they can snap again.
 * 12 game hours: with the slower drain below, tension now actually carries
 * from one grievance to the next, so a volatile resident sitting on a pile of
 * them could otherwise re-snap every few hours at the same target. Half a day
 * lets the confrontation land (and be answered) before the next one.
 */
const SNAP_COOLDOWN_MINUTES = 720;

// --- Passive drift, per GAME MINUTE ------------------------------------------
// Ripple hits add 10-40 and snap thresholds are 55-125 (`snapThreshold`). The
// old natural decay of 0.3/min drained 18 per game hour, so a hit was gone in
// one or two hours and two grievances almost never overlapped: tension could
// not accumulate and snaps were rare no matter how bad the day. At 0.08/min
// (~4.8 per game hour) a 30-point hit lingers for most of a waking day, so
// three or four bad things in a day add up to a snap, while one hit on its own
// still fades long before it could.
/** Natural decay every game minute, whatever the resident's state. */
const TENSION_DECAY_PER_MIN = 0.08;
/** Passive build-up while the state is active (stressed nets +0.17/min, ~10 per game hour). */
const TENSION_GAIN_STRESSED_PER_MIN = 0.25;
const TENSION_GAIN_ANGRY_PER_MIN = 0.2;
const TENSION_GAIN_DEPRESSED_PER_MIN = 0.1;
/** Extra drain while the state is active: good spirits defuse a temper faster. */
const TENSION_RELIEF_EUPHORIC_PER_MIN = 0.4;
const TENSION_RELIEF_CONFIDENT_PER_MIN = 0.25;

/**
 * The tension at which a personality snaps. Free-standing (the method below only
 * delegates) because the "Brewing" readout (lib/brewing.ts) needs the same number
 * to show how close each resident is, and must not need the live tracker instance
 * just to do arithmetic on a personality.
 */
export function snapThreshold(personality: PersonalityProfile): number {
  const base = 100;
  const neuroReduction = personality.neuroticism / 4;       // 0-25 reduction
  const impulseReduction = personality.impulsiveness / 5;   // 0-20 reduction
  const moralityBoost = personality.morality / 6.67;        // 0-15 boost
  const warmthBoost = personality.warmth / 10;              // 0-10 boost
  return Math.max(55, Math.min(125, base - neuroReduction - impulseReduction + moralityBoost + warmthBoost));
}

/**
 * The person most of a resident's grievances are about, if any grievance names
 * one (`agentInvolved`, set by the ripple engine where the cause is another
 * resident). `share` is their fraction of ALL the sources, so a name on one
 * of five reads "partly" and not "mostly". Ties go to the newest.
 *
 * Free-standing and pure: the Brewing readout (lib/brewing.ts) names the person
 * with it, and the snap resolver aims a confrontation / revenge at the same one,
 * so the card and what the resident then does can never disagree.
 */
export function dominantGrievance(sources: TensionState['sources']): { name: string; share: number } | null {
  const counts = new Map<string, number>();
  for (const s of sources) {
    if (s.agentInvolved) counts.set(s.agentInvolved, (counts.get(s.agentInvolved) ?? 0) + 1);
  }
  let best: { name: string; count: number } | null = null;
  // Oldest first, `>=`: a later (newer) name wins a tie.
  for (const s of sources) {
    const count = s.agentInvolved ? counts.get(s.agentInvolved)! : 0;
    if (s.agentInvolved && (!best || count >= best.count)) best = { name: s.agentInvolved, count };
  }
  return best ? { name: best.name, share: best.count / sources.length } : null;
}

export class TensionTracker {
  private states: Map<number, TensionState> = new Map();

  // ─── Getters ─────────────────────────────────────────────────────────────────

  getTension(agentId: number): number {
    return this.states.get(agentId)?.value ?? 0;
  }

  getSources(agentId: number): TensionState['sources'] {
    return this.states.get(agentId)?.sources ?? [];
  }

  getAllAgentIds(): number[] {
    return Array.from(this.states.keys());
  }

  // ─── Mutations ────────────────────────────────────────────────────────────────

  addTension(
    agentId: number,
    amount: number,
    source: { event: string; description: string; tick: number; agentInvolved?: string },
  ): void {
    const state = this.getOrCreate(agentId);
    state.value += amount;
    state.sources.push(source);
    // Keep only the latest MAX_SOURCES entries
    if (state.sources.length > MAX_SOURCES) {
      state.sources = state.sources.slice(state.sources.length - MAX_SOURCES);
    }
  }

  // ─── Threshold ────────────────────────────────────────────────────────────────

  getSnapThreshold(personality: PersonalityProfile): number {
    return snapThreshold(personality);
  }

  // ─── Tick update ─────────────────────────────────────────────────────────────

  /**
   * Apply `elapsedMinutes` game minutes of passive drift (the tick's
   * tick_speed). The rates below are per game minute; applied once per tick
   * they drained and built tension four times slower per game hour at 4x.
   */
  tickUpdate(agentId: number, activeStates: string[], elapsedMinutes: number): void {
    const state = this.getOrCreate(agentId);

    let delta = 0;

    // Natural decay
    delta -= TENSION_DECAY_PER_MIN;

    // Passive gains from negative states
    if (activeStates.includes('stressed')) delta += TENSION_GAIN_STRESSED_PER_MIN;
    if (activeStates.includes('angry')) delta += TENSION_GAIN_ANGRY_PER_MIN;
    if (activeStates.includes('depressed')) delta += TENSION_GAIN_DEPRESSED_PER_MIN;

    // Decay boosts from positive states
    if (activeStates.includes('euphoric')) delta -= TENSION_RELIEF_EUPHORIC_PER_MIN;
    if (activeStates.includes('confident')) delta -= TENSION_RELIEF_CONFIDENT_PER_MIN;

    state.value = Math.max(0, state.value + delta * elapsedMinutes);
  }

  // ─── Snap logic ──────────────────────────────────────────────────────────────

  /**
   * CLOCK: GAME MINUTES. The cooldown was 200 TICKS, i.e. 800 game minutes
   * between snaps at 4x; it is now SNAP_COOLDOWN_MINUTES (720) game minutes
   * at every speed.
   *
   * `thresholdScale` is the world's "Drama Intensity" (worldRules.ts
   * `snapThresholdScale`): below 1 tempers run shorter. A parameter rather
   * than a read here so the tracker stays free of the DB.
   */
  shouldSnap(agentId: number, personality: PersonalityProfile, nowMinutes: number, thresholdScale = 1): boolean {
    const state = this.states.get(agentId);
    if (!state) return false;
    const threshold = this.getSnapThreshold(personality) * thresholdScale;
    const cooldownMet = (nowMinutes - state.lastSnapMinute) >= SNAP_COOLDOWN_MINUTES;
    return state.value >= threshold && cooldownMet;
  }

  recordSnap(agentId: number, nowMinutes: number): void {
    const state = this.getOrCreate(agentId);
    state.lastSnapMinute = nowMinutes;
    state.snapCount += 1;
    state.value = 20;
    // The grievances were just acted on. Keeping them would feed the same stale
    // reasons into every future snap prompt for the rest of the run.
    state.sources = [];
  }

  // ─── Relief events ───────────────────────────────────────────────────────────

  onPositiveConversation(agentId: number): void {
    const state = this.getOrCreate(agentId);
    state.value = Math.max(0, state.value - 5);
  }

  onSleep(agentId: number): void {
    const state = this.getOrCreate(agentId);
    state.value = Math.max(0, state.value * 0.9);
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  reset(): void {
    this.states.clear();
  }

  cleanupAgent(agentId: number): void {
    this.states.delete(agentId);
  }

  // ─── Persistence ─────────────────────────────────────────────────────────────
  // Tension builds over game days toward a snap; see `tensionSnapshotStore` in
  // ./index.ts. Shape: { [agentId]: { value, sources, lastSnapMinute, snapCount } }
  // with a never-snapped stamp written as null (JSON has no -Infinity).

  serialize(): Record<string, Omit<TensionState, 'lastSnapMinute'> & { lastSnapMinute: number | null }> {
    const out: ReturnType<TensionTracker['serialize']> = {};
    for (const [agentId, s] of this.states) {
      out[agentId] = {
        value: s.value,
        sources: s.sources.map((src) => ({ ...src })),
        lastSnapMinute: encodeStamp(s.lastSnapMinute),
        snapCount: s.snapCount,
      };
    }
    return out;
  }

  /** Replace every agent's state with `data`; malformed entries are skipped. */
  restore(data: unknown): void {
    this.states.clear();
    for (const [key, raw] of Object.entries(asRecord(data) ?? {})) {
      const agentId = asId(key);
      const s = asRecord(raw);
      const value = asNumber(s?.value);
      if (agentId === null || value === null) continue;
      const rawSources = s?.sources;
      const sources: TensionState['sources'] = [];
      for (const src of Array.isArray(rawSources) ? rawSources : []) {
        const r = asRecord(src);
        const tick = asNumber(r?.tick);
        if (!r || typeof r.event !== 'string' || typeof r.description !== 'string' || tick === null) continue;
        sources.push({
          event: r.event,
          description: r.description,
          tick,
          ...(typeof r.agentInvolved === 'string' ? { agentInvolved: r.agentInvolved } : {}),
        });
      }
      this.states.set(agentId, {
        value,
        sources: sources.slice(-MAX_SOURCES),
        lastSnapMinute: decodeStamp(s?.lastSnapMinute),
        snapCount: asNumber(s?.snapCount) ?? 0,
      });
    }
  }

  // ─── Private helpers ─────────────────────────────────────────────────────────

  private getOrCreate(agentId: number): TensionState {
    if (!this.states.has(agentId)) {
      this.states.set(agentId, {
        value: 0,
        sources: [],
        lastSnapMinute: Number.NEGATIVE_INFINITY, // never snapped: no cooldown
        snapCount: 0,
      });
    }
    return this.states.get(agentId)!;
  }
}
