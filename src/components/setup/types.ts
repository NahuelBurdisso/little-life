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

export const HOME_OPTIONS = [
  'Home 1', 'Home 2', 'Home 3', 'Home 4', 'Home 5',
  'Home 6', 'Home 7', 'Home 8', 'Home 9',
];
