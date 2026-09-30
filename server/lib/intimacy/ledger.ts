import { isAdultAge } from './eligibility';

// ─── The Hearts ledger ───────────────────────────────────────────────────────
//
// One page for the player (the god of the town) answering "who loves whom, who
// is sneaking around, and what is the town whispering about?". A pure fold over
// a snapshot of the tables and the in-memory intimacy state the router gathers
// (routers/intimacy.ts): no DB, no clock, so the tests can walk every section
// and the client can import the types.
//
// Two rules shape every section:
//
//  - Nobody under 18 is ever listed. Every person a row names must be a real,
//    living resident whose age passes `isAdultAge` (which fails closed on a
//    missing or non-numeric age); a row that names anyone else is dropped whole.
//    A pair of children who somehow hold a "partners" status simply do not exist
//    here.
//  - The adult layer is opt-in. With `adultContent` off the ledger shows what the
//    town is allowed to have then (couples, first kisses, one-sided crushes, the
//    open gossip about kisses and affairs) and nothing of the adult layer:
//    no lovers, no longing bars, no first nights, and none of the scandals that
//    grow out of a night together (a sighting at dawn, an unwed pregnancy).
//
// The player is the god of this town, so a secret affair is shown as one
// (`secret: true`) rather than being hidden from them.
//
// Wording is discreet on purpose: the ledger says "spent the first night
// together" and never anything past that.

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** A one-sided crush needs at least this much romance from one side... */
export const CRUSH_MIN_ROMANCE = 40;
/** ...and the other side below this much, or it is reciprocated. */
export const CRUSH_RECIPROCATED_AT = 25;
/** Longing below this is background noise and is not charted. */
export const LONGING_MIN = 20;
/** At most this many longing bars and milestones and scandals are listed. */
export const LEDGER_MAX_LONGING = 8;
export const LEDGER_MAX_MILESTONES = 12;
export const LEDGER_MAX_SCANDALS = 12;

// ─── Input ───────────────────────────────────────────────────────────────────

export interface LedgerAgent {
  id: number;
  name: string;
  /** Anything that is not a finite number reads as a minor (`isAdultAge` fails closed). */
  age: unknown;
  is_active: boolean;
}

export interface LedgerRelationship {
  /** `agent_a < agent_b`, as stored. */
  a: number;
  b: number;
  status: string;
  tags: readonly string[];
  romanceAB: number;
  romanceBA: number;
  statusSinceMinute: number | null;
  /** Game minute of the wedding, when the family module remembers it. */
  marriedSinceMinute: number | null;
}

export interface LedgerPair {
  /** `agent_a < agent_b`, the same order as the relationship row. */
  a: number;
  b: number;
  kisses: number;
  trysts: number;
  firstKissAt: number | null;
  firstTrystAt: number | null;
  /** Nobody in town knows about their nights (yet). */
  secret: boolean;
}

export interface LedgerFact {
  id: number;
  type: string;
  subjectId: number;
  targetId: number | null;
  isPublic: boolean;
  knownBy: readonly number[];
}

export interface LedgerEvent {
  a: number;
  b: number;
  type: string;
  minute: number;
}

export interface LedgerSnapshot {
  nowMinute: number;
  adultContent: boolean;
  agents: readonly LedgerAgent[];
  relationships: readonly LedgerRelationship[];
  pairs: readonly LedgerPair[];
  /** agent id -> longing 0..100 */
  longing: Readonly<Record<number, number>>;
  /** Active facts only. */
  facts: readonly LedgerFact[];
  /** `first_kiss` / `first_tryst` relationship events (anything else is ignored). */
  events: readonly LedgerEvent[];
}

// ─── Output ──────────────────────────────────────────────────────────────────

export interface LedgerPerson {
  id: number;
  name: string;
}

export interface LedgerCouple {
  a: LedgerPerson;
  b: LedgerPerson;
  kind: 'married' | 'engaged' | 'partners';
  sinceMinute: number | null;
}

export interface LedgerLover {
  a: LedgerPerson;
  b: LedgerPerson;
  nights: number;
  kisses: number;
  firstNightMinute: number | null;
  /** Nobody in town knows. */
  secret: boolean;
}

export interface LedgerLonging {
  person: LedgerPerson;
  /** 0..100 */
  longing: number;
}

export interface LedgerCrush {
  from: LedgerPerson;
  to: LedgerPerson;
  romance: number;
}

export type ScandalKind = 'unwed_pregnancy' | 'affair' | 'tryst_seen' | 'kiss_seen';

export interface LedgerScandal {
  factId: number;
  kind: ScandalKind;
  a: LedgerPerson;
  /** The other party, when the story names one. */
  b: LedgerPerson | null;
  /** A discreet one-line telling. */
  text: string;
}

export interface LedgerMilestone {
  kind: 'first_kiss' | 'first_night';
  a: LedgerPerson;
  b: LedgerPerson;
  minute: number;
}

