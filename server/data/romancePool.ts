// ─── Types ─────────────────────────────────────────────────────────────────

export interface RomanceTemplate {
  id: string;
  type: 'mutual_crush' | 'unrequited' | 'love_triangle' | 'secret_fling' | 'emerging_tension' | 'jealousy_seed' | 'rival_suitors' | 'forbidden' | 'rebound' | 'slow_burn';
  description: string;
  /** Number of agents involved (2 or 3) */
  agent_count: 2 | 3;
  /** Romance values to set: [agentIndex, agentIndex, value] */
  romance_values: Array<{ from: number; to: number; value: number }>;
  /** Friendship adjustments */
  friendship_adjustments?: Array<{ from: number; to: number; delta: number }>;
  /** Trust adjustments */
  trust_adjustments?: Array<{ from: number; to: number; delta: number }>;
  /** Whether this creates a shared_knowledge entry */
  creates_secret: boolean;
  /** Secret template if creates_secret is true */
  secret_template?: string;
  secret_sensitivity?: 1 | 2;
  /** Who knows about it (agent indices + optional "friend" meaning a random friend) */
  known_by?: Array<number | 'friend'>;
  /** Personality constraints per agent slot */
  constraints?: Record<number, Record<string, number>>;
  /** Maximum age gap between agents */
  max_age_gap?: number;
}

// ─── Pool ──────────────────────────────────────────────────────────────────

export const ROMANCE_POOL: RomanceTemplate[] = [
  {
    id: 'mutual_crush',
    type: 'mutual_crush',
    description: 'Both have feelings, neither has confessed',
    agent_count: 2,
    romance_values: [{ from: 0, to: 1, value: 50 }, { from: 1, to: 0, value: 45 }],
    creates_secret: true,
    secret_template: '{agent_0} has a crush on {agent_1}',
    secret_sensitivity: 2,
    known_by: [0, 'friend'],
    constraints: { 0: { sensuality: 30 } },
    max_age_gap: 15,
  },
  {
    id: 'unrequited',
    type: 'unrequited',
    description: 'One-sided longing, creates awkwardness',
    agent_count: 2,
    romance_values: [{ from: 0, to: 1, value: 55 }, { from: 1, to: 0, value: 0 }],
    creates_secret: true,
    secret_template: '{agent_0} has unrequited feelings for {agent_1}',
    secret_sensitivity: 2,
    known_by: [0],
    constraints: { 0: { sensuality: 30 } },
    max_age_gap: 20,
  },
  {
    id: 'love_triangle',
    type: 'love_triangle',
    description: 'A and B mutual, C also has feelings for B',
    agent_count: 3,
    romance_values: [
      { from: 0, to: 1, value: 45 }, { from: 1, to: 0, value: 40 },
      { from: 2, to: 1, value: 50 },
    ],
    creates_secret: true,
    secret_template: '{agent_2} also has feelings for {agent_1}',
    secret_sensitivity: 2,
    known_by: [2],
    max_age_gap: 15,
  },
  {
    id: 'secret_fling',
    type: 'secret_fling',
    description: 'Past encounter, trying to act normal',
    agent_count: 2,
    romance_values: [{ from: 0, to: 1, value: 30 }, { from: 1, to: 0, value: 25 }],
    trust_adjustments: [{ from: 0, to: 1, delta: -10 }, { from: 1, to: 0, delta: -10 }],
    creates_secret: true,
    secret_template: '{agent_0} and {agent_1} had a secret encounter',
    secret_sensitivity: 2,
    known_by: ['friend'],
    constraints: { 0: { sensuality: 50 }, 1: { sensuality: 50 } },
    max_age_gap: 15,
  },
  {
    id: 'emerging_tension',
    type: 'emerging_tension',
    description: 'Friends/roommates with unacknowledged warmth',
    agent_count: 2,
    romance_values: [{ from: 0, to: 1, value: 15 }, { from: 1, to: 0, value: 10 }],
    friendship_adjustments: [{ from: 0, to: 1, delta: 20 }, { from: 1, to: 0, delta: 20 }],
    creates_secret: false,
    max_age_gap: 20,
  },
  {
    id: 'jealousy_seed',
    type: 'jealousy_seed',
    description: 'A saw B flirt with C, A has feelings for B',
    agent_count: 3,
    romance_values: [{ from: 0, to: 1, value: 40 }],
    friendship_adjustments: [{ from: 0, to: 2, delta: -20 }],
    trust_adjustments: [{ from: 0, to: 1, delta: -15 }],
    creates_secret: true,
    secret_template: '{agent_0} saw {agent_1} flirting with {agent_2}',
    secret_sensitivity: 1,
    known_by: [0, 1, 2],
    max_age_gap: 15,
  },
  {
    id: 'rival_suitors',
    type: 'rival_suitors',
    description: 'Two people both have feelings for the same person',
    agent_count: 3,
    romance_values: [{ from: 0, to: 2, value: 45 }, { from: 1, to: 2, value: 50 }],
    friendship_adjustments: [{ from: 0, to: 1, delta: -10 }],
    creates_secret: false,
    max_age_gap: 15,
  },
  {
    id: 'forbidden',
    type: 'forbidden',
    description: 'Feelings across a barrier (age, employer, etc)',
    agent_count: 2,
    romance_values: [{ from: 0, to: 1, value: 35 }],
    creates_secret: true,
    secret_template: '{agent_0} has forbidden feelings for {agent_1}',
    secret_sensitivity: 2,
    known_by: [0],
    constraints: { 0: { sensuality: 30 } },
  },
  {
    id: 'rebound',
    type: 'rebound',
    description: 'Recently lost someone, new interest appears',
    agent_count: 2,
    romance_values: [{ from: 1, to: 0, value: 30 }],
    creates_secret: false,
    constraints: { 0: { neuroticism: 35 } },
    max_age_gap: 20,
  },
  {
    id: 'slow_burn',
    type: 'slow_burn',
    description: 'Work together daily, neither notices the warmth building',
    agent_count: 2,
    romance_values: [{ from: 0, to: 1, value: 8 }, { from: 1, to: 0, value: 5 }],
    friendship_adjustments: [{ from: 0, to: 1, delta: 15 }, { from: 1, to: 0, delta: 15 }],
    creates_secret: false,
    max_age_gap: 20,
  },
];
