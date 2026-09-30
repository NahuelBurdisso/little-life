import { and, asc, eq, inArray, isNotNull, or } from 'drizzle-orm';
import { db } from '../db';
import { agents, children, relationships } from '../db/schema';
import { asId, asNumber, asRecord, type SnapshotStore } from '../engine/snapshotCodec';

// ─── Family state: who is expecting, who has a baby ──────────────────────────
//
// The read side of lib/family.ts (the engine that marries timers to events).
// Split out because the readers sit low in the import graph — heirs.ts (read
// by residents.ts), the plan prompt builder, the decisions phase's topic
// picker, the agents router — while the engine imports gossip, the world-event
// starter and the milestones module. Importing the engine from any of those
// would close a cycle (milestonesEngine → residents → heirs → family → …).
// Everything here is either a DB read or the in-memory pregnancy registry;
// nothing here writes a feed row or starts an event.
//
// The durable truth is the `children` table. A pregnancy is not in any table:
// it lives here, checkpointed to sim_snapshots (engine/worldCaches.ts), like the
// milestones' engagement timers — a restart must neither lose a baby on the way
// nor forget that the husband has already been told.

export const MINUTES_PER_DAY = 24 * 60;

/**
 * The whole pregnancy, compressed for play: seven game days. A real nine
 * months would outlast any save; a week keeps the arc visible while it is
 * still the talk of the town.
 */
export const PREGNANCY_MINUTES = 7 * MINUTES_PER_DAY;

/** A child is a baby for its first game days, a toddler after that, then a child. */
export const BABY_DAYS = 4;
export const TODDLER_DAYS = 12;

export type ChildStage = 'baby' | 'toddler' | 'child';
export type ChildRow = typeof children.$inferSelect;

export interface Pregnancy {
  motherId: number;
  /** The husband: the father as the town will believe. */
  fatherId: number;
  /** Set when the real father is the mother's lover (lib/family.ts, an affair). */
  trueFatherId?: number;
  /** Game minute of conception. */
  conceivedAt: number;
  /** The `pregnancy` secret (shared_knowledge id). */
  factId?: number;
  /** The `paternity` secret, when there is a lover. */
  paternityFactId?: number;
  /** The husband has been told (a game day in). */
  spouseTold?: boolean;
  /** The town has been told (the "expecting" feed row). */
  announced?: boolean;
  /** The husband learned the truth before the birth: the drama has played. */
  paternityRevealed?: boolean;
}

/** A christening waiting for its daytime slot: the child, and from when it may start. */
export interface PendingChristening { childId: number; dueAt: number }

/** A father who has learned the truth, on his way to have it out with the lover. */
export interface PendingConfrontation { fatherId: number; loverId: number; since: number }

/** Keyed by mother id: one pregnancy at a time. */
const pregnancies = new Map<number, Pregnancy>();
/**
 * Game minute each married couple was first seen married, by `lo-hi` pair key.
 * The wedding's own stamp is not stored anywhere durable (relationship events
 * are pruned), so the clock starts when lib/family.ts first meets the couple —
 * within ten game minutes of the wedding, or at the first pass after a restart
 * for a couple married before this module existed (the milestones module
 * starts its own clocks the same way).
 */
const marriedSince = new Map<string, number>();
const christenings = new Map<number, number>();
const confrontations = new Map<string, PendingConfrontation>();

export function familyPairKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

// ─── Registry access (lib/family.ts writes, everyone else reads) ─────────────

export function pregnancyOf(motherId: number): Readonly<Pregnancy> | undefined {
  return pregnancies.get(motherId);
}

/** The pregnancy an agent is part of as mother or (believed) father. */
export function pregnancyInvolving(agentId: number): Readonly<Pregnancy> | undefined {
  const own = pregnancies.get(agentId);
  if (own) return own;
  for (const p of pregnancies.values()) if (p.fatherId === agentId) return p;
  return undefined;
}

export function allPregnancies(): Pregnancy[] {
  return [...pregnancies.values()];
}

export function setPregnancy(p: Pregnancy): void {
  pregnancies.set(p.motherId, p);
}

export function endPregnancy(motherId: number): void {
  pregnancies.delete(motherId);
}

export function marriedSinceOf(a: number, b: number): number | undefined {
  return marriedSince.get(familyPairKey(a, b));
}

export function stampMarriedSince(a: number, b: number, minute: number): void {
  marriedSince.set(familyPairKey(a, b), minute);
}

/** Forget couples that are no longer married (widowed, estranged): `keep` is the live pair keys. */
export function pruneMarriedSince(keep: ReadonlySet<string>): void {
  for (const key of marriedSince.keys()) if (!keep.has(key)) marriedSince.delete(key);
}

