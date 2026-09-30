// server/lib/cascade/RippleEngine.ts
import type { RippleRule, RippleContext, CascadeMetadata } from './cascadeTypes';
import type { PersonalityProfile } from '../personality';
import { rippleRules as RIPPLE_RULES } from './rippleRules';
import { simEvents } from '../simEvents';
import { db } from '../../db';
import { agents, agentStates, needs, economy, relationships, worldState, goals, locations } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { createFact, getAgentName, jealousRumorContext, type FactContext } from '../gossip';
import { describeWitnessedAct, type WitnessAmplifier } from './WitnessAmplifier';
import type { TensionTracker } from './TensionTracker';
import { logActivity } from '../activityLogger';
import { gameMinutesNow } from '../worldClock';
import { getRules, type LiveRules } from '../worldRules';
import { rippleProbabilityScale } from './ruleTone';
import { mayRomanceGrow } from '../intimacy/attraction';
import crypto from 'crypto';

interface QueueItem {
  rule: RippleRule;
  payload: any;
  metadata: CascadeMetadata;
}

interface RippleEngineOptions {
  rules?: RippleRule[];
  dryRun?: boolean;
}

/**
 * The parts of the optional sub-systems the engine calls. Narrow on purpose:
 * the engine only feeds tension and hands witnesses their behaviors, and a test
 * can plug in a stand-in without building a whole tracker.
 */
export type RippleTensionSink = Pick<TensionTracker, 'addTension'>;
export type RippleWitnessAmplifier = Pick<WitnessAmplifier, 'getWitnessBehaviors' | 'applyBehaviors'>;

/** Run `read` on first call only, then keep answering with its result. */
function once<T>(read: () => T): () => T {
  let done = false;
  let value: T;
  return () => {
    if (!done) { value = read(); done = true; }
    return value;
  };
}

/**
 * The party a cascade effect is aimed at, from the acting agent's side: the
 * first of perpetrator/victim that is someone else. `perpetratorId` falls back
 * to the acting agent when an event names no perpetrator, so a plain
 * `perpetratorId ?? victimId` would pick the agent themself.
 */
function otherParty(
  metadata: { perpetratorId?: number | null; victimId?: number | null },
  agentId: number,
): number | undefined {
  return [metadata.perpetratorId, metadata.victimId].find((id): id is number => id != null && id !== agentId);
}

/**
 * The name of `otherParty`, for grievances that should say who they are about
 * ("mostly about Jonas" in the Brewing panel). Undefined when the event names
 * nobody but the agent themself (money trouble, a birthday) or the row is gone.
 */
export function otherPartyName(
  cast: { perpetratorId?: number | null; victimId?: number | null },
  agentId: number,
): string | undefined {
  const id = otherParty(cast, agentId);
  if (id == null) return undefined;
  return db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name;
}

export class RippleEngine {
  private rules: RippleRule[];
  // ruleId → agentId → {game minute last fired, cooldown}. CLOCK: GAME MINUTES —
  // they were ticks, so at 4x an 8-hour rule cooldown lasted 32.
  private cooldowns: Map<string, Map<number, { at: number; cooldownMinutes: number }>>;
  private tickEventCount: number;
  private eventQueue: Array<QueueItem>;
  private dryRun: boolean;
  private tensionTracker?: RippleTensionSink;
  private witnessAmplifier?: RippleWitnessAmplifier;

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

  setTensionTracker(tracker: RippleTensionSink): void {
    this.tensionTracker = tracker;
  }

