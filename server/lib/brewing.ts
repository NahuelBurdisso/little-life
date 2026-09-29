/**
 * Brewing — what is about to boil over in the town. Suspense is what keeps a
 * spectator watching, but every source of it was invisible: snap tension lived
 * only inside the cascade's `TensionTracker`, a secret's spread only in
 * `shared_knowledge.known_by`, a queued confrontation only in the scheduler's
 * table. The player found out afterwards, from the feed. This is a read layer
 * over those private states that says "this one is close" *before* it goes off.
 *
 * Pure read layer like `chronicle.ts`: no tables, no tick-loop participation.
 * `buildBrewing` works on plain rows so thresholds, ordering and the
 * no-spoilers rule can be tested on fixtures; `getBrewing` does the queries.
 *
 * Two rules the wording follows:
 *   - Never reveal *what* a secret is. Only that one exists about X and how far
 *     it has travelled ("2 of 13 people know"); the content, its type and the
 *     topic of a queued "reveal" are all withheld. The player who wants the
 *     content can open the agent — this list is a teaser, not a spoiler.
 *   - Heat is comparable across kinds (0..1) so one sorted list can mix a
 *     resident three points from snapping with a goal at 70%. A snap is the
 *     town's biggest release, so it owns the top of the scale; a couple that
 *     might flip status owns the bottom.
 */

import { db } from '../db';
import { agents, conversationQueue, goals, relationships, shared_knowledge } from '../db/schema';
import { eq } from 'drizzle-orm';
import { getTensionSnapshot, type TensionSnapshotEntry } from './cascade';
import { snapThreshold } from './cascade/TensionTracker';
import type { PersonalityProfile } from './personality';
import { isCommonKnowledge } from '../engine/systems/gossipEngine';

export type BrewingKind = 'snap' | 'secret' | 'confrontation' | 'nudge' | 'goal' | 'relationship';

export interface BrewingItem {
  /** Stable across recomputes so the UI can key rows and animate heat. */
  id: string;
  kind: BrewingKind;
  /** Residents involved, the one to focus first. */
  agentIds: number[];
  /** One human sentence. Never contains a secret's content. */
  text: string;
  /** 0..1, comparable across kinds; sorts the list. */
  heat: number;
  /** Snap only: what is getting to them, newest first, already human wording. */
  sources?: string[];
}

/** A resident is worth showing once tension reaches this share of their snap threshold. */
export const SNAP_WATCH_RATIO = 0.7;
/** A goal is "close" from this progress on. */
export const GOAL_CLOSE_PROGRESS = 0.7;
/** Only secrets at least this sensitive are juicy (1 is public by construction). */
const JUICY_SENSITIVITY = 2;
/** How close (in the metric's own points) a couple has to be to a status flip to show. */
const FLIP_MARGIN = 6;
const MAX_ITEMS = 12;
const MAX_SOURCES = 3;

/**
 * Cascade tension sources are keyed by the event that fed them; these are the
 * same events turned into something a spectator would say. Unknown events fall
 * back to their own name with the punctuation stripped, so a new ripple rule
 * shows up as roughly-right rather than missing.
 */
const SOURCE_PHRASES: Record<string, string> = {
  'economy:theft_caught': 'a theft that came to light',
  'economy:theft_success': 'a theft they got away with',
  'economy:distress': 'money trouble',
  'economy:gambling': 'gambling losses',
  'economy:blackmail_paid': 'blackmail',
  'crime:arrested': 'an arrest',
  'confrontation:occurred': 'a heated confrontation',
  'jealousy:triggered': 'jealousy',
  'conversation:ended': 'a conversation that left a mark',
  'interaction:completed': 'a run-in with someone',
  'gossip:learned': 'gossip that reached them',
  'secret:shared': 'a secret being passed around',
  'relationship:changed': 'a relationship shifting',
  'perception:observed': 'something they saw',
  'goal:abandoned': 'a goal they gave up on',
  'goal:completed': 'a goal that changed everything',
  'goal:ambition_shifted': 'an ambition falling apart',
  'state:triggered': 'stress piling up',
  'need:critical': 'needs going unmet',
  'agent:birthday': 'a birthday',
};

