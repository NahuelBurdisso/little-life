/**
 * Who a mid-game New Resident (`nudge.introduce_agent`) is.
 *
 * The dialog only asks for a name, a bio, a few traits and a job. The router
 * used to fill in the rest with constants: `personality: null`, gender
 * 'neutral', age 25, a 9–17 shift for every job (a baker at the oven at noon, a
 * bartender off at five), and free-time preferences 'socializing'/'shopping',
 * which are not location types. A null personality quietly switched the
 * newcomer off for everything that reads it — reflections, snaps, drift,
 * effective-personality modifiers, the reflection threshold — so they walked
 * around as a blank. The client's resident art also steers skirts, beards and
 * grey hair by gender and age, so every newcomer looked like the same 25-year-old.
 *
 * Everything here is drawn from a seeded RNG (world seed + name), so the same
 * arrival in the same town comes out the same, and is a pure function: no DB,
 * testable without a world.
 */
import { AGENT_SEEDS } from '../data/agents';
import { makeRng, stringToSeed, type RNG } from './worldgen/rng';
import { startingNeeds, type StartingNeeds } from './startingNeeds';

export interface ResidentPersonality {
  honesty: number;
  aggression: number;
  warmth: number;
  impulsiveness: number;
  vanity: number;
  curiosity: number;
  loyalty: number;
  morality: number;
  sensuality: number;
  neuroticism: number;
}

export interface ResidentSchedule {
  wakeTime: number;
  sleepTime: number;
  workStart: number;
  workEnd: number;
  lunchTime: number;
  freeTimePreferences: string[];
}

export interface NewResidentInput {
  name: string;
  /** Player-written; blank gets a template bio. */
  bio: string;
  traits: string[];
  job: string;
  /** Anything stable per world — the worldgen seed — so reruns agree. */
  worldSeed: string | number;
  /**
   * Location types that exist in this town. Free-time preferences are picked
   * among them (a town with no tavern shouldn't send anyone there).
   */
  availableLocationTypes?: readonly string[];
  /**
   * Known gender. The dialog does not ask, so a player's newcomer is guessed
   * from the first name; a town-generated arrival (lib/populationFlow.ts) picks
   * the name from a gendered list and says which one it was.
   */
  gender?: 'female' | 'male';
}

export interface NewResidentProfile {
  age: number;
  gender: 'female' | 'male';
  bio: string;
  traits: string[];
  personality: ResidentPersonality;
  schedule: ResidentSchedule;
  jobTitle: string;
  salary: number;
  needs: StartingNeeds & { mood: number; stress: number };
}

const AXES: readonly (keyof ResidentPersonality)[] = [
  'honesty', 'aggression', 'warmth', 'impulsiveness', 'vanity',
  'curiosity', 'loyalty', 'morality', 'sensuality', 'neuroticism',
];

/**
 * How each trait the New Resident dialog offers (NewAgentDialog TRAIT_OPTIONS)
 * leans the personality axes. The player picked the traits to say who this
 * person is; a caring newcomer who rolls warmth 22 contradicts them.
 */
const TRAIT_BIAS: Record<string, Partial<ResidentPersonality>> = {
  hardworking: { impulsiveness: -15, loyalty: 10 },
  lazy: { impulsiveness: 10, neuroticism: -5 },
  introverted: { warmth: -10, sensuality: -10, vanity: -5 },
  extroverted: { warmth: 15, sensuality: 10, vanity: 5 },
  generous: { warmth: 15, morality: 10 },
  shrewd: { honesty: -15, curiosity: 10 },
  creative: { curiosity: 15, impulsiveness: 5 },
  practical: { impulsiveness: -10, curiosity: -5 },
  optimistic: { neuroticism: -20 },
  skeptical: { warmth: -5, neuroticism: 5, loyalty: -5 },
  patient: { aggression: -15, impulsiveness: -15 },
  impulsive: { impulsiveness: 20 },
  caring: { warmth: 20, aggression: -10 },
  independent: { loyalty: -10 },
};