  setWitnessAmplifier(amplifier: RippleWitnessAmplifier): void {
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

  /**
   * The rule's probability roll, with the world's rules applied on top of the
   * personality-gated odds: "Drama Intensity" scales the dark rules, "Contagion
   * Rate" the sickness one (ruleTone.ts). Applied after the gates so a hothead
   * stays likelier to lash out than a saint at every drama level; clamped
   * again because 'chaos' can push a gated 0.6 past 1.
   */
  rollsToFire(rule: RippleRule, personality: PersonalityProfile, rules: LiveRules = getRules()): boolean {
    const prob = Math.min(1, this.calculateProbability(rule, personality) * rippleProbabilityScale(rule, rules));
    return Math.random() < prob;
  }

  // ─── Cooldowns ───────────────────────────────────────────────────────────────

  isOnCooldown(ruleId: string, agentId: number, nowMinutes: number): boolean {
    const ruleMap = this.cooldowns.get(ruleId);
    if (!ruleMap) return false;
    const entry = ruleMap.get(agentId);
    if (entry === undefined) return false;
    return (nowMinutes - entry.at) < entry.cooldownMinutes;
  }

  recordCooldown(ruleId: string, agentId: number, nowMinutes: number, cooldownMinutes?: number): void {
    if (!this.cooldowns.has(ruleId)) {
      this.cooldowns.set(ruleId, new Map());
    }
    const effectiveCooldown =
      cooldownMinutes ?? this.rules.find(r => r.id === ruleId)?.cooldownMinutes ?? 0;
    this.cooldowns.get(ruleId)!.set(agentId, { at: nowMinutes, cooldownMinutes: effectiveCooldown });
  }

  /**
   * Which agent a rule's cooldown is bucketed under.
   *
   * `witness` / `random_present` rules resolve to a *random* co-located agent, so
   * a cooldown keyed on that agent throttles almost nothing — each repeat of the
   * source event simply rolls a different witness and fires again. Bucket those
   * under the agent the event was about instead, so one crowd reaction per source
   * event window is what actually gets capped.
   */
  private cooldownAgent(rule: RippleRule, resolvedAgentId: number, payload: any): number {
    if (rule.target === 'witness' || rule.target === 'random_present') {
      return payload?.agentId ?? payload?.perpetratorId ?? resolvedAgentId;
    }
    return resolvedAgentId;
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
    return depth > 5;
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

  /**
   * Self-loop guard: a rule must not re-fire off the event it just emitted.
   *
   * This used to reject *every* cascade-originated `state:triggered`, which made
   * every cascade-created state a chain dead-end — heartbroken never led to
   * drinking/confrontation/isolation, angry never led to lashing out, sick never
   * spread past the first hop. Chain length is already bounded by
   * `isChainDepthExceeded`, the per-tick cap and per-rule cooldowns, so only the
   * immediate self-loop needs blocking here.
   */
  shouldSkipForDedup(rule: RippleRule, payload: any): boolean {
    if (payload === null || typeof payload !== 'object') return false;
    const parentRuleId = payload._cascade?.parentRuleId;
    return parentRuleId != null && parentRuleId === rule.id;
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
    } else if (requires.coLocatedWith !== undefined) {
      // 'perpetrator' | 'victim'. Without these branches the requirement passed
      // unconditionally, so `drunk_fight` picked fights with nobody.
      // 'perpetrator' means "the other party this is about". When the event's
      // perpetrator is the agent themself (goal events name the achiever as
      // actor and the goal's target as victim), that other party is the victim —
      // otherwise drunk_fight after a failed goal had nobody left to fight.
      const perpetratorId = payload?.perpetratorId ?? null;
      const otherId = requires.coLocatedWith === 'perpetrator'
        ? (perpetratorId != null && perpetratorId !== agentId ? perpetratorId : payload?.victimId ?? null)
        : payload?.victimId ?? null;
      if (otherId == null || otherId === agentId) return false;
      if (!ctx.agentsAtLocation.some(a => a.id === otherId)) return false;
    }

    if (requires.needBelow !== undefined) {
      const agentNeeds = ctx.getAgentNeeds(agentId);
      const needValue = agentNeeds[requires.needBelow.need as keyof typeof agentNeeds];
      if (typeof needValue !== 'number' || needValue >= requires.needBelow.value) return false;
    }

    if (requires.moneyBelow !== undefined) {
      const agentEconomy = ctx.getAgentEconomy(agentId);
      if (agentEconomy.money >= requires.moneyBelow) return false;
    }

    if (requires.relationshipMin !== undefined) {
      const targetId = payload?.perpetratorId ?? payload?.victimId ?? payload?.targetId ?? null;
      if (targetId == null) return false; // can't check relationship without a target
      const rel = ctx.getRelationship(agentId, targetId);
      if (!rel) return false;
      const a = Math.min(agentId, targetId);
      const isA = agentId === a;
      const fieldValue = this.getRelField(rel, requires.relationshipMin.field, isA);
      if (fieldValue < requires.relationshipMin.value) return false;
    }

    if (requires.relationshipMax !== undefined) {
      const targetId = payload?.perpetratorId ?? payload?.victimId ?? payload?.targetId ?? null;
      if (targetId == null) return false; // can't check relationship without a target
      const rel = ctx.getRelationship(agentId, targetId);
      if (!rel) return false;
      const a = Math.min(agentId, targetId);
      const isA = agentId === a;
      const fieldValue = this.getRelField(rel, requires.relationshipMax.field, isA);
      if (fieldValue > requires.relationshipMax.value) return false;
    }

    return true;
  }

  private getRelField(rel: any, field: string, isA: boolean): number {
    switch (field) {
      case 'friendship': return isA ? rel.friendship_ab : rel.friendship_ba;
      case 'romance': return isA ? rel.romance_ab : rel.romance_ba;
      case 'trust': return isA ? rel.trust_ab : rel.trust_ba;
      default: return 0;
    }
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

  /**
   * Drop every event still waiting to be evaluated.
   *
   * Only meaningful on a world replace. Queued payloads carry raw agent ids, and
   * ids restart at 1 after a wipe — so anything left here would not be discarded
   * as stale, it would be applied to whichever *different* agent now holds that
   * id. Same hazard the movement and cost-map resets exist for.
   */
  clearQueue(): void {
    this.eventQueue.length = 0;
  }

  processQueue(): void {
    while (this.eventQueue.length > 0) {
      const item = this.eventQueue.shift();
      if (item) {
        this.evaluateAndFire(item.rule, item.payload, item.metadata.chainId, item.metadata.chainDepth);
      }
    }
  }

  // ─── Listener registration ────────────────────────────────────────────────────

  private registerListeners(): void {
    // Collect all unique source event names from rules
    const sourceEvents = new Set<string>();
    for (const rule of this.rules) {
      sourceEvents.add(rule.source);
    }

    for (const source of sourceEvents) {
      simEvents.on(source, (payload: any) => {
        this.handleEvent(source, payload);
      });
    }
  }

  // ─── Main event handler ────────────────────────────────────────────────────────

  private handleEvent(source: string, payload: any): void {
    const nowMinutes = gameMinutesNow();
    // One context for every filter of this event: nothing below writes before
    // the queue runs, so each rule's filter would read the same answers. It was
    // rebuilt per filtered rule, and eagerly — 3-4 queries a rule, for filters
    // that (today) all read only the payload.
    let filterCtx: RippleContext | undefined;

    // Find all rules matching this source
    for (const rule of this.rules) {
      if (rule.source !== source) continue;

      // Deduplication: don't let a rule re-fire off its own emitted event
      if (this.shouldSkipForDedup(rule, payload)) continue;

      // Apply source filter if present
      if (rule.sourceFilter) {
        filterCtx ??= this.buildContext(payload);
        if (!rule.sourceFilter(payload, filterCtx)) continue;
      }

      // Determine target agent ID
      const agentId = this.resolveTargetAgent(rule, payload);
      if (agentId == null) continue;

      // Check cooldown
      if (this.isOnCooldown(rule.id, this.cooldownAgent(rule, agentId, payload), nowMinutes)) continue;

      // Generate chain metadata
      const chainId = payload?._cascade?.chainId ?? crypto.randomBytes(6).toString('hex');
      const parentDepth = payload?._cascade?.chainDepth ?? 0;

      // Queue for evaluation
      this.eventQueue.push({
        rule,
        payload: { ...payload, _resolvedAgentId: agentId },
        metadata: {
          chainId,
          chainDepth: parentDepth + 1,
          parentRuleId: payload?._cascade?.parentRuleId,
          locationId: payload?.locationId ?? this.getAgentLocation(agentId),
          perpetratorId: payload?.perpetratorId ?? payload?.agentId,
          victimId: payload?.victimId,
        },
      });
    }

    // Process the queue immediately for depth-1 events
    this.processQueue();
  }

  private resolveTargetAgent(rule: RippleRule, payload: any): number | null {
    switch (rule.target) {
      case 'self':
        return payload?.agentId ?? null;
      case 'perpetrator':
        return payload?.perpetratorId ?? payload?.agentId ?? null;
      case 'victim':
        return payload?.victimId ?? null;
      case 'witness': {
        // Pick a random co-located agent that is NOT the main agents
        const locationId = payload?.locationId ?? (payload?.agentId ? this.getAgentLocation(payload.agentId) : null);
        if (locationId == null) return null;
        const coLocated = this.getAgentsAtLocation(locationId);
        const excluded = new Set([payload?.agentId, payload?.perpetratorId, payload?.victimId].filter(Boolean));
        const witnesses = coLocated.filter(id => !excluded.has(id));
        if (witnesses.length === 0) return null;
        return witnesses[Math.floor(Math.random() * witnesses.length)];
      }
      case 'random_present': {
        const locId = payload?.locationId ?? (payload?.agentId ? this.getAgentLocation(payload.agentId) : null);
        if (locId == null) return null;
        const atLoc = this.getAgentsAtLocation(locId);
        const excludeSelf = new Set([payload?.agentId].filter(Boolean));
        const others = atLoc.filter(id => !excludeSelf.has(id));
        if (others.length === 0) return null;
        return others[Math.floor(Math.random() * others.length)];
      }
      default:
        return null;
    }
  }

  private getAgentsAtLocation(locationId: number): number[] {
    const rows = db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.current_location, locationId), eq(agents.is_active, true)))
      .all();
    return rows.map(r => r.id);
  }

  // ─── Evaluate and fire ────────────────────────────────────────────────────────

  private evaluateAndFire(
    rule: RippleRule,
    payload: any,
    chainId: string,
    depth: number,
  ): void {
    // Chain depth limit
    if (this.isChainDepthExceeded(depth)) return;

    // Per-tick cap (depth 1 exempt)
    if (this.isTickCapReached() && !this.isExemptFromCap(depth)) return;

    const agentId: number = payload._resolvedAgentId;
    const nowMinutes = gameMinutesNow();

    // Get personality for probability calculation
    const personality = this.getAgentPersonality(agentId);
    if (!personality) return;

    // Build context for requirements check
    const ctx = this.buildContext(payload);

    // Check requirements
    if (!this.checkRequirements(rule, agentId, payload, ctx)) return;

    // Probability roll
    if (!this.rollsToFire(rule, personality)) return;

    // Record cooldown
    this.recordCooldown(rule.id, this.cooldownAgent(rule, agentId, payload), nowMinutes);

    // Increment tick counter
    this.incrementTickCounter(depth);

    // Build cascade metadata
    const metadata: CascadeMetadata = {
      chainId,
      chainDepth: depth,
      parentRuleId: rule.id,
      locationId: payload?.locationId ?? this.getAgentLocation(agentId) ?? undefined,
      perpetratorId: payload?.perpetratorId ?? payload?.agentId,
      victimId: payload?.victimId,
    };

    // Execute effects
    this.executeEffects(rule, agentId, metadata, payload);

    // Witness amplification: if there's a location, notify witnesses
    if (metadata.locationId != null && this.witnessAmplifier) {
      const coLocated = this.getAgentsAtLocation(metadata.locationId);
      const excluded = new Set([agentId, metadata.perpetratorId, metadata.victimId].filter(Boolean) as number[]);

      for (const witnessId of coLocated) {
        if (excluded.has(witnessId)) continue;

        const witnessPers = this.getAgentPersonality(witnessId);
        if (!witnessPers) continue;

        // Check if witness is friends with the victim
        let isVictimFriend = false;
        if (metadata.victimId != null) {
          const a = Math.min(witnessId, metadata.victimId);
          const b = Math.max(witnessId, metadata.victimId);
          const rel = db.select({ friendship_ab: relationships.friendship_ab, friendship_ba: relationships.friendship_ba })
            .from(relationships)
            .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
            .get();
          if (rel) {
            const friendship = witnessId === a ? rel.friendship_ab : rel.friendship_ba;
            isVictimFriend = friendship > 50;
          }
        }

        // Determine event sensitivity from rule effects
        const eventSensitivity =
          rule.effects.createFact ? 2 :
          rule.effects.emitEvent ? 2 :
          rule.effects.createState ? 1 : 0;

        const behaviors = this.witnessAmplifier.getWitnessBehaviors(witnessPers, {
          isVictimFriend,
          eventSensitivity,
        });

        if (behaviors.length > 0) {
          this.witnessAmplifier.applyBehaviors(
            witnessId,
            behaviors,
            metadata.victimId ?? null,
            metadata.perpetratorId ?? null,
            // source + payload: what the witness actually saw, for the rumor text.
            { ruleId: rule.id, chainId, locationId: metadata.locationId, source: rule.source, payload },
          );
        }
      }
    }
  }

  /**
   * Who a `createFact: 'rumor'` rule's rumor is about, and what it says, taken
   * from the event that fired the rule. Null when the event carries nothing to
   * say, and the caller keeps the old generic "There are rumors going around".
   *
   * Jealousy is special-cased: `jealousy_gossip` fires on the jealous agent's own
   * `state:triggered`, so the default subject was the jealous agent themself —
   * a rumor about the gossip, by the gossip. The state row knows the rival; with
   * no rival there is nobody to gossip about, so it returns 'skip' rather than
   * falling through to that self-rumor.
   */
  private describeRumor(
    rule: RippleRule,
    agentId: number,
    payload: any,
  ): { subjectId: number; targetId: number | null; context: FactContext | undefined } | 'skip' | null {
    if (rule.source === 'state:triggered' && payload?.state === 'jealous') {
      const jealous = db.select({ target: agentStates.target_agent_id, metadata: agentStates.metadata })
        .from(agentStates)
        .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, 'jealous')))
        .orderBy(desc(agentStates.started_at))
        .get();
      const meta = (jealous?.metadata ?? {}) as { rivalId?: number; loveInterestId?: number };
      const rivalId = meta.rivalId ?? jealous?.target ?? null;
      if (rivalId == null || rivalId === agentId) return 'skip';
      const loveId = meta.loveInterestId ?? null;
      return {
        subjectId: rivalId,
        targetId: loveId,
        context: jealousRumorContext(loveId != null ? getAgentName(loveId) : undefined),
      };
    }

    const seen = describeWitnessedAct(rule.source, payload, getAgentName);
    if (!seen) return null;
    return { subjectId: seen.actorId, targetId: seen.otherId, context: { detail: seen.act } };
  }

  // ─── DB helper methods ────────────────────────────────────────────────────────

  /**
   * The context a rule's filter and requirements are judged in.
   *
   * Every field is read on first use and then kept, instead of all up front:
   * the eager version cost 3-4 queries (clock, agent row, co-located agents,
   * perpetrator) per build, and most rules read one field or none — a `requires`
   * of `state: 'drunk'` only ever needed `getAgentStates`. Callers read the
   * context before firing anything (evaluateAndFire checks requirements before
   * executing effects), so a field read late sees what an eager read would have.
   */
  private buildContext(payload: any): RippleContext {
    const agentId = payload?._resolvedAgentId ?? payload?.agentId ?? 0;

    const agentRow = once(() => agentId
      ? db.select({ id: agents.id, current_location: agents.current_location, personality: agents.personality })
        .from(agents)
        .where(eq(agents.id, agentId))
        .get() ?? null
      : null);

    const targetAgent = once((): RippleContext['targetAgent'] => {
      const row = agentRow();
      return {
        id: row?.id ?? agentId,
        current_location: row?.current_location ?? null,
        personality: row?.personality as PersonalityProfile | null ?? null,
      };
    });

    // Agents at the target's location
    const agentsAtLocation = once((): RippleContext['agentsAtLocation'] => {
      const locationId = agentRow()?.current_location ?? null;
      if (locationId == null) return [];
      return db.select({ id: agents.id, personality: agents.personality })
        .from(agents)
        .where(and(eq(agents.current_location, locationId), eq(agents.is_active, true)))
        .all()
        .map(r => ({ id: r.id, personality: r.personality as PersonalityProfile | null }));
    });

    // Perpetrator info, if the event names someone other than the target
    const perpetratorAgent = once((): RippleContext['perpetratorAgent'] => {
      const perpetratorId = payload?.perpetratorId ?? payload?.agentId;
      if (!perpetratorId || perpetratorId === agentId) return undefined;
      const perpRow = db.select({ id: agents.id, current_location: agents.current_location })
        .from(agents)
        .where(eq(agents.id, perpetratorId))
        .get();
      return perpRow ? { id: perpRow.id, current_location: perpRow.current_location } : undefined;
    });

    const currentTick = once(() => this.getCurrentTick());

    return {
      get targetAgent() { return targetAgent(); },
      get perpetratorAgent() { return perpetratorAgent(); },
      get agentsAtLocation() { return agentsAtLocation(); },
      get currentTick() { return currentTick(); },
      getRelationship: (a: number, b: number) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const row = db.select({
          friendship_ab: relationships.friendship_ab,
          friendship_ba: relationships.friendship_ba,
          romance_ab: relationships.romance_ab,
          romance_ba: relationships.romance_ba,
          trust_ab: relationships.trust_ab,
          trust_ba: relationships.trust_ba,
          tags: relationships.tags,
        }).from(relationships)
          .where(and(eq(relationships.agent_a, lo), eq(relationships.agent_b, hi)))
          .get();
        if (!row) return null;
        return {
          friendship_ab: row.friendship_ab,
          friendship_ba: row.friendship_ba,
          romance_ab: row.romance_ab,
          romance_ba: row.romance_ba,
          trust_ab: row.trust_ab,
          trust_ba: row.trust_ba,
          tags: row.tags as string[],
        };
      },
      getAgentStates: (id: number) => {
        const rows = db.select({ type: agentStates.type })
          .from(agentStates)
          .where(eq(agentStates.agent_id, id))
          .all();
        return rows.map(r => r.type);
      },
      getAgentNeeds: (id: number) => {
        const row = db.select({
          mood: needs.mood,
          stress: needs.stress,
          hunger: needs.hunger,
          energy: needs.energy,
          social: needs.social,
        }).from(needs)
          .where(eq(needs.agent_id, id))
          .get();
        return row ?? { mood: 50, stress: 50, hunger: 50, energy: 50, social: 50 };
      },
      getAgentEconomy: (id: number) => {
        const row = db.select({
          money: economy.money,
          work_performance: economy.work_performance,
        }).from(economy)
          .where(eq(economy.agent_id, id))
          .get();
        return row ?? { money: 0, work_performance: 0 };
      },
    };
  }

  private getCurrentTick(): number {
    const world = db.select({ time: worldState.time }).from(worldState).limit(1).get();
    return (world?.time as any)?.totalTicks ?? 0;
  }

  private getAgentPersonality(id: number): PersonalityProfile | null {
    const row = db.select({ personality: agents.personality })
      .from(agents)
      .where(eq(agents.id, id))
      .get();
    return (row?.personality as PersonalityProfile | null) ?? null;
  }

  /** `mayRomanceGrow(feeler, target)` from the two agent rows; false if either is missing. */
  private mayRomanceGrowBetween(feelerId: number, targetId: number): boolean {
    const load = (id: number) => db
      .select({ age: agents.age, gender: agents.gender, orientation: agents.orientation })
      .from(agents)
      .where(eq(agents.id, id))
      .get();
    const feeler = load(feelerId);
    const target = load(targetId);
    return !!feeler && !!target && mayRomanceGrow(feeler, target);
  }

  private getAgentLocation(id: number): number | null {
    const row = db.select({ current_location: agents.current_location })
      .from(agents)
      .where(eq(agents.id, id))
      .get();
    return row?.current_location ?? null;
  }

  // ─── Execute effects ────────────────────────────────────────────────────────

  private executeEffects(
    rule: RippleRule,
    agentId: number,
    metadata: CascadeMetadata,
    payload: any,
  ): void {
    const fx = rule.effects;
    const currentTick = this.getCurrentTick();

    // createState
    if (fx.createState) {
      // Check if state already exists
      const existing = db.select({ id: agentStates.id })
        .from(agentStates)
        .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, fx.createState)))
        .get();

      if (!existing) {
        // States like `infatuated` and `jealous` are evaluated against the agent
        // they are *about*. Without a link they are unresolvable, so carry over
        // whoever this cascade was about.
        const aboutId = [metadata.victimId, metadata.perpetratorId]
          .find(id => id != null && id !== agentId) ?? null;

        db.insert(agentStates).values({
          agent_id: agentId,
          type: fx.createState,
          severity: 0.5,
          // Agent states run on game minutes (lib/states.ts).
          started_at: gameMinutesNow(),
          duration: 120,
          target_agent_id: aboutId,
          source: `cascade:${rule.id}`,
          metadata: { _cascade: { chainId: metadata.chainId, chainDepth: metadata.chainDepth, ruleId: rule.id } },
        }).run();

        // Log cascade-triggered state to activity feed with chainId
        const agentRow = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).get();
        const agentName = agentRow?.name ?? `Agent#${agentId}`;
        logActivity({
          type: 'state_gained',
          initiator: agentId,
          templateData: { agent: agentName, state: fx.createState },
          metadata: { chainId: metadata.chainId, chainDepth: metadata.chainDepth, ruleId: rule.id },
        });

        simEvents.emit('state:triggered', {
          agentId,
          state: fx.createState,
          cause: `cascade:${rule.id}`,
          // Carry the cast forward the way the `emitEvent` branch does. Without
          // these, every rule chaining off a cascade-created state saw no
          // perpetrator or victim, so `relationshipMin/Max`, `target:
          // 'perpetrator'` and `coLocatedWith: 'perpetrator'` could never match.
          perpetratorId: metadata.perpetratorId,
          victimId: metadata.victimId,
          _cascade: { chainId: metadata.chainId, chainDepth: metadata.chainDepth, parentRuleId: rule.id },
        });
      }
    }

    // clearState
    if (fx.clearState) {
      db.delete(agentStates)
        .where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, fx.clearState)))
        .run();
    }

    // createFact
    const rumor = fx.createFact === 'rumor' ? this.describeRumor(rule, agentId, payload) : null;
    if (rumor === 'skip') {
      // Nobody to talk about — no rumor at all.
    } else if (rumor) {
      // Only the teller knows it at first; the rumor is theirs to spread.
      createFact('rumor', rumor.subjectId, rumor.targetId, 2, [agentId], `cascade:${rule.id}`, rumor.context);
    } else if (fx.createFact && rule.target === 'witness') {
      // A witness report (theft_witness_report, arrest_gossip,
      // confrontation_witness_gossip) is about what the witness saw someone
      // else do. The generic branch below made the *witness* the subject —
      // "Ray was caught stealing from Priya" when Ray only watched — and the
      // own-secret gossip filter then stopped Ray from telling anyone.
      const subjectId = metadata.perpetratorId;
      if (subjectId != null && subjectId !== agentId) {
        const otherId = metadata.victimId != null && metadata.victimId !== subjectId ? metadata.victimId : null;
        createFact(
          fx.createFact,
          subjectId,
          otherId,
          2,
          [agentId, subjectId, ...(otherId != null ? [otherId] : [])],
          `cascade:${rule.id}`,
        );
      }
    } else if (fx.createFact) {
      const targetId = metadata.perpetratorId ?? metadata.victimId ?? null;
      createFact(
        fx.createFact,
        agentId,
        targetId ?? null,
        2,
        [agentId, ...(targetId != null ? [targetId] : [])],
        `cascade:${rule.id}`,
      );
    }

    // emitEvent
    if (fx.emitEvent) {
      // Every emitting rule describes something the rule's agent does — a
      // lash-out, a confrontation, begging, a drunken scene — so the agent is
      // the new event's perpetrator and the other party its victim. Copying the
      // parent chain's cast instead sent anger_lash_out's confrontation (Y
      // lashing out after X's insult) with perpetratorId X, and every rule
      // downstream treated the insulter as the aggressor of Y's outburst.
      const emitPayload = {
        ...(fx.emitPayload ?? {}),
        agentId,
        perpetratorId: agentId,
        victimId: otherParty(metadata, agentId),
        locationId: metadata.locationId,
        _cascade: { chainId: metadata.chainId, chainDepth: metadata.chainDepth, parentRuleId: rule.id },
      };
      simEvents.emit(fx.emitEvent, emitPayload);
    }

    // moodDelta
    if (fx.moodDelta) {
      const row = db.select({ mood: needs.mood }).from(needs).where(eq(needs.agent_id, agentId)).get();
      if (row) {
        const newMood = Math.max(0, Math.min(100, row.mood + fx.moodDelta));
        db.update(needs).set({ mood: newMood }).where(eq(needs.agent_id, agentId)).run();
      }
    }

    // stressDelta
    if (fx.stressDelta) {
      const row = db.select({ stress: needs.stress }).from(needs).where(eq(needs.agent_id, agentId)).get();
      if (row) {
        const newStress = Math.max(0, Math.min(100, row.stress + fx.stressDelta));
        db.update(needs).set({ stress: newStress }).where(eq(needs.agent_id, agentId)).run();
      }
    }

    // relationshipDelta
    if (fx.relationshipDelta) {
      // The other party, not whoever is listed first: `perpetratorId` falls
      // back to the acting agent when an event names no perpetrator, and
      // `perpetratorId ?? victimId` then picked the agent themself and skipped
      // the delta — e.g. protect_gratitude never reached the protected person.
      const targetId = otherParty(metadata, agentId);
      if (targetId != null) {
        const a = Math.min(agentId, targetId);
        const b = Math.max(agentId, targetId);
        const isA = agentId === a;

        const rel = db.select().from(relationships)
          .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
          .get();

        if (rel) {
          const field = fx.relationshipDelta.field;
          const delta = fx.relationshipDelta.value;

          // Apply delta from agentId's perspective toward targetId
          const updateData: Record<string, number> = {};
          if (field === 'friendship') {
            const col = isA ? 'friendship_ab' : 'friendship_ba';
            const current = isA ? rel.friendship_ab : rel.friendship_ba;
            updateData[col] = Math.max(-100, Math.min(100, current + delta));
          } else if (field === 'romance') {
            const col = isA ? 'romance_ab' : 'romance_ba';
            const current = isA ? rel.romance_ab : rel.romance_ba;
            // The romance choke point (engine/systems/relationships.ts) covers
            // queued relationship events, but this rule writes the column
            // directly, so the adults-only rule is asked here too: a rise is
            // dropped unless the feeler may grow romance toward the target.
            // A drop always lands (a bad turn still cools a crush), and a
            // missing agent row fails closed.
            if (delta <= 0 || this.mayRomanceGrowBetween(agentId, targetId)) {
              updateData[col] = Math.max(-100, Math.min(100, current + delta));
            }
          } else if (field === 'trust') {
            const col = isA ? 'trust_ab' : 'trust_ba';
            const current = isA ? rel.trust_ab : rel.trust_ba;
            updateData[col] = Math.max(-100, Math.min(100, current + delta));
          }

          if (Object.keys(updateData).length > 0) {
            db.update(relationships)
              .set(updateData)
              .where(and(eq(relationships.agent_a, a), eq(relationships.agent_b, b)))
              .run();
          }
        }
      }
    }

    // economyEffect
    if (fx.economyEffect) {
      const row = db.select().from(economy).where(eq(economy.agent_id, agentId)).get();
      if (row) {
        const field = fx.economyEffect.field;
        const delta = fx.economyEffect.delta;
        const current = (row as any)[field] as number;
        const newValue = Math.max(0, current + delta);
        db.update(economy)
          .set({ [field]: newValue })
          .where(eq(economy.agent_id, agentId))
          .run();
      }
    }

    // setDestination
    if (fx.setDestination) {
      if (fx.setDestination === 'home') {
        const agentRow = db.select({ home: agents.home }).from(agents).where(eq(agents.id, agentId)).get();
        if (agentRow) {
          // Set destination to home location
          // We need the location's entry point
          const loc = db.select({ entry_point: locations.entry_point }).from(locations).where(eq(locations.id, agentRow.home)).get();
          if (loc) {
            const entryPoint = loc.entry_point as { x: number; y: number };
            db.update(agents)
              .set({ current_destination: { x: entryPoint.x, y: entryPoint.y, locationId: agentRow.home } })
              .where(eq(agents.id, agentId))
              .run();
          }
        }
      }
      // 'away_from_trigger' — just clear destination, movement system will handle idle behavior
      if (fx.setDestination === 'away_from_trigger') {
        db.update(agents)
          .set({ current_destination: null })
          .where(eq(agents.id, agentId))
          .run();
      }
    }

    // createGoal
    if (fx.createGoal) {
      let targetId: number | undefined;
      if (fx.createGoal.targetAgent === 'perpetrator') {
        targetId = metadata.perpetratorId;
      } else if (fx.createGoal.targetAgent === 'victim') {
        targetId = metadata.victimId;
      } else if (fx.createGoal.targetAgent === 'random') {
        // Random agent at location
        const locId = metadata.locationId;
        if (locId != null) {
          const atLoc = this.getAgentsAtLocation(locId).filter(id => id !== agentId);
          if (atLoc.length > 0) {
            targetId = atLoc[Math.floor(Math.random() * atLoc.length)];
          }
        }
      }

      db.insert(goals).values({
        agent_id: agentId,
        type: fx.createGoal.type,
        target_id: targetId,
        motivation: `cascade:${rule.id}`,
        priority: 0.6,
        progress: 0,
        status: 'active',
        created_at: gameMinutesNow(), // goals run on game minutes (systems/goals.ts)
      }).run();

      simEvents.emit('goal:created', {
        agentId,
        goalType: fx.createGoal.type,
        targetId: targetId ?? null,
      });
    }

    // tensionDelta
    if (fx.tensionDelta && this.tensionTracker) {
      // Who the grievance is about, when the event names someone else: the
      // Brewing panel says "Mara ... mostly about Jonas" from this.
      const about = otherPartyName(metadata, agentId);
      this.tensionTracker.addTension(agentId, fx.tensionDelta, {
        event: rule.source,
        description: `${rule.id} triggered`,
        tick: currentTick,
        ...(about ? { agentInvolved: about } : {}),
      });
    }
  }
}
