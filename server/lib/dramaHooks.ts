import { isAdultAge } from './intimacy/eligibility';
import { firstName } from '../ai/names';
import type { GeneratedSecret, GeneratorAgent, RandomFn } from './setupGenerator';

/**
 * The opening hooks of a new town: a handful of stories that are already under
 * way at minute one, so a default start is not a calm town that takes days to
 * warm up.
 *
 * Why this exists. The drama sliders scale *counts* (secrets, romance threads,
 * low moods), but everything they seed was either mild (sensitivity 1-2 at the
 * Balanced preset), known only to its subject (so gossip had nothing to carry),
 * or depended on a slider the default never reaches (rivals only below trust 30).
 * A new player saw the default town spend its first days on small talk. The
 * hooks guarantee the shapes a story needs, whatever the sliders' dice say:
 *
 *   - a love triangle: a married (or engaged) couple, and one of them with a
 *     real, half-returned crush on a third — chaste, so it works with the adult
 *     rule off; the secret is known to one confidant;
 *   - a trade rivalry: two people who sell to the same town and have not had a
 *     civil word in months (a grudge, so it survives the relationship pass);
 *   - a debt: one resident owes another money, and the creditor is losing patience;
 *   - an ambition: someone means to unseat the mayor at the next election;
 *   - two old secrets (a crime someone else paid for, a hidden past);
 *   - the low-mood residents the drama slider already picks start lonely or
 *     bored, so the first evening has someone looking for company.
 *
 * Every juicy fact is known to its subject and one loose-lipped confidant
 * (honesty and morality at most 60: the only people gossip.ts lets pass on a
 * sensitivity-3 fact), so there is always someone who can spread it.
 *
 * Pure and seeded like the rest of the generator: the wizard's preview, the
 * Start that follows it and a later restart all see the same hooks. Adults only
 * — a minor is never cast in any of these. Coherent with the 1900 setting: a
 * married couple is a man and a woman who already share a house; with no such
 * pair free, the couple is engaged instead.
 */

// ─── Tuning ──────────────────────────────────────────────────────────────────

/** Drama slider (0-10) from which the hooks are seeded: Balanced (4.5) and up; Cozy (1.5) stays calm. */
export const HOOKS_MIN_DRAMA = 4;

/** Relationship values setup.ts writes for each hook (all -100..100 / 0..100). */
export const HOOK_VALUES = {
  /** A couple: over the partnership line (min > 65, avg > 70) so they read as partners even unwed. */
  spouseRomance: [72, 70] as const,
  spouseMinFriendship: 40,
  /** The straying partner's pull toward the third, and the third's (stronger) one back. */
  strayRomance: 42,
  admirerRomance: 55,
  /** Below −40 is the `rivals` status; a grudge tag keeps the pair a feud after the rival tag lapses. */
  rivalFriendship: -45,
  rivalTrust: -30,
  /** What the creditor feels toward the debtor, as a shift and a ceiling. */
  creditorFriendshipDelta: -25,
  creditorFriendshipMax: -15,
  creditorTrustDelta: -35,
  creditorTrustMax: -25,
  /** The debtor starts nearly broke: the debt is real, and `in_debt` is days away. */
  debtorMoney: 12,
  /** The challenger's view of the sitting mayor. */
  challengerFriendshipDelta: -15,
  challengerTrustDelta: -20,
} as const;

/** Needs of the lonely / bored low-mood residents (the lonely line is 20; the fun one 35). */
const LONELY_SOCIAL: readonly [number, number] = [26, 34];
const BORED_FUN: readonly [number, number] = [18, 28];