export function pendingChristenings(): PendingChristening[] {
  return [...christenings].map(([childId, dueAt]) => ({ childId, dueAt }));
}

export function scheduleChristening(childId: number, dueAt: number): void {
  christenings.set(childId, dueAt);
}

export function dropChristening(childId: number): void {
  christenings.delete(childId);
}

export function pendingConfrontations(): PendingConfrontation[] {
  return [...confrontations.values()];
}

export function addConfrontation(c: PendingConfrontation): void {
  confrontations.set(familyPairKey(c.fatherId, c.loverId), c);
}

export function dropConfrontation(fatherId: number, loverId: number): void {
  confrontations.delete(familyPairKey(fatherId, loverId));
}

/** Drop every timer (world replace: agent and child ids are reused). */
export function clearFamilyState(): void {
  pregnancies.clear();
  marriedSince.clear();
  christenings.clear();
  confrontations.clear();
}

/**
 * Checkpoint: { pregnancies: {motherId: Pregnancy}, marriedSince: {pairKey:
 * minute}, christenings: {childId: minute}, confrontations: [...] }. Always an
 * object, so an empty town still overwrites an older world's row.
 */
export const familySnapshotStore: SnapshotStore = {
  key: 'family',
  version: 1,
  serialize: () => ({
    pregnancies: Object.fromEntries([...pregnancies].map(([k, v]) => [String(k), { ...v }])),
    marriedSince: Object.fromEntries(marriedSince),
    christenings: Object.fromEntries([...christenings].map(([k, v]) => [String(k), v])),
    confrontations: [...confrontations.values()].map((c) => ({ ...c })),
  }),
  restore: (data) => {
    clearFamilyState();
    const root = asRecord(data) ?? {};
    for (const [k, raw] of Object.entries(asRecord(root.pregnancies) ?? {})) {
      const motherId = asId(k);
      const r = asRecord(raw);
      if (motherId === null || !r) continue;
      const fatherId = asNumber(r.fatherId);
      const conceivedAt = asNumber(r.conceivedAt);
      if (fatherId === null || conceivedAt === null) continue;
      const p: Pregnancy = { motherId, fatherId, conceivedAt };
      const trueFatherId = asNumber(r.trueFatherId);
      const factId = asNumber(r.factId);
      const paternityFactId = asNumber(r.paternityFactId);
      if (trueFatherId !== null) p.trueFatherId = trueFatherId;
      if (factId !== null) p.factId = factId;
      if (paternityFactId !== null) p.paternityFactId = paternityFactId;
      if (r.spouseTold === true) p.spouseTold = true;
      if (r.announced === true) p.announced = true;
      if (r.paternityRevealed === true) p.paternityRevealed = true;
      pregnancies.set(motherId, p);
    }
    for (const [k, raw] of Object.entries(asRecord(root.marriedSince) ?? {})) {
      const minute = asNumber(raw);
      if (/^\d+-\d+$/.test(k) && minute !== null) marriedSince.set(k, minute);
    }
    for (const [k, raw] of Object.entries(asRecord(root.christenings) ?? {})) {
      const childId = asId(k);
      const dueAt = asNumber(raw);
      if (childId !== null && dueAt !== null) christenings.set(childId, dueAt);
    }
    for (const raw of Array.isArray(root.confrontations) ? root.confrontations : []) {
      const r = asRecord(raw);
      const fatherId = asNumber(r?.fatherId);
      const loverId = asNumber(r?.loverId);
      const since = asNumber(r?.since);
      if (fatherId !== null && loverId !== null && since !== null) addConfrontation({ fatherId, loverId, since });
    }
  },
};

// ─── Children: pure words ────────────────────────────────────────────────────

/** Whole game days since the birth (0 on the day itself). */
export function childAgeDays(birthMinute: number, nowMinute: number): number {
  return Math.max(0, Math.floor((nowMinute - birthMinute) / MINUTES_PER_DAY));
}

export function childStage(ageDays: number): ChildStage {
  if (ageDays < BABY_DAYS) return 'baby';
  if (ageDays < TODDLER_DAYS) return 'toddler';
  return 'child';
}

/** "baby daughter", "little son", "daughter". */
export function childNoun(sex: string, stage: ChildStage): string {
  const kin = sex === 'female' ? 'daughter' : 'son';
  if (stage === 'baby') return `baby ${kin}`;
  if (stage === 'toddler') return `little ${kin}`;
  return kin;
}

/** "newborn", "1 day old", "5 days old". */
export function ageLabel(ageDays: number): string {
  if (ageDays <= 0) return 'newborn';
  return `${ageDays} day${ageDays === 1 ? '' : 's'} old`;
}

