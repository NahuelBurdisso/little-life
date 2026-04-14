// server/lib/cascade/RippleEngine.ts
import type { RippleRule, RippleContext, CascadeMetadata } from './cascadeTypes';
import type { PersonalityProfile } from '../personality';
import { rippleRules as RIPPLE_RULES } from './rippleRules';
import { simEvents } from '../simEvents';

interface QueueItem {
  rule: RippleRule;
  payload: any;
  metadata: CascadeMetadata;
}

interface RippleEngineOptions {
  rules?: RippleRule[];
  dryRun?: boolean;
}

export class RippleEngine {
  private rules: RippleRule[];
  private cooldowns: Map<string, Map<number, { tick: number; cooldownTicks: number }>>; // ruleId → agentId → {lastFiredTick, cooldown}
  private tickEventCount: number;
  private eventQueue: Array<QueueItem>;
  private dryRun: boolean;
  private tensionTracker?: any;
  private witnessAmplifier?: any;

  constructor(options: RippleEngineOptions = {}) {
    this.rules = options.rules ?? RIPPLE_RULES;
    this.dryRun = options.dryRun ?? false;
    this.cooldowns = new Map();
    this.tickEventCount = 0;
    this.eventQueue = [];

    if (!this.dryRun) {
      this.registerListeners();
    }
  }

  // ─── Public setters for optional sub-systems ────────────────────────────────

  setTensionTracker(tracker: any): void {
    this.tensionTracker = tracker;
  }

  setWitnessAmplifier(amplifier: any): void {
    this.witnessAmplifier = amplifier;
  }

  // ─── Probability ─────────────────────────────────────────────────────────────

  calculateProbability(rule: RippleRule, personality: PersonalityProfile): number {
    let prob = rule.probability;

    if (rule.personalityGates && rule.personalityGates.length > 0) {
      for (const gate of rule.personalityGates) {
        const axisValue = personality[gate.axis] ?? 50;
        if (gate.direction === '+') {
          prob += (axisValue / 100) * gate.weight;
        } else {
          prob += ((100 - axisValue) / 100) * gate.weight;
        }
      }
    }

    return Math.max(0, Math.min(1, prob));
  }

  // ─── Cooldowns ───────────────────────────────────────────────────────────────

  isOnCooldown(ruleId: string, agentId: number, currentTick: number): boolean {
    const ruleMap = this.cooldowns.get(ruleId);
    if (!ruleMap) return false;
    const entry = ruleMap.get(agentId);
    if (entry === undefined) return false;
    return (currentTick - entry.tick) < entry.cooldownTicks;
  }

  recordCooldown(ruleId: string, agentId: number, tick: number, cooldownTicks?: number): void {
    if (!this.cooldowns.has(ruleId)) {
      this.cooldowns.set(ruleId, new Map());
    }
    const effectiveCooldown =
      cooldownTicks ?? this.rules.find(r => r.id === ruleId)?.cooldownTicks ?? 0;
    this.cooldowns.get(ruleId)!.set(agentId, { tick, cooldownTicks: effectiveCooldown });
  }

  resetCooldowns(): void {
    this.cooldowns.clear();
  }

  cleanupCooldowns(activeAgentIds: Set<number>): void {
    for (const [ruleId, ruleMap] of this.cooldowns.entries()) {
      for (const agentId of ruleMap.keys()) {
        if (!activeAgentIds.has(agentId)) {
          ruleMap.delete(agentId);
        }
      }
      if (ruleMap.size === 0) {
        this.cooldowns.delete(ruleId);
      }
    }
  }

  // ─── Chain depth ─────────────────────────────────────────────────────────────

  isChainDepthExceeded(depth: number): boolean {
    return depth >= 5;
  }

  // ─── Per-tick cap ─────────────────────────────────────────────────────────────

  isTickCapReached(): boolean {
    return this.tickEventCount >= 8;
  }

  isExemptFromCap(depth: number): boolean {
    return depth <= 1;
  }

  incrementTickCounter(depth: number): void {
    if (depth > 1) {
      this.tickEventCount++;
    }
  }

