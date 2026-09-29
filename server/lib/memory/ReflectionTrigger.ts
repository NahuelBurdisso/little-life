import { simEvents } from '../simEvents';

const BASE_THRESHOLD = 150;
// Game minutes between an agent's reflections (it counted ticks: 4 hours at 4x).
const COOLDOWN_MINUTES = 60;

export class ReflectionTrigger {
  private accumulators: Map<number, number> = new Map();
  private cooldowns: Map<number, number> = new Map();
  private thresholdFn: (agentId: number) => number;
  private minThreshold: number;

  /**
   * `minThreshold`: the lowest value `thresholdFn` can return. `check` runs
   * every tick for every agent that ever made a memory, and the production
   * threshold reads the agent's personality from the DB — 13 point lookups a
   * tick to learn that an accumulator sitting at 12 is below a threshold that
   * never goes under 80. Below the floor the answer is known without asking.
   */
  constructor(thresholdFn?: (agentId: number) => number, minThreshold = 0) {
    this.thresholdFn = thresholdFn ?? (() => BASE_THRESHOLD);
    this.minThreshold = minThreshold;

    simEvents.on('memory:created', ({ agentId, importance }: { agentId: number; importance: number; type: string }) => {
      this.onMemoryCreated(agentId, importance);
    });
  }

  onMemoryCreated(agentId: number, importance: number): void {
    const current = this.accumulators.get(agentId) ?? 0;
    this.accumulators.set(agentId, current + importance);
  }

  check(nowMinutes: number): number[] {
    const triggered: number[] = [];

    for (const [agentId, accumulated] of this.accumulators) {
      // Cheap rejections first; only then the (DB-backed) threshold.
      if (accumulated < this.minThreshold) continue;
      const lastReflection = this.cooldowns.get(agentId);
      if (lastReflection !== undefined && nowMinutes - lastReflection < COOLDOWN_MINUTES) continue;

      const threshold = this.thresholdFn(agentId);
      if (accumulated < threshold) continue;

      triggered.push(agentId);
      this.accumulators.set(agentId, 0);
      this.cooldowns.set(agentId, nowMinutes);
    }

    return triggered;
  }

  clear(): void {
    this.accumulators.clear();
    this.cooldowns.clear();
  }
}