/** "baby daughter Ana (2 days old)". */
export function describeChild(c: Pick<ChildRow, 'name' | 'sex' | 'birth_game_minute'>, nowMinute: number): string {
  const days = childAgeDays(c.birth_game_minute, nowMinute);
  return `${childNoun(c.sex, childStage(days))} ${c.name} (${ageLabel(days)})`;
}

function firstNameOf(full: string): string {
  return full.split(' ')[0] ?? full;
}

// ─── Children: DB readers ────────────────────────────────────────────────────

/**
 * Children of `agentId` still in town (as mother or believed father), eldest
 * first. A child who left town with a parent has no home and is not listed.
 */
export function childrenOf(agentId: number): ChildRow[] {
  return db.select().from(children)
    .where(and(
      eq(children.alive, true),
      isNotNull(children.home),
      or(eq(children.mother_id, agentId), eq(children.father_id, agentId)),
    ))
    .orderBy(asc(children.birth_game_minute), asc(children.id))
    .all();
}

/** Children in town with a mother or believed father among `ids`, eldest first. */
export function childrenOfAny(ids: readonly number[]): ChildRow[] {
  if (ids.length === 0) return [];
  return db.select().from(children)
    .where(and(
      eq(children.alive, true),
      isNotNull(children.home),
      or(inArray(children.mother_id, [...ids]), inArray(children.father_id, [...ids])),
    ))
    .orderBy(asc(children.birth_game_minute), asc(children.id))
    .all();
}

/** Every child in town, eldest first. */
export function childrenInTown(): ChildRow[] {
  return db.select().from(children)
    .where(and(eq(children.alive, true), isNotNull(children.home)))
    .orderBy(asc(children.birth_game_minute), asc(children.id))
    .all();
}

/** A friend must feel at least this warmly toward the parent to take their child in. */
export const GUARDIAN_MIN_FRIENDSHIP = 30;

/**
 * Who looks after `child` when `exceptId` (a parent who died or left) no
 * longer can: the other parent if still in town; else a grown-up already
 * living in the child's house; else the parent's closest friend (their
 * friendship toward the parent above GUARDIAN_MIN_FRIENDSHIP). The town has
 * no other kin ties, so "the closest relative" is the closest friend. Null
 * when nobody qualifies — the child then stays in the house, looked in on by
 * the neighbours, and inherits nothing through anyone.
 */
export function guardianFor(child: Pick<ChildRow, 'mother_id' | 'father_id' | 'home'>, exceptId: number | null): number | null {
  // A plain boolean, not a type predicate: a predicate would narrow the
  // parents' ids to `never`/`null` after the early returns below.
  const active = (id: number | null | undefined): boolean => {
    if (id == null || id === exceptId) return false;
    return db.select({ a: agents.is_active }).from(agents).where(eq(agents.id, id)).get()?.a === true;
  };
  if (active(child.mother_id)) return child.mother_id;
  if (child.father_id != null && active(child.father_id)) return child.father_id;

  if (child.home != null) {
    const housemate = db.select({ id: agents.id }).from(agents)
      .where(and(eq(agents.is_active, true), eq(agents.home, child.home)))
      .orderBy(asc(agents.id)).all()
      .find((r) => r.id !== exceptId);
    if (housemate) return housemate.id;
  }

  // The closest friend of either parent (whoever is gone, the town mourns them both).
  const parents = [child.mother_id, child.father_id].filter((id): id is number => id != null);
  let best: { id: number; f: number } | null = null;
  for (const parentId of parents) {
    const rels = db.select().from(relationships)
      .where(or(eq(relationships.agent_a, parentId), eq(relationships.agent_b, parentId))).all();
    for (const r of rels) {
      const other = r.agent_a === parentId ? r.agent_b : r.agent_a;
      if (other === exceptId || parents.includes(other)) continue;
      const f = r.agent_a === other ? r.friendship_ab : r.friendship_ba;
      if (f <= GUARDIAN_MIN_FRIENDSHIP) continue;
      if (!active(other)) continue;
      if (!best || f > best.f || (f === best.f && other < best.id)) best = { id: other, f };
    }
  }
  return best?.id ?? null;
}

/**
 * Who carries a baby about the house and on a stroll (the client's baby-bundle
 * held item): the mother of every baby-stage child, or the child's guardian
 * when she is gone. One carrier per baby, so a couple at home together don't
 * read as holding twins.
 */
export function babyCarriers(nowMinute: number): Set<number> {
  const out = new Set<number>();
  for (const c of childrenInTown()) {
    if (childStage(childAgeDays(c.birth_game_minute, nowMinute)) !== 'baby') continue;
    const carrier = guardianFor(c, null);
    if (carrier != null) out.add(carrier);
  }
  return out;
}

