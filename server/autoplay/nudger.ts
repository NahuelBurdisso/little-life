import { db } from '../db';
import {
  agents, needs, relationships, conversationQueue, locations,
  shared_knowledge, worldEvents, worldState,
} from '../db/schema';
import { eq } from 'drizzle-orm';
import { CONFIG } from '../lib/constants';
import type { Diagnosis, NudgeAction, AnalysisWindow } from './types';
import { startWorldEvent } from '../engine/systems/events';
import { isWorldEventType } from '../data/worldEventCatalog';

const SEVERITY_ORDER: Record<string, number> = {
  critical: 4, high: 3, medium: 2, low: 1,
};

/**
 * conversations.ts drops queued entries whose participants are neither at the
 * same location nor within this many pixels of each other, so pairs must be
 * selected with the same rule or the nudge is silently discarded.
 */
const PROXIMITY_PX = 64;

interface AgentPlacement {
  location: number | null;
  x: number;
  y: number;
}

export class SmartNudger {
  private nudgesToday = 0;
  private lastNudgeTick = 0;
  private currentDay = 0;
  private cooldownTicks = 120; // ~2 game hours

  /**
   * Drop the tick/day cursors. Required when the world is wiped: totalTicks
   * restarts at 0, so a surviving lastNudgeTick makes the cooldown check
   * `window.startTick - lastNudgeTick < cooldownTicks` true for hours,
   * silently disabling every nudge.
   */
  reset() {
    this.nudgesToday = 0;
    this.lastNudgeTick = 0;
    this.currentDay = 0;
  }

  async applyNudges(
    diagnoses: Diagnosis[],
    window: AnalysisWindow,
  ): Promise<NudgeAction[]> {
    // Reset daily counter
    if (window.day !== this.currentDay) {
      this.nudgesToday = 0;
      this.currentDay = window.day;
    }

    if (this.nudgesToday >= CONFIG.AUTOPLAY.MAX_NUDGES_PER_DAY) return [];
    if (window.startTick - this.lastNudgeTick < this.cooldownTicks) return [];

    const fixable = diagnoses
      .filter(d => d.autoFixable)
      .sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);

    if (fixable.length === 0) return [];

    const target = fixable[0];
    const action = this.buildNudge(target, window);
    if (!action) return [];

