import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db';
import { agentStates, agents, shared_knowledge } from '../../db/schema';
import { emitter } from '../../engine/emitter';
import { logActivity } from '../activityLogger';
import { insertPairEvent, pairRelationship } from '../conversationBeats';
import { addMoodModifier } from '../dailyLife';
import { FATHER_MIN_AGE, MOTHER_MAX_AGE, roomForAnotherChild, startPregnancy } from '../family';
import { MINUTES_PER_DAY, childAgeDays, childrenOf, allPregnancies, pregnancyOf, type Pregnancy } from '../familyState';
import { addKnowers, learnFact } from '../gossip';
import { ENGAGED_TAG, MARRIED_TAG, isSpokenFor, spouseOf } from '../marriage';
import { getPairMilestone, queueShotgunProposal } from '../milestonesEngine';
import { simEvents } from '../simEvents';
import { getEffectivePersonality, type StateType } from '../states';
import { isAdultContent } from '../worldRules';
import { isAdultAge } from './eligibility';
import { onlookersNear } from './witnesses';

// ─── An unwed pregnancy, and the 1900 scandal ────────────────────────────────
//
// Adult layer only (the `adultContent` rule on, two adults the age gate let through), and
// discreet from start to end: nothing here narrates the night, only what followed it.
//
//   a completed tryst between a man and an UNMARRIED woman of childbearing age ─▶ a roll
//   (TRYST_CONCEPTION_CHANCE, once per night, not per day). A married mother keeps
//   family.ts's own daily roll and its lover-paternity branch, so she is never rolled
//   twice. A hit starts a pregnancy through family.ts (`startPregnancy`, `unwed`): a
//   private `pregnancy` secret (sensitivity 3) only she knows.
//        │
//        ├─ 2 game days: she tells the father (he learns the secret; a memory each).
//        │     What he does is a pure function of his loyalty, his morality, his romance
//        │     toward her and whether he is already spoken for (`fatherResponse`):
//        │       marry ─▶ `queueShotgunProposal` (milestonesEngine: the wait of a normal
//        │                proposal is skipped, the answer is the usual one)
//        │       deny  ─▶ she is heartbroken, he is `guilty` if he has a conscience, and
//        │                the child will be born with no father of record
//        │
//        └─ 4 game days: she is "showing". Unless she has married the father by then,
//              the town can see it: an `illegitimate_pregnancy` secret (sensitivity 3)
//              born to whoever is beside her, a `scandal` feed row, and every strict
//              adult (morality > 70) who learns it thinks less of her (friendship -10), and
//              of the father once he is named. A wedding at any time turns the pregnancy
//              into an ordinary married one and the whispers stop mattering.
//
// The birth is family.ts's, on its usual timer. All the state lives on the Pregnancy record
// (familyState.ts), which is snapshotted and cleared with the family module.

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** Chance a completed night between a man and an unmarried woman starts a pregnancy. */
export const TRYST_CONCEPTION_CHANCE = 0.06;
/** She tells the father this long after conception. */
export const TELL_FATHER_AFTER_MINUTES = 2 * MINUTES_PER_DAY;
/** She is showing this long after conception. */
export const SHOWING_AFTER_MINUTES = 4 * MINUTES_PER_DAY;
/**
 * A scandal is put off (at most) this long past `SHOWING_AFTER_MINUTES` while a wedding is
 * still on its way (the father proposed or they are engaged: a shotgun engagement's wedding
 * comes a game day after the yes, which would otherwise always land just after she showed)
 * or nobody has seen her yet. After that it is raised whatever the reason.
 */
export const SHOWING_GRACE_MINUTES = 2 * MINUTES_PER_DAY;
/** Strict adults, the ones who think less of her, have at least this much morality. */
const SCANDAL_JUDGE_MORALITY_ABOVE = 70;
/** What being judged costs: the judge's friendship toward her (and toward the named father). */
export const SCANDAL_FRIENDSHIP = -10;
/** A father with at least this much conscience is troubled by turning her away. */
export const DENIAL_GUILT_MORALITY_ABOVE = 50;
const DENIAL_GUILT_MINUTES = 24 * 60;
const HEARTBREAK_MINUTES = 2 * MINUTES_PER_DAY;
const SCANDAL_MOOD = -8;
const SCANDAL_MOOD_MINUTES = 2 * MINUTES_PER_DAY;

