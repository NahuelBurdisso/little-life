/**
 * A gentle push for residents the story has forgotten today.
 *
 * WHY: with 13 residents, a 30-day soak found 30-70% of the town "invisible" on a given day —
 * no feed row of any weight about them from dawn to dusk. They were eating, working and
 * sleeping, but nothing happened TO them, so the player never had a reason to click them and
 * the drama engines, which feed on relationships and secrets, had nothing to grab. Here, in the
 * early afternoon and again in the evening, a resident with no important row yet today may get
 * a small personal event of their own: a letter from family, an old keepsake turning up, a
 * memory resurfacing, a sudden resolution. It is theirs alone (a `personal_event` feed row,
 * visible), it colours their mood, it leaves a memory the planner and dialogue draw on — a
 * conversation topic — and some of them seed a goal (reach out to an old friend), which the
 * goal system then drives into conversations.
 *
 * Cheap (one query per check, no LLM), at most one per resident per day, and only for the
 * ones who need it: a resident already in today's story is left alone.
 */
import { db } from '../db';
import { activityLog, agents, goals, relationships } from '../db/schema';
import { and, eq, gte } from 'drizzle-orm';
import { logActivity } from './activityLogger';
import { simEvents } from './simEvents';
import { addMoodModifier } from './dailyLife';
import { MAX_GOALS_PER_AGENT } from './interactionConstants';

export type Rng = () => number;

/** Hours of the day the check runs, and the chance an overlooked resident gets an event. */
export const PERSONAL_EVENT_CHECKS: Readonly<Record<number, number>> = { 13: 0.5, 19: 0.7 };

/** Importance a row needs to count as "in today's story" (the soak's visibility bar). */
const STORY_IMPORTANCE = 0.6;

export interface PersonalEvent {
  key: string;
  mood: number;
  minutes: number;
  /** Needs someone to think of (seeds a befriend goal toward them). */
  aboutSomeone?: boolean;
  feed: (first: string, other: string | null) => string;
  memory: (other: string | null) => string;
}

export const PERSONAL_EVENTS: readonly PersonalEvent[] = [
  {
    key: 'letter_good', mood: 6, minutes: 480,
    feed: (n) => `A letter arrived for ${n} from family far away, full of good news.`,
    memory: () => 'A letter came from my family today. Everyone is well, and my cousin is to be married.',
  },
  {
    key: 'letter_bad', mood: -6, minutes: 480,
    feed: (n) => `A letter arrived for ${n} with worrying news from home.`,
    memory: () => 'A letter came from home: my mother has been unwell. I wish I could be there.',
  },
  {
    key: 'keepsake', mood: 3, minutes: 360, aboutSomeone: true,
    feed: (n, o) => `${n} found an old keepsake that brought ${o ?? 'an old friend'} to mind.`,
    memory: (o) => `I found an old keepsake at the bottom of a drawer. It made me think of ${o ?? 'an old friend'}. I should talk to them more.`,
  },
  {
    key: 'fond_memory', mood: 4, minutes: 360, aboutSomeone: true,
    feed: (n, o) => `${n} caught themselves smiling at an old memory of ${o ?? 'a friend'}.`,
    memory: (o) => `I remembered something kind ${o ?? 'a friend'} once did for me. I never really thanked them.`,
  },
  {
    key: 'resolution', mood: 4, minutes: 480,
    feed: (n) => `${n} has made up their mind to learn something new this season.`,
    memory: () => "I've decided I'm going to learn something new this season. I'm tired of every day being the same.",
  },
  {
    key: 'craving', mood: 2, minutes: 240,
    feed: (n) => `${n} has had a craving for honey cake all day.`,
    memory: () => "I've been craving honey cake all day. I can't think of anything else.",
  },
  {
    key: 'old_regret', mood: -4, minutes: 360,
    feed: (n) => `${n} has been brooding over an old regret.`,
    memory: () => "An old regret came back to me today, and I couldn't shake it off.",
  },
];

/** Pick an event; ones needing someone are skipped when there's nobody to think of. Pure. */
export function pickPersonalEvent(hasSomeone: boolean, rng: Rng = Math.random): PersonalEvent {
  const pool = PERSONAL_EVENTS.filter((e) => hasSomeone || !e.aboutSomeone);
  return pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];
}

