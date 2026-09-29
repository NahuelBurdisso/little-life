// server/lib/cascade/TensionTracker.ts
import type { PersonalityProfile } from '../personality';
import type { TensionState } from './cascadeTypes';

const MAX_SOURCES = 5;
/** Game minutes an agent must wait after snapping before they can snap again. */
const SNAP_COOLDOWN_MINUTES = 200;

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
    const base = 100;
    const neuroReduction = personality.neuroticism / 4;       // 0-25 reduction
    const impulseReduction = personality.impulsiveness / 5;   // 0-20 reduction
    const moralityBoost = personality.morality / 6.67;        // 0-15 boost
    const warmthBoost = personality.warmth / 10;              // 0-10 boost
    return Math.max(55, Math.min(125, base - neuroReduction - impulseReduction + moralityBoost + warmthBoost));
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
    delta -= 0.3;

    // Passive gains from negative states
    if (activeStates.includes('stressed')) delta += 0.5;
    if (activeStates.includes('angry')) delta += 0.4;
    if (activeStates.includes('depressed')) delta += 0.2;

    // Decay boosts from positive states
    if (activeStates.includes('euphoric')) delta -= 0.8;
    if (activeStates.includes('confident')) delta -= 0.5;

    state.value = Math.max(0, state.value + delta * elapsedMinutes);
  }

  // ─── Snap logic ──────────────────────────────────────────────────────────────

  /**
   * CLOCK: GAME MINUTES. The cooldown was 200 TICKS, i.e. 800 game minutes
   * between snaps at 4x; it is now 200 game minutes at every speed.
   */
  shouldSnap(agentId: number, personality: PersonalityProfile, nowMinutes: number): boolean {
    const state = this.states.get(agentId);
    if (!state) return false;
    const threshold = this.getSnapThreshold(personality);
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
