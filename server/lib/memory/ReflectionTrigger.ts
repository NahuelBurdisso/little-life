import { simEvents } from '../simEvents';

const BASE_THRESHOLD = 150;
const COOLDOWN_TICKS = 60;

export class ReflectionTrigger {
  private accumulators: Map<number, number> = new Map();
  private cooldowns: Map<number, number> = new Map();
  private thresholdFn: (agentId: number) => number;

  constructor(thresholdFn?: (agentId: number) => number) {
    this.thresholdFn = thresholdFn ?? (() => BASE_THRESHOLD);

    simEvents.on('memory:created', ({ agentId, importance }: { agentId: number; importance: number; type: string }) => {
      this.onMemoryCreated(agentId, importance);
    });
  }

  onMemoryCreated(agentId: number, importance: number): void {
    const current = this.accumulators.get(agentId) ?? 0;
    this.accumulators.set(agentId, current + importance);
  }

  check(currentTick: number): number[] {
    const triggered: number[] = [];

    for (const [agentId, accumulated] of this.accumulators) {
      const threshold = this.thresholdFn(agentId);
      if (accumulated < threshold) continue;

      const lastReflection = this.cooldowns.get(agentId);
      if (lastReflection !== undefined && currentTick - lastReflection < COOLDOWN_TICKS) continue;

      triggered.push(agentId);
      this.accumulators.set(agentId, 0);
      this.cooldowns.set(agentId, currentTick);
    }

    return triggered;
  }

  clear(): void {
    this.accumulators.clear();
    this.cooldowns.clear();
  }
}
