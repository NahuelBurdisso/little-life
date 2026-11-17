import { db } from '../db';
import { agents, needs, relationships, agentStates } from '../db/schema';
import { eq } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { getEffectivePersonality } from './states';

// ─── Loneliness Engine ────────────────────────────────────────────────────────
// Tracks chronic low social need. When social stays < 20 for extended periods,
// the agent enters 'lonely' state. A warm friend may then schedule a comfort
// visit: decisions/phases.ts walks the visitor to the lonely agent and, once they are
// together, queues a conversation (see getComfortVisit).

const lonelySince = new Map<number, number>(); // agentId → game minute when social first dropped below 20
const LONELY_THRESHOLD = 20;
const LONELY_DURATION_MINUTES = 720; // 12 game hours of consecutive low social

/** How long a scheduled visit stays on the visitor's agenda (3 game hours). */
export const COMFORT_VISIT_WINDOW_MINUTES = 180;

interface ComfortVisit {
  lonelyAgentId: number;
  expiresAt: number;
}
/** visitorId → the visit they have promised to make. */
const pendingComfortVisits = new Map<number, ComfortVisit>();

export function scheduleComfortVisit(visitorId: number, lonelyAgentId: number, nowMinutes: number): void {
  pendingComfortVisits.set(visitorId, { lonelyAgentId, expiresAt: nowMinutes + COMFORT_VISIT_WINDOW_MINUTES });
}

/** The visitor's pending visit, or null (expired visits are dropped here). */
export function getComfortVisit(visitorId: number, nowMinutes: number): ComfortVisit | null {
  const visit = pendingComfortVisits.get(visitorId);
  if (!visit) return null;
  if (nowMinutes > visit.expiresAt) {
    pendingComfortVisits.delete(visitorId);
    return null;
  }
  return visit;
}

/** Called when the visit's conversation is queued, or when it can no longer happen. */
export function completeComfortVisit(visitorId: number): void {
  pendingComfortVisits.delete(visitorId);
}

/** Drop per-agent loneliness tracking for a world replace (agent ids and the clock both reset). */
export function clearLonelinessTracking(): void {
  lonelySince.clear();
  pendingComfortVisits.clear();
}

/**
 * Called once per game hour from the tick loop. CLOCK: `nowMinutes` and every
 * stamp in this module are GAME MINUTES; they were ticks, so at 4x the 12-hour
 * lonely streak took two game days and a comfort visit's window stretched to 12
 * hours.
 */
export function lonelinessCheck(nowMinutes: number): void {
  const allNeeds = db.select().from(needs).all();
  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const allStates = db.select().from(agentStates).all();

  for (const agentNeeds of allNeeds) {
    const agent = activeAgents.find(a => a.id === agentNeeds.agent_id);
    if (!agent) continue;

    // Check if already lonely
    const hasLonelyState = allStates.some(
      s => s.agent_id === agent.id && s.type === 'lonely'
    );

    if (agentNeeds.social < LONELY_THRESHOLD) {
      const since = lonelySince.get(agent.id);
      if (!since) {
        lonelySince.set(agent.id, nowMinutes);
      } else if (nowMinutes - since > LONELY_DURATION_MINUTES && !hasLonelyState) {
        // Agent has been lonely long enough — create lonely state
        db.insert(agentStates).values({
          agent_id: agent.id,
          type: 'lonely',
          severity: Math.min(1.0, (LONELY_THRESHOLD - agentNeeds.social) / LONELY_THRESHOLD),
          // agentStates.started_at is in game minutes: states.ts expires with
          // `started_at + duration <= nowMinutes`.
          started_at: nowMinutes,
          duration: 2880, // 2 game days
          source: 'chronic_low_social',
          metadata: null,
        }).run();

        logActivity({
          type: 'drama',
          initiator: agent.id,
          templateData: { description: `${agent.name} has become lonely and withdrawn` },
          metadata: { beat: 'lonely' },
        });

        // Trigger warm neighbor intervention
        triggerComfortVisit(agent.id, activeAgents, nowMinutes);
      }
    } else {
      // Social is above threshold — reset tracker
      lonelySince.delete(agent.id);
    }
  }
}

function triggerComfortVisit(
  lonelyAgentId: number,
  allAgents: (typeof agents.$inferSelect)[],
  nowMinutes: number,
): void {
  // Find warm agents with positive relationship who might visit
  const rels = db.select().from(relationships).all();

  for (const other of allAgents) {
    if (other.id === lonelyAgentId || !other.is_active) continue;

    const personality = getEffectivePersonality(other.id);
    if (!personality || personality.warmth < 50) continue;

    // Check if they have any relationship
    const a = Math.min(other.id, lonelyAgentId);
    const b = Math.max(other.id, lonelyAgentId);
    const rel = rels.find(r => r.agent_a === a && r.agent_b === b);
    if (!rel) continue;

    const isA = a === other.id;
    const friendship = isA ? rel.friendship_ab : rel.friendship_ba;
    if (friendship < 10) continue; // need at least basic positive regard

    // Probability based on warmth and friendship
    const visitChance = personality.warmth * 0.005 + friendship * 0.003;
    if (Math.random() > visitChance) continue;

    // Used to be log-only: the feed announced a visit nobody ever made.
    scheduleComfortVisit(other.id, lonelyAgentId, nowMinutes);
    const visitorName = other.name;
    const lonelyAgent = allAgents.find(a => a.id === lonelyAgentId);
    const lonelyName = lonelyAgent?.name ?? 'someone';

    logActivity({
      type: 'drama',
      initiator: other.id,
      target: lonelyAgentId,
      templateData: { description: `${visitorName} noticed ${lonelyName} seems lonely and decided to visit` },
      metadata: { beat: 'lonely' },
    });

    break; // Only one visitor at a time
  }
}