function sourcePhrase(event: string): string {
  return SOURCE_PHRASES[event] ?? event.replace(/[:_]+/g, ' ');
}

/** "a, b and c" — a snap card lists up to three grievances. */
function joinList(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Phrasing for the goal types the game generates; anything else uses its own name. */
const GOAL_PHRASES: Record<string, (target: string | null) => string> = {
  befriend: (t) => (t ? `befriending ${t}` : 'making a friend'),
  revenge: (t) => (t ? `getting revenge on ${t}` : 'getting revenge'),
  seduce: (t) => (t ? `winning over ${t}` : 'winning someone over'),
  steal_from: (t) => (t ? `stealing from ${t}` : 'a big score'),
  investigate: (t) => (t ? `getting to the bottom of ${t}` : 'getting to the bottom of something'),
  protect: (t) => (t ? `protecting ${t}` : 'protecting someone'),
};

function goalPhrase(g: BrewingInput['goals'][number], targetName: string | null): string {
  const known = GOAL_PHRASES[g.type];
  if (known) return known(targetName);
  // Free-form goals carry their meaning in the description; cap it so one
  // rambling LLM sentence cannot blow up the row.
  if (g.type === 'custom' && g.description) {
    return g.description.length > 80 ? `${g.description.slice(0, 77)}...` : g.description;
  }
  return g.type.replace(/_/g, ' ');
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export interface BrewingInput {
  /** Living residents only. */
  agents: { id: number; name: string; personality: PersonalityProfile | null }[];
  tension: TensionSnapshotEntry[];
  secrets: {
    id: number;
    subject_id: number;
    sensitivity: number;
    known_by: number[];
    is_public: boolean;
    is_active: boolean;
  }[];
  queue: { id: number; participants: number[]; trigger_reason: string; topic: string | null }[];
  goals: {
    id: number;
    agent_id: number;
    type: string;
    target_id: number | null;
    description: string | null;
    progress: number;
    status: string;
  }[];
  relationships: {
    agent_a: number;
    agent_b: number;
    friendship_ab: number;
    friendship_ba: number;
    romance_ab: number;
    romance_ba: number;
    status: string;
  }[];
}

/**
 * Where a couple's status flips (mirrors `deriveStatus` in
 * engine/systems/relationships.ts). Each check returns how many points short of
 * the flip the pair is, or null when the rule doesn't apply — the closest gap
 * within `FLIP_MARGIN` wins so a pair produces at most one row.
 */
function nearestFlip(
  r: BrewingInput['relationships'][number],
): { gap: number; text: (a: string, b: string) => string } | null {
  if (r.status === 'estranged') return null; // the one status that never lifts
  const avgF = (r.friendship_ab + r.friendship_ba) / 2;
  const maxR = Math.max(r.romance_ab, r.romance_ba);
  const minR = Math.min(r.romance_ab, r.romance_ba);
  const candidates: { gap: number; text: (a: string, b: string) => string }[] = [];

  // Sparks: one side is almost past the romantic-interest line.
  if (maxR <= 30 && 30 - maxR <= FLIP_MARGIN && maxR > 0) {
    candidates.push({ gap: 30 - maxR, text: (a, b) => `Something is about to spark between ${a} and ${b}` });
  }
  // Both sides nearly in love and getting along: one push from being a couple.
  if (minR <= 70 && 70 - minR <= FLIP_MARGIN && maxR > 30 && avgF > 30) {
    candidates.push({ gap: 70 - minR, text: (a, b) => `${a} and ${b} are on the edge of becoming a couple` });
  }
  // Friendship souring toward open rivalry / hatred.
  if (avgF >= -40 && avgF < 0 && avgF + 40 <= FLIP_MARGIN) {
    candidates.push({ gap: avgF + 40, text: (a, b) => `${a} and ${b} are one bad day from open rivalry` });
  }
  if (avgF >= -70 && avgF < -40 && avgF + 70 <= FLIP_MARGIN) {
    candidates.push({ gap: avgF + 70, text: (a, b) => `${a} and ${b} are sliding from rivals into enemies` });
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) => (c.gap < best.gap ? c : best));
}

/**
 * The list proper, split from the queries so it can be exercised on fixtures
 * instead of against the live sqlite file. Sorted hottest first, capped.
 */
export function buildBrewing(input: BrewingInput): BrewingItem[] {
  const nameOf = new Map<number, string>(input.agents.map((a) => [a.id, a.name]));
  const alive = (id: number) => nameOf.has(id);
  const items: BrewingItem[] = [];

  // ── Snap tension ──────────────────────────────────────────────────────────
  const personalityOf = new Map(input.agents.map((a) => [a.id, a.personality]));
  for (const t of input.tension) {
    const personality = personalityOf.get(t.agentId);
    // No personality means no threshold to measure against (and a departed
    // resident is not brewing anything): skip rather than guess.
    if (!personality || !alive(t.agentId)) continue;
    const threshold = snapThreshold(personality);
    const ratio = t.value / threshold;
    if (ratio < SNAP_WATCH_RATIO) continue;

    // Newest first, one line per kind of grievance: five "stress piling up"
    // rows would say nothing the first doesn't.
    const seen = new Set<string>();
    const sources: string[] = [];
    for (const s of [...t.sources].reverse()) {
      const phrase = sourcePhrase(s.event);
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      sources.push(phrase);
      if (sources.length >= MAX_SOURCES) break;
    }
    const name = nameOf.get(t.agentId)!;
    const why = sources.length > 0 ? ` — ${joinList(sources)} weighing on them` : '';
    items.push({
      id: `snap-${t.agentId}`,
      kind: 'snap',
      agentIds: [t.agentId],
      text: ratio >= 1 ? `${name} is at breaking point${why}` : `${name} is close to snapping${why}`,
      heat: clamp01(ratio),
      sources,
    });
  }

  // ── Juicy secrets not yet common knowledge ────────────────────────────────
  const population = input.agents.length;
  for (const s of input.secrets) {
    if (!s.is_active || s.is_public || s.sensitivity < JUICY_SENSITIVITY) continue;
    if (!alive(s.subject_id)) continue;
    if (isCommonKnowledge(s, population)) continue;
    // Count the living only: someone who died still sits in known_by, and
    // "5 of 13 know" with two of them in the graveyard would overstate the spread.
    const knowers = new Set(s.known_by.filter(alive));
    const known = knowers.size;
    // Progress toward "most of the town", the moment the secret stops being one.
    const needed = Math.floor(population / 2) + 1;
    const progress = clamp01(known / needed);
    const bonus = Math.min(2, s.sensitivity - JUICY_SENSITIVITY) * 0.1;
    items.push({
      id: `secret-${s.id}`,
      kind: 'secret',
      agentIds: [s.subject_id],
      text: `A secret about ${nameOf.get(s.subject_id)} is out there: ${known} of ${population} people know`,
      heat: clamp01(0.3 + bonus + 0.45 * progress),
    });
  }

  // ── Queued confrontations and player nudges ───────────────────────────────
  for (const q of input.queue) {
    const ids = q.participants.filter(alive);
    if (ids.length < 2) continue;
    const [a, b] = [nameOf.get(ids[0])!, nameOf.get(ids[1])!];
    const isConfrontation = q.trigger_reason === 'player_confront' || q.topic === 'confrontation';
    if (isConfrontation) {
      const byPlayer = q.trigger_reason === 'player_confront';
      items.push({
        id: `queue-${q.id}`,
        kind: 'confrontation',
        agentIds: ids,
        text: `${a} and ${b} are about to have it out`,
        heat: byPlayer ? 0.85 : 0.75,
      });
    } else if (q.trigger_reason === 'player_tell_secret') {
      // `topic` is "revealing: <the secret>" — deliberately not passed through.
      items.push({
        id: `queue-${q.id}`,
        kind: 'nudge',
        agentIds: ids,
        text: `${a} is about to let ${b} in on something`,
        heat: 0.8,
      });
    } else if (q.trigger_reason === 'player_nudge') {
      items.push({
        id: `queue-${q.id}`,
        kind: 'nudge',
        agentIds: ids,
        text: `You've pushed ${a} and ${b} together — a conversation is on its way`,
        heat: 0.55,
      });
    }
  }

  // ── Goals nearly achieved ─────────────────────────────────────────────────
  for (const g of input.goals) {
    if (g.status !== 'active' || g.progress < GOAL_CLOSE_PROGRESS || g.progress >= 1) continue;
    if (!alive(g.agent_id)) continue;
    const target = g.target_id != null ? (nameOf.get(g.target_id) ?? null) : null;
    // 0.7 -> 0.3 up to 1.0 -> 0.7: worth watching, never above a snap.
    const heat = 0.3 + 0.4 * clamp01((g.progress - GOAL_CLOSE_PROGRESS) / (1 - GOAL_CLOSE_PROGRESS));
    items.push({
      id: `goal-${g.id}`,
      kind: 'goal',
      agentIds: target != null && g.target_id != null ? [g.agent_id, g.target_id] : [g.agent_id],
      text: `${nameOf.get(g.agent_id)} is close to achieving ${goalPhrase(g, target)}`,
      heat,
    });
  }

  // ── Couples near a status flip ────────────────────────────────────────────
  for (const r of input.relationships) {
    if (!alive(r.agent_a) || !alive(r.agent_b)) continue;
    const key = pairKey(r.agent_a, r.agent_b);
    const flip = nearestFlip(r);
    if (!flip) continue;
    items.push({
      id: `rel-${key}`,
      kind: 'relationship',
      agentIds: [r.agent_a, r.agent_b],
      text: flip.text(nameOf.get(r.agent_a)!, nameOf.get(r.agent_b)!),
      // The closer to the line, the hotter; 0.3..0.6.
      heat: 0.3 + 0.3 * (1 - flip.gap / FLIP_MARGIN),
    });
  }

  // Ties broken by id so the order is stable between recomputes.
  items.sort((x, y) => y.heat - x.heat || x.id.localeCompare(y.id));
  return items.slice(0, MAX_ITEMS);
}

// ─── Queries + memo ──────────────────────────────────────────────────────────

/**
 * The client re-asks on every activity tick (the only channel that fires
 * often enough), and each answer reads five tables. A few seconds is far
 * shorter than tension takes to move from 70% to 100%.
 */
const CACHE_TTL_MS = 2000;
let cache: { at: number; items: BrewingItem[] } | null = null;

/** Drops the memo. Called on world replace (worldCaches) and by tests. */
export function resetBrewingCache() {
  cache = null;
}

export function getBrewing(now: number = Date.now()): BrewingItem[] {
  if (cache && now - cache.at < CACHE_TTL_MS) return cache.items;

  const living = db
    .select({ id: agents.id, name: agents.name, personality: agents.personality })
    .from(agents)
    .where(eq(agents.is_active, true))
    .all() as BrewingInput['agents'];

  const items = buildBrewing({
    agents: living,
    tension: getTensionSnapshot(),
    secrets: db.select().from(shared_knowledge).where(eq(shared_knowledge.is_active, true)).all() as BrewingInput['secrets'],
    queue: db.select({
      id: conversationQueue.id,
      participants: conversationQueue.participants,
      trigger_reason: conversationQueue.trigger_reason,
      topic: conversationQueue.topic,
    }).from(conversationQueue).all(),
    goals: db.select({
      id: goals.id,
      agent_id: goals.agent_id,
      type: goals.type,
      target_id: goals.target_id,
      description: goals.description,
      progress: goals.progress,
      status: goals.status,
    }).from(goals).where(eq(goals.status, 'active')).all(),
    relationships: db.select().from(relationships).all(),
  });
  cache = { at: now, items };
  return items;
}