  resetTickCounter(): void {
    this.tickEventCount = 0;
  }

  // ─── Deduplication ───────────────────────────────────────────────────────────

  shouldSkipForDedup(source: string, payload: any): boolean {
    return source === 'state:triggered' && payload !== null && typeof payload === 'object' && '_cascade' in payload;
  }

  // ─── Requirements ────────────────────────────────────────────────────────────

  checkRequirementsPublic(
    requires: RippleRule['requires'],
    agentId: number,
    payload: any,
    ctx: RippleContext,
  ): boolean {
    return this.checkRequirementsWithCtx(requires, agentId, payload, ctx);
  }

  private checkRequirementsWithCtx(
    requires: RippleRule['requires'],
    agentId: number,
    payload: any,
    ctx: RippleContext,
  ): boolean {
    if (!requires) return true;

    const states = ctx.getAgentStates(agentId);

    if (requires.state !== undefined) {
      if (!states.includes(requires.state)) return false;
    }

    if (requires.notState !== undefined) {
      if (states.includes(requires.notState)) return false;
    }

    if (requires.coLocatedWith === 'any_agent') {
      const others = ctx.agentsAtLocation.filter(a => a.id !== agentId);
      if (others.length === 0) return false;
    }

    if (requires.needBelow !== undefined) {
      const needs = ctx.getAgentNeeds(agentId);
      const needValue = needs[requires.needBelow.need as keyof typeof needs];
      if (typeof needValue !== 'number' || needValue >= requires.needBelow.value) return false;
    }

    if (requires.moneyBelow !== undefined) {
      const economy = ctx.getAgentEconomy(agentId);
      if (economy.money >= requires.moneyBelow) return false;
    }

    if (requires.relationshipMin !== undefined) {
      // Stub: skip detailed relationship check without perpetrator info in payload
      // Real implementation done in Task 4
    }

    if (requires.relationshipMax !== undefined) {
      // Stub
    }

    return true;
  }

  private checkRequirements(
    rule: RippleRule,
    agentId: number,
    payload: any,
    ctx?: RippleContext,
  ): boolean {
    const context = ctx ?? this.buildContext(payload);
    return this.checkRequirementsWithCtx(rule.requires, agentId, payload, context);
  }

  // ─── Queue ────────────────────────────────────────────────────────────────────

  processQueue(): void {
    while (this.eventQueue.length > 0) {
      const item = this.eventQueue.shift();
      if (item) {
        this.evaluateAndFire(item.rule, item.payload, item.metadata.chainId, item.metadata.chainDepth);
      }
    }
  }

  // ─── Private stubs ───────────────────────────────────────────────────────────

  private registerListeners(): void {
    // Registers simEvents listeners — implemented in Task 4
    // No-op placeholder
  }

  private handleEvent(source: string, payload: any): void {
    // Main event handler — implemented in Task 4
  }

  private evaluateAndFire(
    rule: RippleRule,
    payload: any,
    chainId: string,
    parentDepth: number,
  ): void {
    // Evaluate and fire rule — implemented in Task 4
  }

  private buildContext(payload: any): RippleContext {
    // Returns an empty context stub — wired in Task 4
    return {
      targetAgent: { id: 0, current_location: null, personality: null },
      agentsAtLocation: [],
      getRelationship: () => null,
      getAgentStates: () => [],
      getAgentNeeds: () => ({ mood: 50, stress: 50, hunger: 50, energy: 50, social: 50 }),
      getAgentEconomy: () => ({ money: 0, work_performance: 0 }),
      currentTick: 0,
    };
  }

  private getCurrentTick(): number {
    return 0; // Stub — wired in Task 4
  }

  private getAgentPersonality(id: number): PersonalityProfile | null {
    return null; // Stub — wired in Task 4
  }

  private getAgentLocation(id: number): number | null {
    return null; // Stub — wired in Task 4
  }

  private executeEffects(
    rule: RippleRule,
    agentId: number,
    metadata: CascadeMetadata,
    payload: any,
  ): void {
    // No-op stub — wired in Task 4
  }
}