export interface Ledger {
  nowMinute: number;
  adultContent: boolean;
  couples: LedgerCouple[];
  lovers: LedgerLover[];
  /** Always empty with the adult layer off. */
  longing: LedgerLonging[];
  crushes: LedgerCrush[];
  scandals: LedgerScandal[];
  /** Newest first. */
  milestones: LedgerMilestone[];
}

// ─── Building it ─────────────────────────────────────────────────────────────

const COUPLE_RANK: Record<LedgerCouple['kind'], number> = { married: 0, engaged: 1, partners: 2 };

function coupleKind(r: LedgerRelationship): LedgerCouple['kind'] | null {
  if (r.tags.includes('married')) return 'married';
  if (r.tags.includes('engaged')) return 'engaged';
  if (r.status === 'partners' || r.tags.includes('partner')) return 'partners';
  return null;
}

export function buildLedger(s: LedgerSnapshot): Ledger {
  // Everyone a row may name: alive, in town and an adult.
  const people = new Map<number, LedgerPerson>();
  for (const a of s.agents) {
    if (a.is_active && isAdultAge(a.age)) people.set(a.id, { id: a.id, name: a.name });
  }
  /** Both people of a row, or null when either is not listable. */
  const both = (x: number, y: number): [LedgerPerson, LedgerPerson] | null => {
    const px = people.get(x);
    const py = people.get(y);
    return px && py && x !== y ? [px, py] : null;
  };
  const adult = s.adultContent;

  // --- Couples ---
  const couples: LedgerCouple[] = [];
  /** Married or engaged to each other (those pairs are not "lovers"), and the openly committed. */
  const committed = new Map<number, Set<number>>();
  const note = (x: number, y: number) => {
    for (const [p, q] of [[x, y], [y, x]] as const) {
      if (!committed.has(p)) committed.set(p, new Set());
      committed.get(p)!.add(q);
    }
  };
  const married = new Set<string>();
  const coupled = new Set<string>();
  for (const r of s.relationships) {
    const kind = coupleKind(r);
    if (!kind) continue;
    const pair = both(r.a, r.b);
    if (!pair) continue;
    note(r.a, r.b);
    coupled.add(`${r.a}-${r.b}`);
    if (kind === 'married') married.add(`${r.a}-${r.b}`);
    couples.push({
      a: pair[0], b: pair[1], kind,
      sinceMinute: kind === 'married' ? (r.marriedSinceMinute ?? r.statusSinceMinute) : r.statusSinceMinute,
    });
  }
  couples.sort((x, y) => COUPLE_RANK[x.kind] - COUPLE_RANK[y.kind] || x.a.id - y.a.id || x.b.id - y.b.id);

  // --- Lovers (adult layer) ---
  const lovers: LedgerLover[] = [];
  if (adult) {
    const tagged = new Set(s.relationships.filter((r) => r.tags.includes('lovers')).map((r) => `${r.a}-${r.b}`));
    const byKey = new Map<string, LedgerPair>(s.pairs.map((p) => [`${p.a}-${p.b}`, p]));
    const keys = new Set<string>([...tagged, ...s.pairs.filter((p) => p.trysts > 0).map((p) => `${p.a}-${p.b}`)]);
    for (const key of keys) {
      if (married.has(key)) continue;
      const p = byKey.get(key);
      const [x, y] = key.split('-').map(Number);
      const pair = both(x, y);
      if (!pair) continue;
      lovers.push({
        a: pair[0], b: pair[1],
        nights: p?.trysts ?? 0,
        kisses: p?.kisses ?? 0,
        firstNightMinute: p?.firstTrystAt ?? null,
        secret: p?.secret === true,
      });
    }
    // Secrets first (the player's to watch), then the deepest ties.
    lovers.sort((u, v) => Number(v.secret) - Number(u.secret) || v.nights - u.nights || u.a.id - v.a.id || u.b.id - v.b.id);
  }

  // --- Longing (adult layer) ---
  const longing: LedgerLonging[] = [];
  if (adult) {
    for (const [idText, value] of Object.entries(s.longing)) {
      const person = people.get(Number(idText));
      if (!person || !Number.isFinite(value) || value < LONGING_MIN) continue;
      longing.push({ person, longing: Math.min(100, Math.round(value)) });
    }
    longing.sort((u, v) => v.longing - u.longing || u.person.id - v.person.id);
    longing.length = Math.min(longing.length, LEDGER_MAX_LONGING);
  }

  // --- Crushes ---
  const crushes: LedgerCrush[] = [];
  for (const r of s.relationships) {
    const key = `${r.a}-${r.b}`;
    if (coupled.has(key) || r.tags.includes('lovers') || r.tags.includes('kissed')) continue;
    const pair = both(r.a, r.b);
    if (!pair) continue;
    if (r.romanceAB >= CRUSH_MIN_ROMANCE && r.romanceBA < CRUSH_RECIPROCATED_AT) {
      crushes.push({ from: pair[0], to: pair[1], romance: Math.round(r.romanceAB) });
    } else if (r.romanceBA >= CRUSH_MIN_ROMANCE && r.romanceAB < CRUSH_RECIPROCATED_AT) {
      crushes.push({ from: pair[1], to: pair[0], romance: Math.round(r.romanceBA) });
    }
  }
  crushes.sort((u, v) => v.romance - u.romance || u.from.id - v.from.id || u.to.id - v.to.id);

  // --- Scandals ---
  const scandals: LedgerScandal[] = [];
  for (const f of [...s.facts].sort((u, v) => v.id - u.id)) {
    const scandal = scandalOf(f, people, both, committed, adult);
    if (scandal) scandals.push(scandal);
  }
  scandals.length = Math.min(scandals.length, LEDGER_MAX_SCANDALS);

  // --- Milestones ---
  const milestones = buildMilestones(s, both, adult);

  return { nowMinute: s.nowMinute, adultContent: adult, couples, lovers, longing, crushes, scandals, milestones };
}