/** Jobs that sell to the town: the natural rivals. Pairs listed first are preferred. */
const TRADE_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['baker', 'shopkeeper'],
  ['bartender', 'baker'],
  ['bartender', 'shopkeeper'],
  ['farmer', 'shopkeeper'],
];
const TRADES = new Set(['baker', 'shopkeeper', 'bartender', 'farmer', 'handyperson', 'doctor']);
/** Not somebody's trade: no customers to fight over. */
const NO_TRADE = new Set(['retired', 'unemployed', 'mayor', 'student', 'child', 'none', '']);
/** Creditors in order of how naturally they would be owed: a tavern slate, then store credit. */
const CREDITOR_JOBS = ['bartender', 'shopkeeper', 'baker', 'doctor', 'farmer'];
/** Old enough to stand for mayor in 1900. */
const CHALLENGER_MIN_AGE = 30;
const MAX_COUPLE_AGE_GAP = 15;
/** A prison term or an invented past needs some years behind it. */
const PAST_MIN_AGE = 28;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TriangleHook {
  /** The couple; `straying` is one of them. */
  spouses: [number, number];
  bond: 'married' | 'engaged';
  straying: number;
  admirer: number;
}

export interface DramaHooks {
  triangle: TriangleHook | null;
  rivalry: { pair: [number, number]; reason: string } | null;
  debt: { debtor: number; creditor: number } | null;
  campaign: { challenger: number; mayor: number; ambition: string; goal: string } | null;
  /** Every hook's fact plus the old secrets, in the generator's secret shape. */
  secrets: GeneratedSecret[];
  /** Agent index → needs to open at instead of the drawn ones. */
  needs: Record<number, { social?: number; fun?: number }>;
  /** Agent index → first-person backstory lines the hooks add, so the LLM knows them too. */
  memories: Record<number, string[]>;
}

export const NO_HOOKS: DramaHooks = Object.freeze({
  triangle: null, rivalry: null, debt: null, campaign: null, secrets: [], needs: {}, memories: {},
}) as DramaHooks;

// ─── Helpers ─────────────────────────────────────────────────────────────────

const isMale = (a: GeneratorAgent) => /^m(ale)?$/i.test(a.gender ?? '');
const isFemale = (a: GeneratorAgent) => /^f(emale)?$/i.test(a.gender ?? '');
const subj = (a: GeneratorAgent) => (isMale(a) ? 'he' : isFemale(a) ? 'she' : 'they');
const obj = (a: GeneratorAgent) => (isMale(a) ? 'him' : isFemale(a) ? 'her' : 'them');
const poss = (a: GeneratorAgent) => (isMale(a) ? 'his' : isFemale(a) ? 'her' : 'their');
const oppositeSex = (a: GeneratorAgent, b: GeneratorAgent) =>
  (isMale(a) && isFemale(b)) || (isFemale(a) && isMale(b));
const trait = (a: GeneratorAgent, axis: string) => a.personality[axis] ?? 50;
/** Who gossip.ts lets pass on a sensitivity-3 fact (`getShareableFacts`' personality gates). */
const looseLipped = (a: GeneratorAgent) => trait(a, 'honesty') <= 60 && trait(a, 'morality') <= 60;

function pick<T>(items: readonly T[], rand: RandomFn): T | undefined {
  return items.length === 0 ? undefined : items[Math.floor(rand() * items.length)];
}

function shuffled<T>(items: readonly T[], rand: RandomFn): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function between([min, max]: readonly [number, number], rand: RandomFn): number {
  return min + Math.floor(rand() * (max - min + 1));
}

// ─── Generator ───────────────────────────────────────────────────────────────

/**
 * The opening hooks for `agents`, or NO_HOOKS below HOOKS_MIN_DRAMA.
 *
 * `takenByRomance` are the agents the slider's romance threads already cast:
 * the triangle keeps clear of them so two authored romances never write the
 * same pair. `lowMood` are the drama slider's troubled residents (section 5 of
 * the generator), in the order it picked them.
 */
