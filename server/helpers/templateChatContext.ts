/**
 * Gathers the real town moment a template chat is about (see
 * server/lib/templateChat.ts): the two people's needs, feelings, jobs and
 * states, the place, the weather and phase of day, a live town event, and a
 * mutual acquaintance — everything the topic scripts may ground a line in.
 * Every name and fact here comes from the DB, so a template line can only
 * mention people, places and events that exist in this town.
 */

import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '../db';
import { agents, economy, locations, needs, relationships, worldEvents, worldState } from '../db/schema';
import { firstName } from '../ai/names';
import { OUTDOOR_TYPES } from '../lib/worldgen/buildingTemplates';
import { placeIsSpeakable, toneOf, voiceOf } from '../lib/templateChat';
import { getAgentStates } from '../lib/states';
import { EVENT_TALK, JOB_NOUNS, type ChatContext, type ChatPerson } from '../data/smallTalkScripts';
import type { PersonalityProfile } from '../lib/personality';

type AgentRow = typeof agents.$inferSelect;
type WorldRow = Pick<typeof worldState.$inferSelect, 'weather' | 'day_phase'>;

/** A friendship this strong either way makes a third person worth mentioning. */
const MUTUAL_MIN_FEELING = 10;
/** Liking someone enough to send them your regards. */
const LIKES = 10;

/** Directional friendship `from` → `to`, or null when they have no relationship row. */
function feeling(rows: Array<typeof relationships.$inferSelect>, from: number, to: number): number | null {
  const [a, b] = from < to ? [from, to] : [to, from];
  const row = rows.find((r) => r.agent_a === a && r.agent_b === b);
  if (!row) return null;
  return from === a ? row.friendship_ab : row.friendship_ba;
}

function jobOf(agentId: number): string | null {
  const job = db.select({ job: economy.job }).from(economy).where(eq(economy.agent_id, agentId)).get()?.job;
  return job ? JOB_NOUNS[job] ?? null : null;
}

function locationName(id: number | null): string | null {
  if (id == null) return null;
  return db.select({ name: locations.name }).from(locations).where(eq(locations.id, id)).get()?.name ?? null;
}

/**
 * Someone both of them know and have feelings about, picked at random among
 * the three strongest — "Have you seen Rosa lately?" needs a Rosa both have
 * an opinion of. Null when they share no one.
 */
function mutualAcquaintance(
  aId: number,
  bId: number,
  rng: () => number,
): ChatContext['mutual'] {
  const rows = db.select().from(relationships)
    .where(or(
      inArray(relationships.agent_a, [aId, bId]),
      inArray(relationships.agent_b, [aId, bId]),
    ))
    .all();
  const others = new Set<number>();
  for (const r of rows) {
    for (const id of [r.agent_a, r.agent_b]) if (id !== aId && id !== bId) others.add(id);
  }
  if (others.size === 0) return null;
  const alive = db.select({ id: agents.id, name: agents.name }).from(agents)
    .where(and(inArray(agents.id, [...others]), eq(agents.is_active, true)))
    .all();
  const candidates = alive
    .map((x) => ({ x, fa: feeling(rows, aId, x.id), fb: feeling(rows, bId, x.id) }))
    .filter((m): m is { x: { id: number; name: string }; fa: number; fb: number } =>
      m.fa != null && m.fb != null
      && Math.max(Math.abs(m.fa), Math.abs(m.fb)) >= MUTUAL_MIN_FEELING)
    .sort((p, q) => (Math.abs(q.fa) + Math.abs(q.fb)) - (Math.abs(p.fa) + Math.abs(p.fb)))
    .slice(0, 3);
  if (candidates.length === 0) return null;
  const pick = candidates[Math.floor(rng() * candidates.length)];
  const first = firstName(pick.x.name);
  // Sharing a first name with a speaker would read as them talking about themselves.
  const speakers = db.select({ name: agents.name }).from(agents).where(inArray(agents.id, [aId, bId])).all()
    .map((s) => firstName(s.name));
  if (speakers.includes(first)) return null;
  return { first, openerLikes: pick.fa >= LIKES, listenerLikes: pick.fb >= LIKES };
}

