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
  weather: string;
  startHour: number;
  startDay: number;
}

// RulesConfig is now a dynamic Record — fields defined in configRegistry.ts
export type RulesConfig = Record<string, boolean | number | string>;

export interface SetupConfig {
  agents: AgentConfig[];
  relationships: RelationshipConfig[];
  world: WorldConfig;
  rules: RulesConfig;
}

export const DEFAULT_WORLD: WorldConfig = {
  season: 'spring',
  weather: 'sunny',
  startHour: 9,
  startDay: 1,
};

// DEFAULT_RULES generated from registry — no manual sync needed
import { getDefaultRules } from './configRegistry';
export const DEFAULT_RULES: RulesConfig = getDefaultRules();

export const JOB_OPTIONS = [
  { job: 'farmer', title: 'Farmer', salary: 25, workplace: 'Green Acres Farm' },
  { job: 'farmhand', title: 'Farmhand', salary: 18, workplace: 'Green Acres Farm' },
  { job: 'baker', title: 'Baker', salary: 22, workplace: "Priya's Bakery" },
  { job: 'bartender', title: 'Bartender', salary: 22, workplace: 'The Rusty Lantern' },
  { job: 'shopkeeper', title: 'Shopkeeper', salary: 24, workplace: "Rosa's General Store" },
  { job: 'shop_assistant', title: 'Shop Assistant', salary: 16, workplace: "Rosa's General Store" },
  { job: 'doctor', title: 'Doctor', salary: 30, workplace: "Dr. Petrov's Clinic" },
  { job: 'medical_assistant', title: 'Medical Assistant', salary: 20, workplace: "Dr. Petrov's Clinic" },
  { job: 'mayor', title: 'Mayor', salary: 28, workplace: 'Town Hall' },
  { job: 'handyperson', title: 'Handyperson', salary: 18, workplace: "Carlos' Workshop" },
  { job: 'musician', title: 'Musician', salary: 14, workplace: 'The Rusty Lantern' },
  { job: 'constable', title: 'Constable', salary: 26, workplace: 'Town Jail' },
  { job: 'retired', title: 'Retired', salary: 15, workplace: null },
];

// Homes auto-scale with agent count — this generates the options list
export function getHomeOptions(agentCount: number): string[] {
  const homesNeeded = Math.ceil(agentCount / 2);
  return Array.from({ length: homesNeeded }, (_, i) => `Home ${i + 1}`);
}

// Max homes per residential row × 2 rows
export const MAX_AGENTS = 32; // 8 homes per row × 2 rows × 2 capacity

// Drama setup types
export interface SliderConfig {
  drama: number;    // 0-100 — how often dramatic events fire
  romance: number;  // 0-100 — romantic tension probability
  crime: number;    // 0-100 — criminal behaviour rate
  trust: number;    // 0-100 — baseline inter-agent trust
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