export function generateDramaHooks(
  drama: number,
  agents: readonly GeneratorAgent[],
  rand: RandomFn,
  takenByRomance: ReadonlySet<number>,
  lowMood: readonly number[],
): DramaHooks {
  if (drama < HOOKS_MIN_DRAMA) return NO_HOOKS;

  const adults = agents.map((_, i) => i).filter((i) => isAdultAge(agents[i].age));
  const hooks: DramaHooks = { triangle: null, rivalry: null, debt: null, campaign: null, secrets: [], needs: {}, memories: {} };
  const remember = (i: number, line: string) => { (hooks.memories[i] ??= []).push(line); };
  const name = (i: number) => agents[i].name;
  const first = (i: number) => firstName(agents[i].name);
  const sameHome = (i: number, j: number) =>
    agents[i].homeName !== undefined && agents[i].homeName === agents[j].homeName;

  // A confidant per fact, spread over the loose-lipped so no one person holds
  // every secret in town (they would all come out in the same conversation).
  const confided = new Map<number, number>();
  const confidant = (exclude: readonly number[]): number | undefined => {
    const pool = adults.filter((i) => !exclude.includes(i));
    const loose = pool.filter((i) => looseLipped(agents[i]));
    const from = loose.length > 0 ? loose : pool;
    const least = Math.min(...from.map((i) => confided.get(i) ?? 0));
    const chosen = pick(from.filter((i) => (confided.get(i) ?? 0) === least), rand);
    if (chosen !== undefined) confided.set(chosen, (confided.get(chosen) ?? 0) + 1);
    return chosen;
  };
  const secret = (
    template_id: string, type: string, content: string,
    subject: number, target: number | null, knowers: number[],
  ) => {
    hooks.secrets.push({
      template_id, type, content, sensitivity: 3,
      subject_index: subject, target_index: target,
      known_by_indices: [...new Set(knowers)],
    });
  };

  // ── Love triangle ──────────────────────────────────────────────────────────
  // Agents the slider's romance threads left alone are preferred, but not
  // required: the hook's values win on the pairs it names (setup.ts applies it
  // last), and a spouse who is also somebody's rebound is only more story.
  const isFree = (i: number) => !takenByRomance.has(i);
  const couples: Array<[number, number]> = [];
  for (const i of adults) {
    for (const j of adults) {
      if (j <= i || !oppositeSex(agents[i], agents[j])) continue;
      if (Math.abs(agents[i].age - agents[j].age) > MAX_COUPLE_AGE_GAP) continue;
      couples.push([i, j]);
    }
  }
  const bothFree = ([i, j]: [number, number]) => isFree(i) && isFree(j);
  const housemates = couples.filter(([i, j]) => sameHome(i, j));
  // Engaged couples live apart in 1900: an unwed pair under one roof is its own scandal.
  const apart = couples.filter(([i, j]) => !sameHome(i, j));
  const coupleTiers: Array<[TriangleHook['bond'], Array<[number, number]>]> = [
    ['married', housemates.filter(bothFree)],
    ['married', housemates],
    ['engaged', apart.filter(bothFree)],
    ['engaged', apart],
  ];
  const warmth = (i: number) => trait(agents[i], 'sensuality') + trait(agents[i], 'impulsiveness');
  for (const [bond, tier] of coupleTiers) {
    if (hooks.triangle) break;
    // Every couple of the tier in a seeded order, until one has somebody to stray toward.
    for (const [a, b] of shuffled(tier, rand)) {
      const straying = warmth(a) === warmth(b) ? (rand() < 0.5 ? a : b) : warmth(a) > warmth(b) ? a : b;
      const admirers = adults.filter((i) => i !== a && i !== b
        && !sameHome(i, a)
        && Math.abs(agents[i].age - agents[straying].age) <= MAX_COUPLE_AGE_GAP);
      const opposite = (i: number) => oppositeSex(agents[i], agents[straying]);
      const admirerTiers = [
        admirers.filter((i) => isFree(i) && opposite(i)),
        admirers.filter(opposite),
        admirers.filter(isFree),
        admirers,
      ];
      const admirer = pick(admirerTiers.find((t) => t.length > 0) ?? [], rand);
      if (admirer === undefined) continue;
      hooks.triangle = { spouses: [a, b], bond, straying, admirer };
      break;
    }
  }
  if (hooks.triangle) {
    const { spouses: [a, b], bond, straying, admirer } = hooks.triangle;
    const partner = straying === a ? b : a;
    const S = agents[straying];
    const tie = bond === 'married' ? `is married to ${name(partner)}` : `is promised to ${name(partner)}`;
    const teller = confidant([straying, partner, admirer]);
    secret('hook_triangle', 'romantic',
      `${name(straying)} ${tie} but has lost ${poss(S)} heart to ${name(admirer)}`,
      straying, admirer, teller === undefined ? [straying] : [straying, teller]);
    if (bond === 'married') {
      remember(straying, `${first(partner)} and I have been married for years, and I would not undo it. But lately I look for ${first(admirer)} in every room I walk into.`);
      remember(partner, `${first(straying)} and I have been married for years. Lately ${subj(S)} seems far away, and I do not know why.`);
    } else {
      remember(straying, `I am promised to ${first(partner)}; we are to marry this year. Then ${first(admirer)} started looking at me the way ${first(partner)} never has, and I cannot stop thinking about it.`);
      remember(partner, `${first(straying)} and I are engaged to be married. I have never been so sure of anything.`);
    }
    remember(admirer, `I know ${first(straying)} ${bond === 'married' ? 'is married' : `is promised to ${first(partner)}`}. I should put ${obj(S)} out of my head. I have not managed it.`);
  }
  const spouses = new Set(hooks.triangle?.spouses ?? []);

  // ── Trade rivalry ──────────────────────────────────────────────────────────
  const workers = adults.filter((i) => !spouses.has(i) && !NO_TRADE.has(agents[i].job ?? ''));
  const pairsOf = (ok: (x: string, y: string) => boolean) => {
    const out: Array<[number, number]> = [];
    for (const i of workers) {
      for (const j of workers) {
        if (j <= i || sameHome(i, j)) continue;
        if (ok(agents[i].job ?? '', agents[j].job ?? '')) out.push([i, j]);
      }
    }
    return out;
  };
  const tiers = [
    ...TRADE_PAIRS.map(([x, y]) => pairsOf((p, q) => (p === x && q === y) || (p === y && q === x))),
    pairsOf((p, q) => p === q && TRADES.has(p)),
    pairsOf(() => true),
  ];
  const rivals = pick(tiers.find((t) => t.length > 0) ?? [], rand);
  if (rivals) {
    const [i, j] = rivals;
    const jobs = [agents[i].job, agents[j].job];
    const baker = jobs.includes('baker') && jobs.includes('shopkeeper') ? (agents[i].job === 'baker' ? i : j) : null;
    const reason = baker !== null
      ? `${first(baker === i ? j : i)} started selling bread at the store for less than ${first(baker)}'s`
      : jobs[0] === jobs[1]
        ? 'they started fighting over the same customers'
        : 'a quarrel over money that neither of them will let go';
    hooks.rivalry = { pair: [i, j], reason };
    // Common knowledge, not a secret: the whole town has watched them not speak.
    // Sensitivity 1, so it passes between anyone who shares a room (gossip.ts).
    const onlookers = adults.filter((k) => k !== i && k !== j);
    const seen = [pick(onlookers, rand), pick(onlookers, rand)].filter((k): k is number => k !== undefined);
    hooks.secrets.push({
      template_id: 'hook_rivalry', type: 'grudge',
      content: `${name(i)} and ${name(j)} have been at each other's throats since ${reason}`,
      sensitivity: 1, subject_index: i, target_index: j,
      known_by_indices: [...new Set([i, j, ...seen])],
    });
    remember(i, `${first(j)} and I have not had a civil word since ${reason}. I will not let ${obj(agents[j])} get the better of me.`);
    remember(j, `${first(i)} and I have not had a civil word since ${reason}. Everyone in town knows it.`);
  }

  // ── Debt ───────────────────────────────────────────────────────────────────
  const rivalSet = new Set(hooks.rivalry?.pair ?? []);
  const creditorRank = (i: number) => {
    const r = CREDITOR_JOBS.indexOf(agents[i].job ?? '');
    return r === -1 ? CREDITOR_JOBS.length : r;
  };
  const creditors = adults
    .filter((i) => !rivalSet.has(i) && agents[i].job !== 'mayor')
    .sort((x, y) => creditorRank(x) - creditorRank(y) || (agents[y].salary ?? 0) - (agents[x].salary ?? 0) || x - y);
  const creditor = creditors[0];
  if (creditor !== undefined) {
    // The worst-paid (within a couple of dollars of the bottom), and of those
    // the three least careful with money: the impulsive run up slates.
    const owing = adults.filter((i) => i !== creditor && !sameHome(i, creditor) && agents[i].job !== 'mayor');
    const bottom = Math.min(...owing.map((i) => agents[i].salary ?? 0));
    const debtors = owing
      .filter((i) => (agents[i].salary ?? 0) <= bottom + 2)
      .sort((x, y) => trait(agents[y], 'impulsiveness') - trait(agents[x], 'impulsiveness') || x - y)
      .slice(0, 3);
    const debtor = pick(debtors, rand);
    if (debtor !== undefined) {
      hooks.debt = { debtor, creditor };
      const C = agents[creditor];
      const how = C.job === 'bartender'
        ? `has run up a slate at ${first(creditor)}'s bar all winter and cannot pay it`
        : C.job === 'shopkeeper'
          ? `has bought on credit at ${first(creditor)}'s store all winter and cannot pay it back`
          : `borrowed money from ${first(creditor)} last winter and has not paid back a cent`;
      const teller = confidant([debtor, creditor]);
      secret('hook_debt', 'debt',
        `${name(debtor)} owes ${name(creditor)} money and has been avoiding ${obj(C)}: ${subj(agents[debtor])} ${how}`,
        debtor, creditor, [debtor, creditor, ...(teller === undefined ? [] : [teller])]);
      remember(debtor, `I owe ${first(creditor)} money I do not have. I cross the street when I see ${obj(C)} coming.`);
      remember(creditor, `${first(debtor)} owes me, and keeps finding reasons not to pay. My patience is running out.`);
    }
  }

  // ── The mayor's challenger ─────────────────────────────────────────────────
  const mayor = adults.find((i) => agents[i].job === 'mayor');
  if (mayor !== undefined) {
    const ambition = (i: number) =>
      trait(agents[i], 'vanity') + trait(agents[i], 'aggression') / 2 + (100 - trait(agents[i], 'loyalty')) / 2;
    const hopefuls = adults
      .filter((i) => i !== mayor && !spouses.has(i) && agents[i].age >= CHALLENGER_MIN_AGE)
      .sort((x, y) => ambition(y) - ambition(x) || x - y)
      .slice(0, 2);
    const challenger = pick(hopefuls, rand);
    if (challenger !== undefined) {
      const M = agents[mayor];
      hooks.campaign = {
        challenger,
        mayor,
        // Words election.ts reads as wanting the job ("mayor", "run the town").
        ambition: `to unseat Mayor ${M.name} and run the town myself`,
        goal: `Unseat Mayor ${name(mayor)} at the next election: win people over, and let the town see what ${subj(M)} gets wrong`,
      };
      const teller = confidant([challenger, mayor]);
      secret('hook_campaign', 'secret_ambition',
        `${name(challenger)} is quietly lining up votes to unseat Mayor ${name(mayor)}`,
        challenger, mayor, teller === undefined ? [challenger] : [challenger, teller]);
      remember(challenger, `${first(mayor)} has run this town for too long. Come the next election I mean to take the mayor's chair from ${obj(M)}, and I am counting who would back me.`);
    }
  }

  // ── Two old secrets ────────────────────────────────────────────────────────
  const hooked = new Set<number>([
    ...spouses, ...(hooks.triangle ? [hooks.triangle.admirer] : []), ...rivalSet,
    ...(hooks.debt ? [hooks.debt.debtor, hooks.debt.creditor] : []),
    ...(hooks.campaign ? [hooks.campaign.challenger] : []),
  ]);
  const pastSubject = (axis: string, exclude: ReadonlySet<number>): number | undefined => {
    // Old enough to have had a past somewhere else.
    const grown = adults.filter((i) => !exclude.has(i) && agents[i].age >= PAST_MIN_AGE);
    const pool = grown.length > 0 ? grown : adults.filter((i) => !exclude.has(i));
    const unhooked = pool.filter((i) => !hooked.has(i));
    const from = unhooked.length > 0 ? unhooked : pool;
    // The less honest / moral half of the candidates.
    const ranked = [...from].sort((x, y) => trait(agents[x], axis) - trait(agents[y], axis) || x - y);
    return pick(ranked.slice(0, Math.max(1, Math.ceil(ranked.length / 2))), rand);
  };

  // Worded to fit anyone in town, born here or not: the cast's authored
  // backstories say who grew up where, and a secret must not contradict them.
  const convict = pastSubject('morality', new Set());
  if (convict !== undefined) {
    const C = agents[convict];
    const crimes = [
      {
        fact: `${name(convict)} once stole a month's takings from ${poss(C)} employer and let another worker take the blame`,
        memory: `Years ago I stole a month's takings from my employer and let another worker take the blame. He was turned out. I have never told a soul.`,
      },
      {
        fact: `${name(convict)} forged a signature to get out of a debt years ago, and the man who was blamed left in disgrace`,
        memory: `Years ago I forged a signature to get out of a debt, and another man was blamed and ruined for it. I think about him more than I should.`,
      },
      {
        fact: `${name(convict)} started the fire that burned down a neighbour's barn years ago, and has never said a word`,
        memory: `The barn fire years ago was my doing: a lamp I knocked over and ran from. Nobody ever asked me, and I never said.`,
      },
    ];
    const crime = pick(crimes, rand)!;
    const teller = confidant([convict]);
    secret('hook_past_crime', 'past', crime.fact, convict, null, teller === undefined ? [convict] : [convict, teller]);
    remember(convict, crime.memory);
  }

  const liar = pastSubject('honesty', new Set(convict === undefined ? [] : [convict]));
  if (liar !== undefined) {
    const lies = [
      {
        fact: `${name(liar)} has a child in the next county that no one here knows about`,
        memory: `There is a child in the next county who is mine. I send money when I can. No one here knows, and no one can.`,
      },
      {
        fact: `${name(liar)} sends money every month to someone in the city and lies to everyone about where it goes`,
        memory: "Every month I send money to someone in the city, and when people ask I lie about where it goes. It is nobody's business but mine.",
      },
    ];
    const lie = pick(lies, rand)!;
    const teller = confidant([liar]);
    secret('hook_past_lie', 'past', lie.fact, liar, null, teller === undefined ? [liar] : [liar, teller]);
    remember(liar, lie.memory);
  }

  // ── Lonely and bored ───────────────────────────────────────────────────────
  // The drama slider's low-mood residents (already stressed and down) also open
  // short of company or of fun, so the first evening has someone looking for it.
  const [lonely, bored] = lowMood.filter((i) => isAdultAge(agents[i].age));
  if (lonely !== undefined) hooks.needs[lonely] = { social: between(LONELY_SOCIAL, rand) };
  if (bored !== undefined) hooks.needs[bored] = { fun: between(BORED_FUN, rand) };

  return hooks;
}
