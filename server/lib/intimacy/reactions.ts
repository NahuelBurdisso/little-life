import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { agentStates, agents } from '../../db/schema';
import { pairRelationship } from '../conversationBeats';
import { MILESTONE_TAGS } from '../marriage';
import { simEvents } from '../simEvents';
import { gameMinutesNow } from '../worldClock';
import { isOpenCouple, type IntimacyKissPayload } from './kiss';

// ─── What seeing it does to whoever sees ─────────────────────────────────────
//
// A kiss or a walk home at dawn already becomes a secret in the witness's head
// (`kiss_seen` / `tryst_seen`, kiss.ts and tryst.ts). This is the rest of what it does to
// a person, so the story reaches the memory stream, the mood and the cascade and not
// only the fact table:
//
//   every witness ─▶ a memory of what they saw ("I saw A kissing B"), plainly worded
//   a partner / fiance(e) / spouse of one of the two ─▶ heartbroken on the spot (about
//        the one they are with) and a memory that weighs 9: the same state the discovery
//        of an affair gives (`reactToPartnerAffair` then decides what they do about it the
//        next time they talk, on the `affair` fact tryst.ts already handed them)
//   somebody with a torch for one of the two (romance > 40) ─▶ jealous, with the
//        states/events giftEngine.ts's gift jealousy uses, so `gift_jealousy_spiral` and
//        the jealous-state ripple rules take over
//   the two who were seen at dawn or after dark ─▶ a memory each of being seen (an evening
//        walked in on already left them its own, aftermath.ts)
//
// Witnesses are adults only (witnesses.ts `onlookersNear`) and the two are eligible adults
// (they got as far as an `intimacy:*` event), so this never touches a minor. Wording is the
// feed's own: what was seen, never more. Reactions are best effort, like every listener that
// runs inside the emitting phase's transaction: one that throws is logged, not propagated.

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** Romance toward one of the two above which a witness is carrying a torch (the chronicle's line for a triangle). */
export const TORCH_ROMANCE = 40;
/** How long a witnessed betrayal keeps a partner heartbroken (game minutes): two game days. */
export const WITNESSED_HEARTBREAK_MINUTES = 2 * 24 * 60;
/** The jealousy a crush feels lasts two game days, as the gift jealousy's does. */
export const WITNESSED_JEALOUSY_MINUTES = 2880;

/** Where a sighting was, worded once (activityMessage.ts / gossip.ts word the feed and the fact the same way). */
export type SightingScene = 'kiss' | 'dawn' | 'found' | 'outdoors';

interface Stake {
  kind: 'betrayed' | 'crush' | 'none';
  /** The one of the two the witness is with (or pines for). */
  loved?: number;
  /** The other one of the two. */
  rival?: number;
  /** For a crush, how much. */
  romance?: number;
}

type RelRow = NonNullable<ReturnType<typeof pairRelationship>>;

const romanceToward = (rel: RelRow, from: number): number => (from === rel.agent_a ? rel.romance_ab : rel.romance_ba);

/** Whether `w` is openly with `x`: partners, or engaged / married (same meaning as committed.ts, for one pair). */
function isWith(rel: RelRow | undefined): boolean {
  return !!rel && (rel.status === 'partners' || rel.tags.includes('partner') || rel.tags.some((t) => MILESTONE_TAGS.includes(t)));
}

/**
 * What the witness has riding on the two: they are with one of them (betrayed), or they carry a torch for
 * one (a crush), or nothing. Being with one outranks pining for the other.
 */
export function witnessStake(w: number, a: number, b: number): Stake {
  for (const [x, y] of [[a, b], [b, a]] as const) {
    if (isWith(pairRelationship(w, x))) return { kind: 'betrayed', loved: x, rival: y };
  }
  let best: Stake = { kind: 'none' };
  for (const [x, y] of [[a, b], [b, a]] as const) {
    const rel = pairRelationship(w, x);
    if (!rel) continue;
    const romance = romanceToward(rel, w);
    if (romance > TORCH_ROMANCE && romance > (best.romance ?? 0)) best = { kind: 'crush', loved: x, rival: y, romance };
  }
  return best;
}

// ─── Wording ─────────────────────────────────────────────────────────────────

/** What was seen, as a clause that follows "I saw" (`subject` is the one seen leaving, or the one who led). */
function sighting(scene: SightingScene, subject: string, other: string): string {
  switch (scene) {
    case 'kiss': return `${subject} kissing ${other}`;
    case 'dawn': return `${subject} slipping out of ${other}'s house at dawn`;
    case 'outdoors': return `${subject} and ${other} slipping away together after dark`;
    case 'found': return `${subject} and ${other} alone together late in the evening`;
  }
}

/** "I saw ..." / "I found ..." (a walked-in-on evening is found, not merely seen). */
function seen(scene: SightingScene, subject: string, other: string): string {
  return scene === 'found' ? `I found ${sighting(scene, subject, other)}` : `I saw ${sighting(scene, subject, other)}`;
}

const remember = (agentId: number, description: string, valence: number, importance: number, relatedAgentId: number): void => {
  simEvents.emit('life:milestone', { agentId, description, valence, importance, relatedAgentId });
};

function nameOf(rows: Map<number, string>, id: number): string {
  return rows.get(id) ?? 'someone';
}

// ─── States ──────────────────────────────────────────────────────────────────

/** Heartbroken about `loved`, unless already heartbroken (the states are not stacked). */
function breakHeart(w: number, loved: number, now: number): void {
  const held = db.select({ id: agentStates.id }).from(agentStates)
    .where(and(eq(agentStates.agent_id, w), eq(agentStates.type, 'heartbroken'))).get();
  if (held) return;
  db.insert(agentStates).values({
    agent_id: w, type: 'heartbroken', severity: 0.7, started_at: now, duration: WITNESSED_HEARTBREAK_MINUTES,
    target_agent_id: loved, source: 'intimacy:witnessed', metadata: null,
  }).run();
  // The downstream cascade (drinking, a confrontation, isolation) listens to this, as it does for every heartbreak.
  simEvents.emit('state:triggered', { agentId: w, state: 'heartbroken', cause: 'intimacy:witnessed' });
}

/** Jealous of `rival` over `loved`, with the states and event giftEngine.ts's gift jealousy uses. */
function makeJealous(w: number, loved: number, rival: number, romance: number, now: number): void {
  const held = db.select({ id: agentStates.id }).from(agentStates)
    .where(and(eq(agentStates.agent_id, w), eq(agentStates.type, 'jealous'))).get();
  if (held) return;
  db.insert(agentStates).values({
    agent_id: w, type: 'jealous', severity: Math.min(1, romance / 100), started_at: now, duration: WITNESSED_JEALOUSY_MINUTES,
    target_agent_id: loved, source: 'kiss_witnessed', metadata: { rivalId: rival, loveInterestId: loved, trigger: 'kiss_witnessed' },
  }).run();
  simEvents.emit('jealousy:triggered', { agentId: w, loveInterestId: loved, rivalId: rival, trigger: 'kiss_witnessed' });
}

// ─── The witness ─────────────────────────────────────────────────────────────

/**
 * One witness saw `subject` and `other` (`scene`): the memory, and the state their stake calls for.
 * `subject` is the one seen leaving (a dawn walk) or the one who leaned in (a kiss).
 */
function witnessSaw(w: number, subject: number, other: number, scene: SightingScene, names: Map<number, string>): void {
  const now = gameMinutesNow();
  const stake = witnessStake(w, subject, other);
  const s = nameOf(names, subject);
  const o = nameOf(names, other);
  const base = scene === 'kiss' ? 4 : 6;

  if (stake.kind === 'betrayed' && stake.loved != null) {
    const loved = nameOf(names, stake.loved);
    remember(w, `${seen(scene, s, o)}. ${loved} is meant to be mine, and I cannot unsee it.`, -0.9, 9, stake.loved);
    breakHeart(w, stake.loved, now);
    return;
  }
  if (stake.kind === 'crush' && stake.loved != null && stake.rival != null) {
    remember(w, `${seen(scene, s, o)}, and it stung more than I expected.`, -0.6, 6, stake.loved);
    makeJealous(w, stake.loved, stake.rival, stake.romance ?? TORCH_ROMANCE, now);
    return;
  }
  remember(w, `${seen(scene, s, o)}.`, scene === 'kiss' ? 0.1 : 0, base, subject);
}

function namesOf(ids: number[]): Map<number, string> {
  return new Map(db.select({ id: agents.id, name: agents.name }).from(agents).where(inArray(agents.id, ids)).all().map((r) => [r.id, r.name]));
}

/** A kiss somebody saw: anyone who saw reacts (an open couple kissing is nobody's news). */
export function onKissWitnessed(p: IntimacyKissPayload): void {
  if (p.witnessIds.length === 0 || isOpenCouple(p.a, p.b)) return;
  const names = namesOf([p.a, p.b, ...p.witnessIds]);
  for (const w of p.witnessIds) witnessSaw(w, p.a, p.b, 'kiss', names);
}

export interface IntimacyCaughtPayload {
  /** The one seen leaving (or, for an evening walked in on, the guest). */
  a: number;
  /** Whose house it was. */
  b: number;
  witnessId: number;
  /** Where it was seen; an event from before it existed is the dawn walk. */
  scene?: 'dawn' | 'found' | 'outdoors';
}

/** The two who were seen remember being seen, unless the evening was walked in on (aftermath.ts already left them that). */
function beingSeen(p: IntimacyCaughtPayload, scene: 'dawn' | 'outdoors', names: Map<number, string>): void {
  const w = nameOf(names, p.witnessId);
  const a = nameOf(names, p.a);
  const b = nameOf(names, p.b);
  if (scene === 'dawn') {
    remember(p.a, `${w} saw me leaving ${b}'s house at dawn. It will be all over town.`, -0.6, 7, p.witnessId);
    remember(p.b, `${w} saw ${a} leaving my house at dawn.`, -0.5, 6, p.witnessId);
    return;
  }
  remember(p.a, `${w} saw ${b} and me slipping away together after dark. It will be all over town.`, -0.6, 7, p.witnessId);
  remember(p.b, `${w} saw ${a} and me slipping away together after dark.`, -0.5, 6, p.witnessId);
}

/** Somebody saw a night, or its morning after. */
export function onCaughtWitnessed(p: IntimacyCaughtPayload): void {
  const scene = p.scene ?? 'dawn';
  const names = namesOf([p.a, p.b, p.witnessId]);
  witnessSaw(p.witnessId, p.a, p.b, scene, names);
  if (scene !== 'found') beingSeen(p, scene, names);
}

// ─── Registration ────────────────────────────────────────────────────────────

let registered = false;

/** Called once by intimacy/index.ts (importing it registers the listeners like the other engines). */
export function registerReactionListeners(): void {
  if (registered) return;
  registered = true;
  simEvents.on('intimacy:kiss', (p: IntimacyKissPayload) => {
    try {
      onKissWitnessed(p);
    } catch (err) {
      console.warn('[intimacy] reacting to a kiss seen failed:', (err as Error).message);
    }
  });
  simEvents.on('intimacy:caught', (p: IntimacyCaughtPayload) => {
    try {
      onCaughtWitnessed(p);
    } catch (err) {
      console.warn('[intimacy] reacting to being caught failed:', (err as Error).message);
    }
  });
}