// ─── Pure rules (exported for tests) ─────────────────────────────────────────

interface FatherProfile {
  /** 0..100, personality. */
  loyalty: number;
  /** 0..100, personality. */
  morality: number;
  /** His romance toward her, -100..100. */
  romance: number;
  /** He is engaged or married to somebody else. */
  spokenFor: boolean;
}

type FatherResponse = 'marry' | 'deny';

/**
 * What the father does when she tells him. Nothing random: a man who is already promised
 * elsewhere, or who no longer feels anything for her, turns her away; otherwise loyalty,
 * conscience and how he feels about her are weighed (romance counts a little less than the
 * other two, since a decent man owns up without being in love).
 */
export function fatherResponse(f: FatherProfile): FatherResponse {
  if (f.spokenFor) return 'deny';
  if (f.romance < 25) return 'deny';
  const score = f.loyalty * 0.35 + f.morality * 0.35 + Math.max(0, f.romance) * 0.3;
  return score >= 50 ? 'marry' : 'deny';
}

// ─── Small helpers ───────────────────────────────────────────────────────────

type AgentRow = typeof agents.$inferSelect;

const rowOf = (id: number): AgentRow | undefined => db.select().from(agents).where(eq(agents.id, id)).get();

const firstName = (full: string): string => full.split(' ')[0] ?? full;

const remember = (agentId: number, description: string, valence: number, importance: number, related?: number | null): void => {
  simEvents.emit('life:milestone', { agentId, description, valence, importance, relatedAgentId: related ?? undefined });
};

const personalityOf = (row: AgentRow) =>
  (getEffectivePersonality(row.id) ?? (row.personality as { loyalty?: number; morality?: number } | null)) ?? {};

/** A timed state, replacing one of the same type the agent already has. */
function giveTimedState(
  agentId: number, type: Extract<StateType, 'heartbroken' | 'guilty'>, severity: number,
  minutes: number, now: number, source: string, targetId: number,
): void {
  db.delete(agentStates).where(and(eq(agentStates.agent_id, agentId), eq(agentStates.type, type))).run();
  db.insert(agentStates).values({
    agent_id: agentId, type, severity, started_at: now, duration: minutes,
    target_agent_id: targetId, source, metadata: null,
  }).run();
  simEvents.emit('state:triggered', { agentId, state: type, cause: source });
}

/** Whether the two are married to each other. */
const marriedToEachOther = (a: number, b: number): boolean => pairRelationship(a, b)?.tags.includes(MARRIED_TAG) === true;

// ─── Conception ──────────────────────────────────────────────────────────────

/**
 * The roll after one completed night (aftermath.ts calls it for every non-interrupted
 * tryst). Null, with no roll, unless: the rule is on; a man and a woman; both adults, she
 * no older than family.ts's MOTHER_MAX_AGE; she is unmarried (a married mother keeps the
 * daily roll); not already expecting; and the family-size rule leaves room. `rng` is
 * injectable for tests.
 */
export function rollTrystConception(a: AgentRow, b: AgentRow, now: number, rng: () => number = Math.random): Pregnancy | null {
  if (!isAdultContent()) return null;
  if (a.gender === b.gender) return null;
  const mother = a.gender === 'female' ? a : b;
  const father = mother === a ? b : a;
  if (mother.gender !== 'female' || father.gender !== 'male') return null;
  if (!mother.is_active || !father.is_active) return null;
  // Fails closed on a missing age, like the eligibility gate itself.
  if (!isAdultAge(mother.age) || !isAdultAge(father.age)) return null;
  if (mother.age > MOTHER_MAX_AGE || father.age < FATHER_MIN_AGE) return null;
  if (spouseOf(mother.id) != null) return null;
  if (pregnancyOf(mother.id)) return null;
  const kids = childrenOf(mother.id);
  const youngest = kids.at(-1);
  if (!roomForAnotherChild({
    childCount: kids.length,
    youngestAgeDays: youngest ? childAgeDays(youngest.birth_game_minute, now) : null,
  })) return null;
  if (rng() >= TRYST_CONCEPTION_CHANCE) return null;
  return startPregnancy({ motherId: mother.id, fatherId: father.id, unwed: true, now });
}