    this.execute(action);
    this.nudgesToday++;
    this.lastNudgeTick = window.startTick;
    return [action];
  }

  private buildNudge(diag: Diagnosis, window: AnalysisWindow): NudgeAction | null {
    const now = Date.now();

    switch (diag.type) {
      case 'conversation_drought': {
        const pair = this.findBestConversationPair();
        if (!pair) return null;
        return {
          type: 'suggest_talk',
          reason: diag.evidence,
          params: { agentA: pair.a, agentB: pair.b },
          timestamp: now,
        };
      }

      case 'drama_desert':
      case 'mood_flatline': {
        const eventType = this.pickEvent(window);
        return {
          type: 'trigger_event',
          reason: diag.evidence,
          params: { eventType },
          timestamp: now,
        };
      }

      case 'social_stagnation': {
        const tense = this.findTensePair();
        if (tense) {
          return {
            type: 'force_confront',
            reason: diag.evidence,
            params: { agentA: tense.a, agentB: tense.b },
            timestamp: now,
          };
        }
        const weak = this.findWeakPositiveTie();
        if (weak) {
          return {
            type: 'suggest_talk',
            reason: diag.evidence,
            params: { agentA: weak.a, agentB: weak.b },
            timestamp: now,
          };
        }
        return null;
      }

      case 'dead_zone': {
        const loc = this.findDeadLocation(window);
        const agent = this.findCuriousIdleAgent();
        if (!loc || !agent) return null;
        return {
          type: 'suggest_go_to',
          reason: diag.evidence,
          params: { agentId: agent, locationId: loc },
          timestamp: now,
        };
      }

      case 'spatial_monoculture': {
        return {
          type: 'trigger_event',
          reason: diag.evidence,
          params: { eventType: 'festival' },
          timestamp: now,
        };
      }

      case 'conversation_sameness': {
        const secret = this.findUntoldSecret();
        const socialAgent = this.findSocialAgent();
        if (!secret || !socialAgent) return null;
        return {
          type: 'tell_secret',
          reason: diag.evidence,
          params: { factId: secret, agentId: socialAgent },
          timestamp: now,
        };
      }

      case 'isolation_spiral': {
        const orphanId = diag.affectedAgents?.[0];
        if (!orphanId) return null;
        const warm = this.findWarmAgent(orphanId);
        if (!warm) return null;
        return {
          type: 'suggest_talk',
          reason: diag.evidence,
          params: { agentA: orphanId, agentB: warm },
          timestamp: now,
        };
      }

      case 'economic_stasis': {
        return {
          type: 'trigger_event',
          reason: diag.evidence,
          params: { eventType: 'market_day' },
          timestamp: now,
        };
      }

      default:
        return null;
    }
  }

  private execute(action: NudgeAction) {
    try {
      const world = db.select().from(worldState).limit(1).get();
      const tick = world?.time?.totalTicks ?? 0;

      switch (action.type) {
        case 'suggest_talk': {
          const { agentA, agentB } = action.params;
          if (this.queueIsFull()) break;
          // Queue conversation directly
          db.insert(conversationQueue).values({
            participants: [agentA, agentB],
            tier: 'llm_deep',
            priority: CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY - 10, // slightly below player
            trigger_reason: `autoplay:${action.reason.slice(0, 50)}`,
            topic: null,
            queued_at: Date.now(),
            max_wait: CONFIG.CONVERSATIONS.PLAYER_NUDGE_MAX_WAIT_MS,
          }).run();
          break;
        }

        case 'trigger_event': {
          const { eventType } = action.params;
          // Same path as a player trigger: catalog duration/effects and the
          // duplicate/concurrency limits. This used to insert `effects: {}` with
          // `duration: 120` — 120 game hours, not the 2 its comment claimed.
          if (isWorldEventType(eventType)) startWorldEvent(eventType, { triggeredBy: 'autoplay' });
          break;
        }

        case 'force_confront': {
          const { agentA, agentB } = action.params;
          if (this.queueIsFull()) break;
          db.insert(conversationQueue).values({
            participants: [agentA, agentB],
            tier: 'llm_deep',
            // Stays below PLAYER_NUDGE_PRIORITY so real player nudges always win.
            priority: CONFIG.CONVERSATIONS.PLAYER_NUDGE_PRIORITY - 10,
            trigger_reason: `autoplay:confrontation`,
            topic: 'confrontation',
            queued_at: Date.now(),
            max_wait: CONFIG.CONVERSATIONS.PLAYER_NUDGE_MAX_WAIT_MS,
          }).run();
          break;
        }

        case 'suggest_go_to': {
          const { agentId, locationId } = action.params;
          const loc = db.select({
            entry_point: locations.entry_point,
          }).from(locations).where(eq(locations.id, locationId)).get();
          if (!loc) break;
          const entry = loc.entry_point as { x: number; y: number };
          // Mirrors routers/nudge.ts suggest_go_to: the stale path must be cleared
          // or movement.ts keeps walking the agent to its previous destination.
          // action_queue is deliberately left intact so the agent keeps its plan.
          db.update(agents).set({
            current_action: { type: 'walking', to: { x: entry.x, y: entry.y } },
            current_destination: { x: entry.x, y: entry.y, locationId },
            current_path: null,
            action_started: tick,
            action_duration: null,
          }).where(eq(agents.id, agentId)).run();
          break;
        }

        case 'tell_secret': {
          const { factId, agentId } = action.params;
          const fact = db.select({
            known_by: shared_knowledge.known_by,
          }).from(shared_knowledge).where(eq(shared_knowledge.id, factId)).get();
          if (!fact) break;
          const knownBy = fact.known_by as number[];
          if (!knownBy.includes(agentId)) {
            db.update(shared_knowledge).set({
              known_by: [...knownBy, agentId],
            }).where(eq(shared_knowledge.id, factId)).run();
          }
          break;
        }
      }
    } catch (err) {
      console.warn(`[autoplay] Nudge execution failed:`, (err as Error).message);
    }
  }

  // ── Helper queries ──────────────────────────────────────────────────────

  private queueIsFull(): boolean {
    const depth = db.select({ id: conversationQueue.id }).from(conversationQueue).all().length;
    return depth >= CONFIG.CONVERSATIONS.MAX_QUEUE_SIZE;
  }

  private loadPlacements(): Map<number, AgentPlacement> {
    const rows = db.select({
      id: agents.id,
      current_location: agents.current_location,
      position: agents.position,
    }).from(agents).where(eq(agents.is_active, true)).all();

    return new Map(rows.map(r => {
      const p = r.position as { x: number; y: number };
      return [r.id, { location: r.current_location, x: p.x, y: p.y }] as const;
    }));
  }

  private areCoLocated(
    placements: Map<number, AgentPlacement>, a: number, b: number,
  ): boolean {
    const pa = placements.get(a);
    const pb = placements.get(b);
    if (!pa || !pb) return false;
    if (pa.location != null && pa.location === pb.location) return true;
    // The conversation scheduler needs a non-null location to open a conversation
    // and SKIPS (rather than deletes) an entry that has none, so a pair that is
    // merely close but both outdoors would sit in the queue until max_wait.
    if (pa.location == null && pb.location == null) return false;
    const dx = pa.x - pb.x;
    const dy = pa.y - pb.y;
    return dx * dx + dy * dy <= PROXIMITY_PX * PROXIMITY_PX;
  }

  private findBestConversationPair(): { a: number; b: number } | null {
    // Find two active agents with highest social need who aren't talking.
    // The social need value is inverted: a LOW `needs.social` means the agent is
    // starved of company, so candidates are sorted ascending.
    const candidates = db.select({
      id: agents.id,
      current_action: agents.current_action,
    }).from(agents).where(eq(agents.is_active, true)).all()
      .filter(a => (a.current_action as any)?.type !== 'talking' && (a.current_action as any)?.type !== 'sleeping');

    if (candidates.length < 2) return null;

    // Get social needs
    const agentNeeds = db.select({
      agent_id: needs.agent_id,
      social: needs.social,
    }).from(needs).all();

    const needMap = new Map(agentNeeds.map(n => [n.agent_id, n.social]));
    const sorted = candidates.sort((a, b) => (needMap.get(a.id) ?? 50) - (needMap.get(b.id) ?? 50));

    const placements = this.loadPlacements();
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (this.areCoLocated(placements, sorted[i].id, sorted[j].id)) {
          return { a: sorted[i].id, b: sorted[j].id };
        }
      }
    }
    return null;
  }

  private findTensePair(): { a: number; b: number } | null {
    const rels = db.select({
      agent_a: relationships.agent_a,
      agent_b: relationships.agent_b,
      friendship_ab: relationships.friendship_ab,
      friendship_ba: relationships.friendship_ba,
      tags: relationships.tags,
    }).from(relationships).all();

    const placements = this.loadPlacements();
    let bestPair: { a: number; b: number } | null = null;
    let worstFriendship = 0;

    for (const r of rels) {
      if (!this.areCoLocated(placements, r.agent_a, r.agent_b)) continue;
      const tension = -(r.friendship_ab + r.friendship_ba) / 2;
      const hasGrudge = (r.tags as string[]).includes('grudge');
      const score = tension + (hasGrudge ? 20 : 0);
      if (score > worstFriendship) {
        worstFriendship = score;
        bestPair = { a: r.agent_a, b: r.agent_b };
      }
    }

    return worstFriendship > 10 ? bestPair : null;
  }

  private findWeakPositiveTie(): { a: number; b: number } | null {
    const rels = db.select({
      agent_a: relationships.agent_a,
      agent_b: relationships.agent_b,
      friendship_ab: relationships.friendship_ab,
      interaction_count: relationships.interaction_count,
    }).from(relationships).all();

    // Weak but positive: low interaction count, mild positive friendship
    const placements = this.loadPlacements();
    let best: { a: number; b: number } | null = null;
    let bestScore = -1;

    for (const r of rels) {
      if (!this.areCoLocated(placements, r.agent_a, r.agent_b)) continue;
      if (r.friendship_ab > 5 && r.friendship_ab < 40 && r.interaction_count < 5) {
        const score = r.friendship_ab - r.interaction_count * 2;
        if (score > bestScore) {
          bestScore = score;
          best = { a: r.agent_a, b: r.agent_b };
        }
      }
    }
    return best;
  }

  private findDeadLocation(window: AnalysisWindow): number | null {
    const locs = db.select({
      id: locations.id,
      current_occupants: locations.current_occupants,
      operating_hours: locations.operating_hours,
    }).from(locations).all();

    for (const loc of locs) {
      const occ = (loc.current_occupants as number[]).length;
      const hours = loc.operating_hours as { open: number; close: number } | null;
      if (occ === 0 && (!hours || (window.gameHour >= hours.open && window.gameHour < hours.close))) {
        return loc.id;
      }
    }
    return null;
  }

  private findCuriousIdleAgent(): number | null {
    const idle = db.select({
      id: agents.id,
      personality: agents.personality,
      current_action: agents.current_action,
    }).from(agents).where(eq(agents.is_active, true)).all()
      .filter(a => {
        const type = (a.current_action as any)?.type;
        return type === 'idle' || type === 'socializing';
      });

    if (idle.length === 0) return null;

    // Pick most curious
    let bestId = idle[0].id;
    let bestCuriosity = 0;
    for (const a of idle) {
      const curiosity = (a.personality as any)?.curiosity ?? 50;
      if (curiosity > bestCuriosity) {
        bestCuriosity = curiosity;
        bestId = a.id;
      }
    }
    return bestId;
  }

  private findUntoldSecret(): number | null {
    const facts = db.select({
      id: shared_knowledge.id,
      known_by: shared_knowledge.known_by,
      sensitivity: shared_knowledge.sensitivity,
    }).from(shared_knowledge).where(eq(shared_knowledge.is_active, true)).all();

    // Find fact known by fewest agents + high sensitivity
    let bestId: number | null = null;
    let bestScore = -1;
    for (const f of facts) {
      const knownCount = (f.known_by as number[]).length;
      const score = f.sensitivity * 10 - knownCount;
      if (score > bestScore && knownCount < 5) {
        bestScore = score;
        bestId = f.id;
      }
    }
    return bestId;
  }

  private findSocialAgent(): number | null {
    const activeAgents = db.select({
      id: agents.id,
      personality: agents.personality,
      current_action: agents.current_action,
    }).from(agents).where(eq(agents.is_active, true)).all()
      .filter(a => (a.current_action as any)?.type !== 'sleeping');

    if (activeAgents.length === 0) return null;

    let bestId = activeAgents[0].id;
    let bestWarmth = 0;
    for (const a of activeAgents) {
      const warmth = (a.personality as any)?.warmth ?? 50;
      if (warmth > bestWarmth) {
        bestWarmth = warmth;
        bestId = a.id;
      }
    }
    return bestId;
  }

  private findWarmAgent(excludeId: number): number | null {
    const placements = this.loadPlacements();
    const activeAgents = db.select({
      id: agents.id,
      personality: agents.personality,
      current_action: agents.current_action,
    }).from(agents).where(eq(agents.is_active, true)).all()
      .filter(a => a.id !== excludeId
        && (a.current_action as any)?.type !== 'sleeping'
        && this.areCoLocated(placements, excludeId, a.id));

    if (activeAgents.length === 0) return null;

    let bestId = activeAgents[0].id;
    let bestWarmth = 0;
    for (const a of activeAgents) {
      const warmth = (a.personality as any)?.warmth ?? 50;
      if (warmth > bestWarmth) {
        bestWarmth = warmth;
        bestId = a.id;
      }
    }
    return bestId;
  }

  private pickEvent(window: AnalysisWindow): string {
    // Check what's already active
    const active = db.select({ type: worldEvents.type }).from(worldEvents)
      .where(eq(worldEvents.is_active, true)).all().map(e => e.type);

    const candidates = ['festival', 'storm', 'competition', 'market_day', 'traveling_merchant']
      .filter(e => !active.includes(e));

    if (candidates.length === 0) return 'festival';

    // Weighted by time of day
    if (window.dayPhase === 'evening') {
      const pref = candidates.find(c => c === 'festival') || candidates[0];
      return pref;
    }
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
}