/** Words for a strong axis, for bios and for traits when the player picked none. */
const HIGH_WORDS: Partial<Record<keyof ResidentPersonality, string>> = {
  honesty: 'blunt', aggression: 'hot-tempered', warmth: 'warm', impulsiveness: 'impulsive',
  vanity: 'vain', curiosity: 'curious', loyalty: 'loyal', morality: 'principled',
  sensuality: 'flirtatious', neuroticism: 'anxious',
};
const LOW_WORDS: Partial<Record<keyof ResidentPersonality, string>> = {
  aggression: 'gentle', warmth: 'reserved', impulsiveness: 'careful', vanity: 'modest',
  curiosity: 'incurious', neuroticism: 'calm',
};

/** Places anyone may spend free time at; the seeded cast's preferences use the same set. */
const LEISURE_TYPES = ['park', 'tavern', 'town_square', 'home'] as const;

/**
 * First names whose ending misleads the -a/-o rule below. Short on purpose:
 * the rule is only a prior, a wrong guess costs a skirt on the sprite.
 */
const MALE_EXCEPTIONS = new Set(['luca', 'nikita', 'joshua', 'ezra', 'noah', 'jonah', 'elijah', 'isa', 'mustafa', 'andrea', 'sasha', 'misha', 'ilya']);
const FEMALE_EXCEPTIONS = new Set(['margo', 'cleo', 'juno', 'harriet', 'ruth', 'esther', 'grace', 'rose', 'alice', 'beatrice', 'claire', 'eve', 'jane', 'kate', 'lucy', 'mary', 'sophie', 'chloe', 'zoe', 'ellen', 'helen', 'carmen', 'miriam', 'ingrid', 'astrid', 'margaret', 'elizabeth', 'isabel', 'mabel']);

function firstNameOf(name: string): string {
  return name.replace(/^(Dr|Mr|Mrs|Ms|Miss)\.?\s+/i, '').trim().split(/\s+/)[0] ?? name;
}

/** Plausible gender from the first name, seeded coin flip when the name says nothing. */
export function guessGender(name: string, rng: RNG): 'female' | 'male' {
  const first = firstNameOf(name).toLowerCase();
  if (MALE_EXCEPTIONS.has(first)) return 'male';
  if (FEMALE_EXCEPTIONS.has(first)) return 'female';
  if (/(a|ah|ette|elle|ine|ie|y)$/.test(first) && first.length > 2) return 'female';
  if (/(o|us|er|an|on|el|im|ck|rd|ld|nd)$/.test(first)) return 'male';
  return rng.next() < 0.5 ? 'female' : 'male';
}

/** Age band per job — nobody retires at 25 or runs the town at 19. */
function ageFor(job: string, rng: RNG): number {
  switch (job) {
    case 'retired': return rng.int(62, 78);
    case 'doctor': return rng.int(32, 62);
    case 'mayor': return rng.int(40, 66);
    case 'farmhand':
    case 'shop_assistant':
    case 'musician':
    case 'medical_assistant': return rng.int(18, 38);
    case 'unemployed': return rng.int(18, 45);
    default: return rng.int(22, 56);
  }
}

function clampAxis(v: number): number {
  return Math.max(5, Math.min(95, Math.round(v)));
}

/**
 * Same shape and base range as a wizard-added agent (AgentEditor
 * `randomPersonality`, uniform 20–79), leaned by the chosen traits.
 */
export function residentPersonality(traits: readonly string[], rng: RNG): ResidentPersonality {
  const p = {} as ResidentPersonality;
  for (const axis of AXES) p[axis] = 20 + Math.floor(rng.next() * 60);
  for (const trait of traits) {
    const bias = TRAIT_BIAS[trait.trim().toLowerCase()];
    if (!bias) continue;
    for (const [axis, delta] of Object.entries(bias) as [keyof ResidentPersonality, number][]) {
      p[axis] += delta;
    }
  }
  for (const axis of AXES) p[axis] = clampAxis(p[axis]);
  return p;
}

