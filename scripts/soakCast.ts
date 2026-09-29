/**
 * The cast a soak runs with: the wizard's default 13, trimmed or grown to `--agents N`.
 *
 * Why this exists: the wizard has no "cast size" field. The cast IS `agents[]` (its
 * `agentCount` for the layout preview is `agents.length`, WorldLayout.tsx), and a player who
 * wants more residents presses "+ New Resident", which adds a retired stranger with a random
 * personality. Thirty-two of those would be a town with no economy, so the extras here are
 * what a player who took the trouble to fill the town would plausibly add: the assistants,
 * hands and musicians of the workplaces the default town already has, plus a few retirees,
 * each on the schedule of the default resident who does that job.
 *
 * Deterministic in `seed`, so two soaks of the same seed and size are the same town.
 *
 * Pure: no DB imports (the soak imports server modules only after it has pointed
 * DATABASE_PATH at its temp file).
 */
import type { AgentConfig, RelationshipConfig } from '../src/components/setup/types';
import { getDefaultAgents, getDefaultRelationships } from '../src/components/setup/defaults';
import { JOBS, jobSalary, type JobKey } from '../server/data/jobs';
import { MAX_AGENTS } from '../server/lib/worldgen/config';

/** Jobs of the added residents, in the order they are handed out. All of them work at a workplace the default town has. */
const EXTRA_JOBS: JobKey[] = [
  'shop_assistant', 'farmhand', 'retired', 'handyperson', 'musician', 'medical_assistant', 'retired',
  'farmhand', 'shop_assistant', 'bartender', 'retired', 'handyperson', 'musician', 'farmhand',
  'shop_assistant', 'retired', 'medical_assistant', 'baker', 'retired',
];

const FIRST_NAMES = [
  'Ines', 'Tobias', 'Amara', 'Felix', 'Noor', 'Gustav', 'Mei', 'Rafael', 'Hana', 'Idris',
  'Petra', 'Anselm', 'Wanjiru', 'Lars', 'Sunita', 'Mateo', 'Freya', 'Kofi', 'Beatrix', 'Dmitri',
  'Zainab', 'Oskar', 'Leila', 'Joaquin', 'Ingrid', 'Tariq', 'Marisol', 'Bram', 'Yara', 'Casimir',
];
const LAST_NAMES = [
  'Alder', 'Brandt', 'Castillo', 'Dubois', 'Eklund', 'Farouk', 'Grimaldi', 'Holloway', 'Ibarra',
  'Jansen', 'Kowalczyk', 'Lindqvist', 'Moreau', 'Nakamura', 'Okafor', 'Petrenko', 'Quimby',
  'Rasmussen', 'Salazar', 'Thackeray', 'Ueda', 'Varga', 'Whitlock', 'Xavier', 'Yilmaz', 'Zeller',
];
const TRAITS = [
  'friendly', 'stubborn', 'curious', 'gossipy', 'proud', 'shy', 'generous', 'restless', 'thrifty',
  'romantic', 'sarcastic', 'devout', 'ambitious', 'forgetful', 'hot-tempered',
];
const ASPIRATIONS = ['knowledge', 'legacy', 'love', 'wealth'];

/** mulberry32: a tiny seeded PRNG (the soak's seed is a string, hashed to 32 bits first). */
function seededRng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SoakCast {
  agents: AgentConfig[];
  relationships: RelationshipConfig[];
}

export function buildSoakCast(count: number, seed: string): SoakCast {
  if (!Number.isInteger(count) || count < 2 || count > MAX_AGENTS) {
    throw new Error(`--agents must be a whole number from 2 to ${MAX_AGENTS} (got ${count})`);
  }
  const defaults = getDefaultAgents();
  const agents: AgentConfig[] = defaults.slice(0, count);

  const rng = seededRng(`cast:${seed}`);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)];
  const taken = new Set(agents.map((a) => a.name));
  const homeLoad = new Map<string, number>();
  for (const a of agents) homeLoad.set(a.homeName, (homeLoad.get(a.homeName) ?? 0) + 1);
  let nextHome = 1 + Math.max(0, ...agents.map((a) => Number(/(\d+)$/.exec(a.homeName)?.[1] ?? 0)));

  for (let i = agents.length; i < count; i++) {
    const job = EXTRA_JOBS[(i - defaults.length) % EXTRA_JOBS.length];
    // The schedule of the default resident who does the same job: work hours that match the
    // workplace's opening (the farm at dawn, the tavern at dusk) rather than one made up here.
    const model = defaults.find((d) => d.job === job) ?? defaults.find((d) => d.job === 'retired')!;

    let name = '';
    for (let tries = 0; tries < 200 && (!name || taken.has(name)); tries++) name = `${pick(FIRST_NAMES)} ${pick(LAST_NAMES)}`;
    if (taken.has(name)) name = `${name} ${i}`;
    taken.add(name);

    // A free bed in a house that already has someone before a new house: the wizard warns
    // above two per home, and the default cast leaves a few single residents.
    let homeName = [...homeLoad].find(([, n]) => n < 2)?.[0];
    if (!homeName) homeName = `Home ${nextHome++}`;
    homeLoad.set(homeName, (homeLoad.get(homeName) ?? 0) + 1);

    const axis = () => 20 + Math.floor(rng() * 60);
    const traits = [pick(TRAITS), pick(TRAITS)].filter((t, k, all) => all.indexOf(t) === k);
    agents.push({
      id: `soak-${i + 1}`,
      name,
      age: job === 'retired' ? 60 + Math.floor(rng() * 20) : 22 + Math.floor(rng() * 38),
      gender: rng() > 0.5 ? 'male' : 'female',
      bio: `${name} moved to Little Life and works as ${JOBS[job].title.toLowerCase()}.`,
      traits,
      job,
      jobTitle: JOBS[job].title,
      salary: jobSalary(job),
      homeName,
      workplaceName: JOBS[job].workplace,
      schedule: { ...model.schedule, freeTimePreferences: [...model.schedule.freeTimePreferences] },
      personality: {
        honesty: axis(), aggression: axis(), warmth: axis(), impulsiveness: axis(), vanity: axis(),
        curiosity: axis(), loyalty: axis(), morality: axis(), sensuality: axis(), neuroticism: axis(),
      },
      aspiration: { type: pick(ASPIRATIONS), intensity: Math.round((0.5 + rng() * 0.5) * 100) / 100 },
      backstoryMemories: [],
    });
  }

  // The default relationship graph names default residents; keep only the edges whose
  // both ends are in the cast (a trimmed cast would otherwise reference ghosts).
  const names = new Set(agents.map((a) => a.name));
  const relationships = getDefaultRelationships()
    .filter((r) => names.has(r.agentAName) && names.has(r.agentBName));
  return { agents, relationships };
}
