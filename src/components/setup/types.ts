export interface PersonalityConfig {
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

export interface AgentConfig {
  id: string; // temp client-side ID
  name: string;
  age: number;
  gender: string;
  bio: string;
  traits: string[];
  job: string;
  jobTitle: string;
  salary: number;
  homeName: string;
  workplaceName: string | null;
  schedule: {
    wakeTime: number;
    sleepTime: number;
    workStart: number;
    workEnd: number;
    lunchTime: number;
    freeTimePreferences: string[];
  };
  personality: PersonalityConfig;
  backstoryMemories: string[];
  aspiration?: { type: string; intensity: number };
}

export interface RelationshipConfig {
  agentAName: string;
  agentBName: string;
  friendshipAB: number;
  friendshipBA: number;
  romanceAB: number;
  romanceBA: number;
  trustAB: number;
  trustBA: number;
  familiarity: number;
  status: string;
  tags: string[];
}

export interface WorldConfig {
  season: 'spring' | 'summer' | 'autumn' | 'winter';
  weather: 'sunny' | 'cloudy' | 'rainy' | 'stormy' | 'foggy' | 'snowy' | 'windy' | 'hot';
  startHour: number;
  startDay: number;
}

// RulesConfig is now a dynamic Record — fields defined in configRegistry.ts
export type RulesConfig = Record<string, boolean | number | string>;

export const DEFAULT_WORLD: WorldConfig = {
  season: 'spring',
  weather: 'sunny',
  startHour: 9,
  startDay: 1,
};

// DEFAULT_RULES generated from registry — no manual sync needed
import { getDefaultRules } from './configRegistry';
export const DEFAULT_RULES: RulesConfig = getDefaultRules();

// Daily wages; same scale as server/data/agents.ts (floor $20 = three meals + rent).
export const JOB_OPTIONS = [
  { job: 'farmer', title: 'Farmer', salary: 24, workplace: 'Green Acres Farm' },
  { job: 'farmhand', title: 'Farmhand', salary: 20, workplace: 'Green Acres Farm' },
  { job: 'baker', title: 'Baker', salary: 22, workplace: "Priya's Bakery" },
  { job: 'bartender', title: 'Bartender', salary: 22, workplace: 'The Rusty Lantern' },
  { job: 'shopkeeper', title: 'Shopkeeper', salary: 24, workplace: "Rosa's General Store" },
  { job: 'shop_assistant', title: 'Shop Assistant', salary: 20, workplace: "Rosa's General Store" },
  { job: 'doctor', title: 'Doctor', salary: 28, workplace: "Dr. Petrov's Clinic" },
  { job: 'medical_assistant', title: 'Medical Assistant', salary: 21, workplace: "Dr. Petrov's Clinic" },
  { job: 'mayor', title: 'Mayor', salary: 26, workplace: 'Town Hall' },
  { job: 'handyperson', title: 'Handyperson', salary: 20, workplace: "Carlos' Workshop" },
  { job: 'musician', title: 'Musician', salary: 20, workplace: 'The Rusty Lantern' },
  { job: 'constable', title: 'Constable', salary: 24, workplace: 'Town Jail' },
  { job: 'retired', title: 'Retired', salary: 20, workplace: null },
];

// Homes auto-scale with agent count — this generates the options list
export function getHomeOptions(agentCount: number): string[] {
  const homesNeeded = Math.ceil(agentCount / 2);
  return Array.from({ length: homesNeeded }, (_, i) => `Home ${i + 1}`);
}

// Re-exported from worldgen config so the wizard and the server enforce one
// number. It used to be declared here only, and `setup.previewWorld` had no cap
// at all. `TIER_DIMENSIONS` is re-exported for the same reason: the wizard's
// size dropdown used to carry its own copy of the tier sizes.
//
// The size bounds are re-exported for the same reason again, and this one was
// live: they were duplicated below under a "keep in sync" comment and had gone
// stale at 48×37 against the server's 56×43. `WorldLayout` seeds the Custom
// width/height inputs from the minimums, so picking "Custom" displayed 48×37 —
// which the `customDimensions` Zod bound then rejected on both `previewWorld`
// and `initialize`, making the Custom tier unusable.
export {
  MAX_AGENTS,
  TIER_DIMENSIONS,
  MIN_WIDTH as WORLDGEN_MIN_WIDTH,
  MAX_WIDTH as WORLDGEN_MAX_WIDTH,
  MIN_HEIGHT as WORLDGEN_MIN_HEIGHT,
  MAX_HEIGHT as WORLDGEN_MAX_HEIGHT,
} from '../../../server/lib/worldgen/config';

// Drama setup types
export interface SliderConfig {
  drama: number;    // 0-100 — how often dramatic events fire
  romance: number;  // 0-100 — romantic tension probability
  crime: number;    // 0-100 — criminal behaviour rate
  trust: number;    // 0-100 — baseline inter-agent trust
}

/**
 * What actually gets posted to `setup.initialize`. The seed is separate from
 * the worldgen seed because the Preview step runs before the World Layout step,
 * and the preview has to describe the town Start will really build.
 */
export interface ScenarioConfig extends SliderConfig {
  seed: string;
}

export interface DramaPreset {
  id: string;
  label: string;
  description: string;
  values: SliderConfig;
}

export const PRESETS: DramaPreset[] = [
  {
    id: 'cozy',
    label: 'Cozy Village',
    description: 'Warm, low-conflict, neighbours help each other',
    values: { drama: 15, romance: 30, crime: 5, trust: 80 },
  },
  {
    id: 'soap',
    label: 'Soap Opera',
    description: 'High drama, steamy romance, constant gossip',
    values: { drama: 80, romance: 75, crime: 20, trust: 40 },
  },
  {
    id: 'noir',
    label: 'Small-Town Noir',
    description: 'Dark secrets, crime under the surface, low trust',
    values: { drama: 60, romance: 25, crime: 70, trust: 20 },
  },
  {
    id: 'romance',
    label: 'Romance Novel',
    description: 'Love triangles everywhere, drama follows hearts',
    values: { drama: 50, romance: 90, crime: 10, trust: 55 },
  },
  {
    id: 'balanced',
    label: 'Balanced',
    description: 'Default mix — unpredictable and varied',
    values: { drama: 45, romance: 45, crime: 35, trust: 50 },
  },
];

/**
 * What the wizard opens on. Resolved here so the sliders and the highlighted
 * card can never disagree — the previous default named a preset id that no
 * longer existed, leaving no card selected.
 */
export const DEFAULT_PRESET: DramaPreset = PRESETS.find(p => p.id === 'balanced')!;

// ─── Worldgen ────────────────────────────────────────────────────────────────

export interface WorldGenOverrides {
  dimensions?: { width: number; height: number };
  homePositions?: Array<{ x: number; y: number }>;
}

export interface WorldGenConfig {
  seed?: string;
  sizeTier: 'medium' | 'large' | 'auto' | 'custom';
  customDimensions?: { width: number; height: number };
  overrides: WorldGenOverrides;
  /** Place households by the relationship graph (rivals near, secret lovers
   *  apart). Optional to match the server type; absent means on. */
  socialPlacement?: boolean;
  /** Road network: the fixed street grid, or lanes grown from settlement seeds
   *  (`server/lib/worldgen/stages/organicRoads.ts`). Optional to match the
   *  server type; absent means grid. */
  layoutStyle?: 'grid' | 'organic';
}

export const DEFAULT_WORLDGEN: WorldGenConfig = {
  sizeTier: 'auto',
  overrides: {},
  socialPlacement: true,
  layoutStyle: 'grid',
};