/** Up to `max` words for this personality's most pronounced axes. */
function personalityWords(p: ResidentPersonality, max: number): string[] {
  const scored = AXES.flatMap((axis) => {
    const out: Array<{ word: string; strength: number }> = [];
    const hi = HIGH_WORDS[axis];
    const lo = LOW_WORDS[axis];
    if (hi && p[axis] >= 65) out.push({ word: hi, strength: p[axis] - 50 });
    if (lo && p[axis] <= 35) out.push({ word: lo, strength: 50 - p[axis] });
    return out;
  });
  return scored.sort((a, b) => b.strength - a.strength).slice(0, max).map((s) => s.word);
}

function titleOf(job: string): string {
  if (!job || job === 'unemployed') return 'Unemployed';
  return job.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * The job's working day, from the seeded cast (server/data/agents.ts): the
 * baker starts at 5, the bartender works 15–23, the retired have no shift.
 * A job nobody in the catalog holds (or 'unemployed') gets the retired day.
 */
function scheduleFor(job: string): Omit<ResidentSchedule, 'freeTimePreferences'> & { salary: number } {
  const seed = AGENT_SEEDS.find((s) => s.job === job) ?? AGENT_SEEDS.find((s) => s.job === 'retired');
  const s = seed?.schedule ?? { wakeTime: 7, sleepTime: 22, workStart: 0, workEnd: 0, lunchTime: 12 };
  const jobless = !seed || seed.job !== job;
  return {
    wakeTime: s.wakeTime,
    sleepTime: s.sleepTime,
    workStart: jobless ? 0 : s.workStart,
    workEnd: jobless ? 0 : s.workEnd,
    lunchTime: s.lunchTime,
    // The seeded wage for the job; $20 is the floor every wage sits on (E5).
    salary: Math.max(20, seed && !jobless ? seed.salary : 20),
  };
}

function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

function templateBio(name: string, gender: 'female' | 'male', job: string, words: readonly string[]): string {
  const first = firstNameOf(name);
  const pronoun = gender === 'female' ? 'she' : 'he';
  const title = titleOf(job).toLowerCase();
  const arrival = job === 'unemployed'
    ? `${first} has just moved to town looking for work and a fresh start.`
    : job === 'retired'
      ? `${first} has just moved to town to spend the quiet years somewhere new.`
      : `${first} has just moved to town to work as ${article(title)} ${title}.`;
  if (words.length === 0) return `${arrival} Nobody knows much about ${gender === 'female' ? 'her' : 'him'} yet.`;
  const list = words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
  return `${arrival} The neighbours say ${pronoun} seems ${list}.`;
}

export function generateNewResident(input: NewResidentInput): NewResidentProfile {
  const job = input.job.trim().toLowerCase() || 'unemployed';
  const rng = makeRng(stringToSeed(`resident|${input.worldSeed}|${input.name.trim().toLowerCase()}`));

  // Guessed even when given, so the rest of the draw (age, personality) comes
  // out the same for a name with and without the override.
  const guessed = guessGender(input.name, rng);
  const gender = input.gender ?? guessed;
  const age = ageFor(job, rng);
  const traits = input.traits.map((t) => t.trim()).filter(Boolean);
  const personality = residentPersonality(traits, rng);
  const derivedWords = personalityWords(personality, 2);

  const { salary, ...hours } = scheduleFor(job);
  const available = new Set(input.availableLocationTypes ?? LEISURE_TYPES);
  const leisure = LEISURE_TYPES.filter((t) => t === 'home' || available.has(t));
  const freeTimePreferences = rng.shuffle(leisure).slice(0, 3);

  const bio = input.bio.trim() || templateBio(input.name, gender, job, traits.length > 0 ? traits.slice(0, 3) : derivedWords);

  return {
    age,
    gender,
    bio,
    // Prompts describe people by their traits; a newcomer with none read as
    // nobody in particular. Words from the rolled personality stand in.
    traits: traits.length > 0 ? traits : derivedWords,
    personality,
    schedule: { ...hours, freeTimePreferences },
    jobTitle: titleOf(job),
    salary,
    needs: {
      ...startingNeeds(() => rng.next()),
      // Moving house: a little excited, a little stressed.
      mood: rng.int(58, 78),
      stress: rng.int(15, 30),
    },
  };
}