// ─── Telling the father ──────────────────────────────────────────────────────

function tellFather(p: Pregnancy, now: number): void {
  p.spouseTold = true;
  if (p.fatherId == null) return;
  const mother = rowOf(p.motherId);
  const father = rowOf(p.fatherId);
  if (!mother || !father?.is_active) return; // he is gone: nobody to tell
  const mN = firstName(mother.name), fN = firstName(father.name);
  if (p.factId != null) addKnowers(p.factId, [father.id]);
  remember(mother.id, `I told ${fN} about the baby.`, 0.1, 7, father.id);

  const rel = pairRelationship(mother.id, father.id);
  const response = fatherResponse({
    loyalty: personalityOf(father).loyalty ?? 50,
    morality: personalityOf(father).morality ?? 50,
    romance: rel ? (rel.agent_a === father.id ? rel.romance_ab : rel.romance_ba) : 0,
    spokenFor: isSpokenFor(father.id, mother.id),
  });

  if (response === 'marry') {
    remember(father.id, `${mN} told me she is expecting, and that the child is mine. I mean to do right by her.`, 0.3, 8, mother.id);
    // Already engaged to her: the wedding is on its way, nobody has to ask again.
    if (!rel?.tags.includes(ENGAGED_TAG)) queueShotgunProposal(father.id, mother.id);
    return;
  }

  // He turns her away. `fatherId` stays for the record; the child will have no father of record.
  p.fatherDenied = true;
  giveTimedState(mother.id, 'heartbroken', 0.7, HEARTBREAK_MINUTES, now, 'intimacy:pregnancy', father.id);
  insertPairEvent(mother.id, father.id, 'denied', `${mother.name} told ${father.name} about the baby, and he turned her away`,
    { friendshipFrom: -10, friendshipTo: -2, romanceFrom: -15, romanceTo: -5, trustFrom: -25, trustTo: -5 }, -0.8);
  remember(mother.id, `${fN} would not hear it. I am alone with this.`, -0.9, 9, father.id);
  if ((personalityOf(father).morality ?? 50) > DENIAL_GUILT_MORALITY_ABOVE) {
    giveTimedState(father.id, 'guilty', 0.6, DENIAL_GUILT_MINUTES, now, 'intimacy:pregnancy', mother.id);
  }
  remember(father.id, `${mN} told me the child is mine, and I turned her away. I cannot stop thinking about it.`, -0.6, 8, mother.id);
}

// ─── Showing: the scandal ────────────────────────────────────────────────────

/** Everyone awake beside her who is a grown-up: the first to see, and so the first to know. */
function adultsBeside(mother: AgentRow, exclude: number[]): number[] {
  const near = onlookersNear({ current_location: mother.current_location, position: mother.position }, exclude);
  if (near.length === 0) return [];
  return db.select({ id: agents.id, age: agents.age }).from(agents).where(inArray(agents.id, near)).all()
    .filter((r) => isAdultAge(r.age)).map((r) => r.id);
}

/** The two people who are not "the town": the mother and the father of her child. */
const apartFrom = (p: Pregnancy): number[] => [p.motherId, ...(p.fatherId != null ? [p.fatherId] : [])];

/**
 * She has married the father, or is about to (engaged, or a shotgun proposal is still
 * pending): a scandal now would be raised over a wedding that is already on its way.
 */
function weddingOnItsWay(p: Pregnancy): boolean {
  if (p.fatherId == null || p.fatherDenied) return false;
  if (pairRelationship(p.motherId, p.fatherId)?.tags.includes(ENGAGED_TAG)) return true;
  const state = getPairMilestone(p.motherId, p.fatherId);
  return state?.shotgun === true && (state.proposerId != null || state.engagedAt != null);
}