/**
 * `world_events.triggered_by` of a child's christening. Same shape as the
 * wedding's `wedding:<a>-<b>`: the decisions phase reads it to send the
 * parents to their own child's welcome.
 */
export function christeningTriggeredBy(childId: number): string {
  return `christening:${childId}`;
}

/** The child of a christening event, or null for anything else. */
export function parseChristeningTrigger(triggeredBy: string | null | undefined): number | null {
  const m = /^christening:(\d+)$/.exec(triggeredBy ?? '');
  return m ? Number(m[1]) : null;
}

/** The child's mother and (believed) father, whoever of them is set. */
export function parentsOfChild(childId: number): number[] {
  const c = db.select({ m: children.mother_id, f: children.father_id }).from(children)
    .where(eq(children.id, childId)).get();
  if (!c) return [];
  return [c.m, c.f].filter((id): id is number => id != null);
}

/** Friends congratulate for this many game days after a birth. */
export const CONGRATS_DAYS = 2;

/** The youngest child of `agentId` born in the last CONGRATS_DAYS, or null. */
export function newbornOf(agentId: number, nowMinute: number): ChildRow | null {
  const kids = childrenOf(agentId);
  const youngest = kids[kids.length - 1];
  if (!youngest) return null;
  return nowMinute - youngest.birth_game_minute < CONGRATS_DAYS * MINUTES_PER_DAY ? youngest : null;
}

// ─── Prompt lines ────────────────────────────────────────────────────────────

function nameMap(ids: number[]): Map<number, string> {
  if (ids.length === 0) return new Map();
  return new Map(db.select({ id: agents.id, name: agents.name }).from(agents)
    .where(inArray(agents.id, ids)).all().map((r) => [r.id, r.name]));
}

/** What this agent knows about a pregnancy they are part of, in the second person; '' when nothing. */
function pregnancyClause(agentId: number, names: Map<number, string>): string {
  const p = pregnancyInvolving(agentId);
  if (!p) return '';
  if (p.motherId === agentId) {
    const base = p.announced ? "You're expecting a baby" : "You're expecting a baby — nobody knows yet";
    if (p.trueFatherId != null && !p.paternityRevealed) {
      const lover = firstNameOf(names.get(p.trueFatherId) ?? 'your lover');
      const husband = firstNameOf(names.get(p.fatherId) ?? 'your husband');
      return `${base}, and you fear it is ${lover}'s, not ${husband}'s.`;
    }
    return `${base}.`;
  }
  if (p.fatherId === agentId && p.spouseTold) {
    return `${firstNameOf(names.get(p.motherId) ?? 'Your wife')} is expecting your baby.`;
  }
  return '';
}

/**
 * The one line an agent's conversation prompt gets about their family, or ''
 * for someone with no child and no baby on the way: "Your family: your baby
 * daughter Ana (2 days old). You're expecting a baby." Kept to one line on
 * purpose — the prompt is already long, and the child is flavour, not a topic
 * the model must steer to.
 */
export function familyPromptLine(agentId: number, nowMinute: number): string {
  const kids = childrenOf(agentId).slice(-3);
  const p = pregnancyInvolving(agentId);
  const names = nameMap(p ? [p.motherId, p.fatherId, ...(p.trueFatherId != null ? [p.trueFatherId] : [])] : []);
  const parts: string[] = [];
  if (kids.length > 0) parts.push(`Your family: ${kids.map((k) => `your ${describeChild(k, nowMinute)}`).join(', ')}.`);
  const preg = pregnancyClause(agentId, names);
  if (preg) parts.push(preg);
  return parts.join(' ');
}

/**
 * The daily plan's line: the family, and a light nudge to plan around it
 * ("parents plan around childcare lightly"). '' for anyone without one.
 */
export function familyPlanLine(agentId: number, nowMinute: number): string {
  const kids = childrenOf(agentId).slice(-3);
  const p = pregnancyInvolving(agentId);
  const parts: string[] = [];
  if (kids.length > 0) {
    const hasBaby = kids.some((k) => childStage(childAgeDays(k.birth_game_minute, nowMinute)) === 'baby');
    parts.push(`Family: ${kids.map((k) => describeChild(k, nowMinute)).join(', ')} — ${hasBaby
      ? 'set aside a little time at home for the baby'
      : 'spend a little time with them'}.`);
  }
  if (p?.motherId === agentId) parts.push("You're expecting a baby — take the day a little easier.");
  else if (p?.fatherId === agentId && p.spouseTold) parts.push('Your wife is expecting — look after her a little.');
  return parts.join(' ');
}