/** Residents mentioned by an important row since `sinceMinute`. */
function inTodaysStory(sinceMinute: number): Set<number> {
  const seen = new Set<number>();
  const rows = db.select({ i: activityLog.initiator_id, t: activityLog.target_id, ids: activityLog.agent_ids, imp: activityLog.importance })
    .from(activityLog).where(gte(activityLog.game_minute, sinceMinute)).all();
  for (const r of rows) {
    if (r.imp < STORY_IMPORTANCE) continue;
    for (const id of [r.i, r.t, ...((r.ids as number[] | null) ?? [])]) if (typeof id === 'number') seen.add(id);
  }
  return seen;
}

/**
 * Someone to think fondly of: the resident's warmest tie short of close friendship (a bond
 * worth rekindling), else anyone they don't dislike.
 */
function someoneToRemember(agentId: number, activeIds: ReadonlySet<number>): number | null {
  const rels = db.select().from(relationships).all()
    .filter((r) => (r.agent_a === agentId || r.agent_b === agentId));
  const options = rels.map((r) => {
    const other = r.agent_a === agentId ? r.agent_b : r.agent_a;
    const friendship = r.agent_a === agentId ? r.friendship_ab : r.friendship_ba;
    return { other, friendship };
  }).filter((o) => activeIds.has(o.other) && o.friendship >= 0 && o.friendship < 60);
  options.sort((x, y) => y.friendship - x.friendship);
  return options[0]?.other ?? null;
}

/** A befriend goal toward `targetId`, unless they have one already or are at the goal cap. */
function seedBefriendGoal(agent: { id: number; name: string }, targetId: number, nowMinutes: number): void {
  const active = db.select().from(goals).where(and(eq(goals.agent_id, agent.id), eq(goals.status, 'active'))).all();
  if (active.length >= MAX_GOALS_PER_AGENT) return;
  if (active.some((g) => g.type === 'befriend' && g.target_id === targetId)) return;
  db.insert(goals).values({
    agent_id: agent.id, type: 'befriend', target_id: targetId, motivation: 'personal_event:reconnect',
    priority: 0.4, progress: 0, status: 'active', created_at: nowMinutes,
  }).run();
  simEvents.emit('goal:created', { agentId: agent.id, goalType: 'befriend', targetId });
  logActivity({ type: 'goal_created', initiator: agent.id, target: targetId, templateData: { name: agent.name, goal: 'befriend' } });
}

/** Runs every game hour; acts only at the PERSONAL_EVENT_CHECKS hours. Returns events given. */
export function personalEventsHourly(hour: number, nowMinutes: number, rng: Rng = Math.random): number {
  const chance = PERSONAL_EVENT_CHECKS[hour];
  if (chance == null) return 0;
  const active = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const activeIds = new Set(active.map((a) => a.id));
  const dayStart = nowMinutes - (nowMinutes % 1440);
  const seen = inTodaysStory(dayStart);

  let given = 0;
  for (const agent of active) {
    if (seen.has(agent.id)) continue;
    if ((agent.current_action as { type?: string } | null)?.type === 'sleeping') continue;
    if (rng() >= chance) continue;

    const otherId = someoneToRemember(agent.id, activeIds);
    const other = otherId != null ? active.find((a) => a.id === otherId) ?? null : null;
    const event = pickPersonalEvent(other != null, rng);
    const first = agent.name.split(' ')[0];
    const otherFirst = event.aboutSomeone && other ? other.name.split(' ')[0] : null;

    addMoodModifier(agent.id, event.mood, `personal:${event.key}`, event.minutes, nowMinutes);
    simEvents.emit('life:milestone', {
      agentId: agent.id,
      description: event.memory(otherFirst),
      valence: Math.max(-1, Math.min(1, event.mood / 8)),
      importance: 6,
      ...(event.aboutSomeone && other ? { relatedAgentId: other.id } : {}),
    });
    logActivity({
      type: 'personal_event',
      initiator: agent.id,
      ...(event.aboutSomeone && other ? { target: other.id } : {}),
      templateData: { description: event.feed(first, otherFirst) },
    });
    if (event.aboutSomeone && other) seedBefriendGoal(agent, other.id, nowMinutes);
    given++;
  }
  return given;
}