function raiseScandal(p: Pregnancy, now: number): void {
  p.showing = true;
  const mother = rowOf(p.motherId);
  if (!mother?.is_active) return;
  const father = p.fatherId != null && !p.fatherDenied ? rowOf(p.fatherId) : undefined;
  const named = father?.is_active ? father : undefined;

  // The father, named or not, is never one of the onlookers: a man who turned her away is not
  // "beside her" for the town's purposes, and the one who stood by her is added on his own.
  const knowers = [mother.id, ...(named ? [named.id] : []), ...adultsBeside(mother, apartFrom(p))];
  const factId = learnFact('illegitimate_pregnancy', mother.id, named?.id ?? null, 3, knowers, 'observed');
  if (factId != null) p.scandalFactId = factId;

  logActivity({
    type: 'scandal',
    initiator: mother.id,
    ...(named ? { target: named.id } : {}),
    ...(mother.current_location != null ? { location: mother.current_location } : {}),
    templateData: { agent1: mother.name },
    metadata: { beat: 'scandal' },
  });

  addMoodModifier(mother.id, SCANDAL_MOOD, 'scandal', SCANDAL_MOOD_MINUTES, now);
  remember(mother.id, 'I can hide it no longer. The whole town is whispering about me.', -0.7, 8, named?.id);
  if (named) remember(named.id, `People whisper about ${firstName(mother.name)} and me, and they are not wrong.`, -0.4, 6, mother.id);
}

/**
 * The strict adults who know now think less of her (each is judged once, the pass runs
 * until the birth). Their friendship toward the named father drops too, once the fact
 * names him: the fact's target is set only when he was not the man who denied it.
 */
function judgeScandal(p: Pregnancy): void {
  if (p.scandalFactId == null) return;
  const fact = db.select().from(shared_knowledge).where(eq(shared_knowledge.id, p.scandalFactId)).get();
  if (!fact?.is_active) return;
  const judged = new Set(p.judgedBy ?? []);
  const fresh = (fact.known_by as unknown[])
    .filter((v): v is number => typeof v === 'number' && v !== p.motherId && v !== fact.target_id && !judged.has(v));
  if (fresh.length === 0) return;
  const rows = db.select().from(agents).where(inArray(agents.id, fresh)).all();
  for (const judge of rows) {
    judged.add(judge.id);
    if (!judge.is_active || !isAdultAge(judge.age)) continue;
    if (!((personalityOf(judge).morality ?? 50) > SCANDAL_JUDGE_MORALITY_ABOVE)) continue;
    insertPairEvent(judge.id, p.motherId, 'scandal', `${judge.name} heard the whispers about ${rowOf(p.motherId)?.name ?? 'her'}`,
      { friendshipFrom: SCANDAL_FRIENDSHIP, friendshipTo: 0 }, -0.4);
    if (fact.target_id != null) {
      insertPairEvent(judge.id, fact.target_id, 'scandal', `${judge.name} heard the whispers about ${rowOf(fact.target_id)?.name ?? 'him'}`,
        { friendshipFrom: SCANDAL_FRIENDSHIP, friendshipTo: 0 }, -0.4);
    }
  }
  p.judgedBy = [...judged];
}

// ─── The pass ────────────────────────────────────────────────────────────────

/**
 * Every 10 game minutes (intimacy/index.ts): tell the father, raise the scandal, let the
 * strict adults who learned of it judge. Only while the adult layer is on; the pregnancy
 * itself (and its birth, family.ts) carries on regardless.
 */
export function pregnancyPass(now: number): void {
  if (!isAdultContent()) return;
  let dirty = false;
  for (const p of allPregnancies()) {
    if (!p.unwed) continue;
    const mother = rowOf(p.motherId);
    if (!mother?.is_active) continue; // family.ts ends it

    // A wedding turns it into an ordinary married pregnancy (family.ts announces it now).
    if (p.fatherId != null && !p.fatherDenied && marriedToEachOther(p.motherId, p.fatherId)) {
      p.unwed = false;
      dirty = true;
      continue;
    }

    const age = now - p.conceivedAt;
    if (!p.spouseTold && age >= TELL_FATHER_AFTER_MINUTES) { tellFather(p, now); dirty = true; }

    if (!p.showing && age >= SHOWING_AFTER_MINUTES) {
      const nobodySees = adultsBeside(mother, apartFrom(p)).length === 0;
      const waiting = weddingOnItsWay(p) || nobodySees;
      if (!waiting || age >= SHOWING_AFTER_MINUTES + SHOWING_GRACE_MINUTES) { raiseScandal(p, now); dirty = true; }
    }
    if (p.showing) judgeScandal(p);
  }
  if (dirty) emitter.markDirty('agents.all');
}
