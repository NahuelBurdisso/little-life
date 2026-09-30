/**
 * Stable facts a resident states about themselves: how long they have held
 * their trade, how long they have lived in town, their household.
 *
 * Why: the dialogue prompt only carried the bio — and once reflection writes a
 * self-description, not even that (prompts.ts uses one or the other). Playtest
 * #3: Thomas told Rosa he had kept order "for twelve years" (his seeded bio)
 * and Yuki the next day "for five years" (his self-description had dropped the
 * number, so the model invented one). A few numbers, fixed once and repeated
 * in every prompt, stop the drift.
 *
 * Pure: `deriveTenure` reads what the bio says ("mayor for twelve years",
 * "moved to town eight years ago") and fills the rest deterministically from
 * age and a hash of the name, so the same resident always gets the same
 * numbers. `helpers/selfFactsStore.ts` stores them on the agent row.
 */

const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60,
};

function parseCount(word: string): number | null {
  const w = word.toLowerCase();
  if (/^\d+$/.test(w)) return Number(w);
  if (NUMBER_WORDS[w] != null) return NUMBER_WORDS[w];
  // "twenty-five"
  const [tens, ones] = w.split('-');
  if (ones && NUMBER_WORDS[tens] != null && NUMBER_WORDS[ones] != null) return NUMBER_WORDS[tens] + NUMBER_WORDS[ones];
  return null;
}

const COUNT = String.raw`(\d+|[a-z]+(?:-[a-z]+)?)`;
const QUALIFIER = String.raw`(?:over\s+|nearly\s+|almost\s+|about\s+|some\s+|more\s+than\s+)?`;
/** "moved to town eight years ago", "came to Little Life three years ago". */
const ARRIVED_RE = new RegExp(String.raw`\b(?:moved|came|arrived|settled|transferred)\b[^.]{0,60}?\b${QUALIFIER}${COUNT}\s+years?\s+ago`, 'i');
/** Came from elsewhere, however long ago: "came to Little Life years ago as a refugee". */
const INCOMER_RE = /\b(?:moved|came|arrived|settled|transferred)\s+(?:to|here|in)\b/i;
/** "a position he's held for twelve years", "a fixture ... for over twenty years". */
const TENURE_RE = new RegExp(String.raw`\bfor\s+(?:the\s+(?:last|past)\s+)?${QUALIFIER}${COUNT}\s+years?\b`, 'i');
/** "I inherited Green Acres Farm from my parents five years ago." */
const JOB_SINCE_RE = new RegExp(String.raw`\b(?:inherited|took over|opened|started|became)\b[^.]{0,60}?\b${QUALIFIER}${COUNT}\s+years?\s+ago`, 'i');
/** Born or raised here: a lifelong resident. */
const NATIVE_RE = /\b(?:grew up here|born (?:and raised )?here|born in (?:town|the village)|lifelong|(?:took|taken) over after (?:her|his|their) parents|daughter of|son of)\b/i;
/** A spouse who died: the household fact the bio carries and self-descriptions drop. */
const WIDOWED_RE = /\b(?:widow(?:ed|er)?|(?:his|her|their) (?:wife|husband)(?: \w+)? (?:passed|died)|lost (?:his|her|their) (?:wife|husband))\b/i;

/** Jobs that have no "years in the trade". */
function hasTrade(job: string | null | undefined): boolean {
  return !!job && !/^(?:retired|unemployed|none|jobless)$/i.test(job);
}

/** A small deterministic hash in [0, 1) — the same resident always rolls the same numbers. */
function unitHash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007;
}

export interface TenureInput {
  name: string;
  age: number;
  bio: string;
  job: string | null;
  /** A recent arrival (lib/newcomers.ts): new in town, whatever the bio says. */
  newcomer?: boolean;
}

export interface Tenure {
  yearsInTown: number;
  /** Null for someone without a trade (retired, unemployed). */
  jobYears: number | null;
}

export function deriveTenure(p: TenureInput): Tenure {
  const age = Math.max(1, Math.round(p.age));
  const adult = Math.max(1, age - 18);
  const bio = p.bio ?? '';

  let yearsInTown: number;
  const arrived = bio.match(ARRIVED_RE);
  const arrivedYears = arrived ? parseCount(arrived[1]) : null;
  if (p.newcomer) yearsInTown = 0;
  else if (arrivedYears != null) yearsInTown = Math.min(age, arrivedYears);
  else if (NATIVE_RE.test(bio) || (!INCOMER_RE.test(bio) && unitHash(`${p.name}|town`) < 0.6)) yearsInTown = age;
  else yearsInTown = Math.min(age, 2 + Math.floor(unitHash(`${p.name}|moved`) * adult));

  let jobYears: number | null = null;
  if (hasTrade(p.job)) {
    const tenure = bio.match(TENURE_RE) ?? bio.match(JOB_SINCE_RE);
    const stated = tenure ? parseCount(tenure[1]) : null;
    if (stated != null) jobYears = Math.min(adult + 4, stated);
    else {
      // Somewhere between a fifth and four fifths of their working life,
      // never longer than they have lived here unless they are new (they
      // brought the trade with them).
      const frac = 0.2 + unitHash(`${p.name}|job`) * 0.6;
      jobYears = Math.max(1, Math.round(adult * frac));
      if (!p.newcomer && yearsInTown < age) jobYears = Math.min(jobYears, Math.max(1, yearsInTown));
    }
  }
  return { yearsInTown, jobYears };
}

export function isWidowed(bio: string | null | undefined): boolean {
  return WIDOWED_RE.test(bio ?? '');
}

export interface SelfFactsInput {
  jobTitle: string | null;
  tenure: Tenure;
  age: number;
  /** "married to Rosa", "engaged to Diego", "courting Yuki" — from the relationships table. */
  household?: string | null;
  widowed?: boolean;
}

function years(n: number): string {
  return n === 1 ? 'a year' : `${n} years`;
}

/**
 * The prompt line: "Facts about you (keep them straight): Mayor for 12 years;
 * born and raised here; widowed." Empty when there is nothing to say.
 */
export function selfFactsLine(f: SelfFactsInput): string {
  const facts: string[] = [];
  const title = f.jobTitle?.trim();
  // "Retired Teacher" has no years in a trade (the identity line says retired).
  if (title && f.tenure.jobYears != null && !/^(?:retired|unemployed)\b/i.test(title)) {
    // 0: a job change (lib/careers.ts) restarts the count.
    facts.push(f.tenure.jobYears > 0 ? `${title} for ${years(f.tenure.jobYears)}` : `recently took up work as ${title}`);
  }
  const t = f.tenure.yearsInTown;
  if (t <= 0) facts.push('new in town');
  else if (t >= f.age) facts.push('born and raised here');
  else facts.push(`came to town ${years(t)} ago`);
  if (f.household) facts.push(f.household);
  else if (f.widowed) facts.push('widowed');
  return `Facts about you (keep them straight): ${facts.join('; ')}.`;
}