/**
 * A live town event the two could talk about: one here, or town-wide. Events
 * without small-talk phrasing (a funeral) are left out.
 */
function liveEvent(locationId: number): ChatContext['event'] {
  const active = db.select({ type: worldEvents.type, location_id: worldEvents.location_id })
    .from(worldEvents).where(eq(worldEvents.is_active, true)).all()
    .filter((e) => (e.location_id == null || e.location_id === locationId) && EVENT_TALK[e.type]);
  if (active.length === 0) return null;
  const here = active.find((e) => e.location_id === locationId) ?? active[0];
  return { key: here.type, ...EVENT_TALK[here.type] };
}

/**
 * Real townsfolk for `{baker}`/`{bartender}`: active, holding that job, and
 * neither of the two talking. A role nobody fills stays unset, and the lines
 * that need it are skipped.
 */
function roleHolder(job: string, exclude: number[], rng: () => number): string | undefined {
  const holders = db.select({ id: agents.id, name: agents.name })
    .from(economy).innerJoin(agents, eq(agents.id, economy.agent_id))
    .where(and(eq(economy.job, job), eq(agents.is_active, true)))
    .all()
    .filter((h) => !exclude.includes(h.id));
  return holders.length > 0 ? firstName(holders[Math.floor(rng() * holders.length)].name) : undefined;
}

export function buildTemplateChatContext(
  pair: [AgentRow, AgentRow],
  locationId: number,
  world: WorldRow,
  rng: () => number = Math.random,
): ChatContext {
  const [opener, listener] = pair;
  const [lo, hi] = opener.id < listener.id ? [opener.id, listener.id] : [listener.id, opener.id];
  const rel = db.select().from(relationships)
    .where(and(eq(relationships.agent_a, lo), eq(relationships.agent_b, hi))).get();
  const loc = db.select({ name: locations.name, type: locations.type }).from(locations)
    .where(eq(locations.id, locationId)).get();

  // Each side from their OWN state: their feelings toward the other
  // (friendship is directional), their needs, their mood.
  const person = (agent: AgentRow): ChatPerson => {
    const isA = agent.id === lo;
    const n = db.select().from(needs).where(eq(needs.agent_id, agent.id)).get();
    const friendship = rel ? (isA ? rel.friendship_ab : rel.friendship_ba) : 0;
    const mood = n?.mood ?? 50;
    // Grieving, sick, heartbroken…: the scripts and the tone read them (templateChat.ts).
    const states: string[] = [...getAgentStates(agent.id)];
    return {
      name: agent.name,
      first: firstName(agent.name),
      friendship,
      mood,
      hunger: n?.hunger ?? 50,
      energy: n?.energy ?? 50,
      voice: voiceOf(agent.personality as PersonalityProfile | null),
      tone: toneOf(friendship, mood, states),
      states,
      job: jobOf(agent.id),
      workplace: locationName(agent.workplace ?? null),
      atWork: agent.workplace != null && agent.workplace === locationId,
      livesHere: agent.home === locationId,
    };
  };
  const people: [ChatPerson, ChatPerson] = [person(opener), person(listener)];
  const placeName = loc?.name ?? '';
  const placeType = loc?.type ?? null;
  const tavern = db.select({ name: locations.name }).from(locations).where(eq(locations.type, 'tavern')).get();

  return {
    people,
    place: {
      name: placeName,
      type: placeType,
      setting: placeType != null ? (OUTDOOR_TYPES.has(placeType) ? 'outdoor' : 'indoor') : null,
      speakable: placeIsSpeakable(placeName, placeType, people.map((p) => p.first)),
    },
    weather: world.weather,
    dayPhase: world.day_phase,
    status: rel?.status ?? null,
    romance: rel ? (opener.id === lo ? rel.romance_ab : rel.romance_ba) : 0,
    event: liveEvent(locationId),
    mutual: mutualAcquaintance(opener.id, listener.id, rng),
    roles: {
      tavern: tavern?.name,
      baker: roleHolder('baker', [opener.id, listener.id], rng),
      bartender: roleHolder('bartender', [opener.id, listener.id], rng),
    },
  };
}