type Both = (x: number, y: number) => [LedgerPerson, LedgerPerson] | null;

/** The public-ish fact as a ledger row, or null when it is not one (yet) or names someone unlistable. */
function scandalOf(
  f: LedgerFact,
  people: ReadonlyMap<number, LedgerPerson>,
  both: Both,
  committed: ReadonlyMap<number, ReadonlySet<number>>,
  adult: boolean,
): LedgerScandal | null {
  switch (f.type) {
    case 'illegitimate_pregnancy': {
      // The fact is only born once she shows (intimacy/pregnancy.ts), so it is already the town's
      // business. An adult-layer story: gone with the rule. The named father, if any, must be
      // listable too (a row never names someone we would not list).
      if (!adult) return null;
      const mother = people.get(f.subjectId);
      if (!mother) return null;
      const father = f.targetId != null ? (people.get(f.targetId) ?? null) : null;
      if (f.targetId != null && !father) return null;
      return {
        factId: f.id, kind: 'unwed_pregnancy', a: mother, b: father,
        text: `${mother.name} is expecting, and the town is talking.`,
      };
    }
    case 'affair': {
      if (f.targetId == null) return null;
      const pair = both(f.subjectId, f.targetId);
      if (!pair) return null;
      const [x, y] = pair;
      // The betrayed: whoever the two are openly committed to, other than each other.
      const betrayed = [...(committed.get(x.id) ?? []), ...(committed.get(y.id) ?? [])]
        .filter((id) => id !== x.id && id !== y.id && f.knownBy.includes(id));
      const knower = betrayed.length > 0 ? people.get(betrayed[0]) : undefined;
      if (!f.isPublic && !knower) return null;
      return {
        factId: f.id, kind: 'affair', a: x, b: y,
        text: f.isPublic
          ? `${x.name} and ${y.name}: everyone knows about the affair.`
          : `${knower!.name} knows about ${x.name} and ${y.name}.`,
      };
    }
    case 'tryst_seen': {
      // Adult layer, and only once it is common knowledge: a sighting one person keeps to themselves is a secret.
      if (!adult || !f.isPublic || f.targetId == null) return null;
      const pair = both(f.subjectId, f.targetId);
      return pair
        ? { factId: f.id, kind: 'tryst_seen', a: pair[0], b: pair[1], text: `${pair[0].name} and ${pair[1].name} were seen together, and the town knows.` }
        : null;
    }
    case 'kiss_seen': {
      if (!f.isPublic || f.targetId == null) return null;
      const pair = both(f.subjectId, f.targetId);
      return pair
        ? { factId: f.id, kind: 'kiss_seen', a: pair[0], b: pair[1], text: `${pair[0].name} and ${pair[1].name} were seen kissing, and it is common knowledge.` }
        : null;
    }
    default:
      return null;
  }
}

/**
 * First kisses (always) and first nights (adult layer), newest first. The pivotal
 * relationship events are the source (kept forever); a pair's own stamps fill in
 * for any the event log lost, and a pair never lists the same milestone twice.
 */
function buildMilestones(s: LedgerSnapshot, both: Both, adult: boolean): LedgerMilestone[] {
  const found = new Map<string, LedgerMilestone>();
  const add = (kind: LedgerMilestone['kind'], x: number, y: number, minute: number) => {
    if (kind === 'first_night' && !adult) return;
    const lo = Math.min(x, y);
    const hi = Math.max(x, y);
    const pair = both(lo, hi);
    if (!pair || !Number.isFinite(minute)) return;
    const key = `${kind}:${lo}-${hi}`;
    const had = found.get(key);
    // Two rows for one milestone: the earliest is the first.
    if (!had || minute < had.minute) found.set(key, { kind, a: pair[0], b: pair[1], minute });
  };
  for (const e of s.events) {
    if (e.type === 'first_kiss') add('first_kiss', e.a, e.b, e.minute);
    else if (e.type === 'first_tryst') add('first_night', e.a, e.b, e.minute);
  }
  for (const p of s.pairs) {
    if (p.firstKissAt != null) add('first_kiss', p.a, p.b, p.firstKissAt);
    if (p.firstTrystAt != null) add('first_night', p.a, p.b, p.firstTrystAt);
  }
  return [...found.values()]
    .sort((u, v) => v.minute - u.minute || u.a.id - v.a.id || u.b.id - v.b.id)
    .slice(0, LEDGER_MAX_MILESTONES);
}
