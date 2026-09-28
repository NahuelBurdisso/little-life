// server/lib/cascade/TensionTracker.ts
import type { PersonalityProfile } from '../personality';
import type { TensionState } from './cascadeTypes';

const MAX_SOURCES = 5;

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

  tickUpdate(agentId: number, activeStates: string[], _currentTick: number): void {
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

    state.value = Math.max(0, state.value + delta);
  }

  // ─── Snap logic ──────────────────────────────────────────────────────────────

  shouldSnap(agentId: number, personality: PersonalityProfile, currentTick: number): boolean {
    const state = this.states.get(agentId);
    if (!state) return false;
    const threshold = this.getSnapThreshold(personality);
    const cooldownMet = (currentTick - state.lastSnapTick) >= 200;
    return state.value >= threshold && cooldownMet;
  }

  recordSnap(agentId: number, tick: number): void {
    const state = this.getOrCreate(agentId);
    state.lastSnapTick = tick;
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
        lastSnapTick: -200, // allows snapping on tick 0
        snapCount: 0,
      });
    }
    return this.states.get(agentId)!;
  }
}
