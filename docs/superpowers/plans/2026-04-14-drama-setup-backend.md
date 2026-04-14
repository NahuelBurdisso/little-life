# Drama Setup Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the seed data with intersecting conflict threads for all 13 agents, create secrets and romance template pools, and build a procedural generator that turns 4 slider values into a complete simulation config.

**Architecture:** Three new data modules (secretsPool, romancePool, setupGenerator) plus enriched seed.ts. The generator takes `{ drama, romance, crime, trust }` sliders, draws from template pools with constraint-based agent assignment, and returns a `SetupConfigSchema`-compatible object. A new tRPC endpoint exposes the generator to the frontend.

**Tech Stack:** TypeScript, Drizzle ORM, tRPC, Zod, Vitest

**Spec:** `docs/superpowers/specs/2026-04-14-drama-setup-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/data/secretsPool.ts` | **NEW** — 20 parameterized secret templates with constraints |
| `server/data/romancePool.ts` | **NEW** — 10 romantic thread templates with constraints |
| `server/lib/setupGenerator.ts` | **NEW** — Procedural generation: sliders → SetupConfig |
| `server/lib/__tests__/setupGenerator.test.ts` | **NEW** — Generator tests |
| `server/data/__tests__/secretsPool.test.ts` | **NEW** — Secret pool constraint tests |
| `server/db/seed.ts` | Enrich with 12 conflict web secrets + relationship adjustments |
| `server/routers/setup.ts` | Add `generateFromSliders` query endpoint |

---

## Task 1: Secrets Pool

**Files:**
- Create: `server/data/secretsPool.ts`
- Create: `server/data/__tests__/secretsPool.test.ts`

- [ ] **Step 1: Define SecretTemplate interface and write tests**

Create `server/data/__tests__/secretsPool.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { SECRETS_POOL, type SecretTemplate } from '../secretsPool';

describe('SECRETS_POOL', () => {
  it('has at least 20 templates', () => {
    expect(SECRETS_POOL.length).toBeGreaterThanOrEqual(20);
  });

  it('every template has required fields', () => {
    for (const t of SECRETS_POOL) {
      expect(t.category).toBeTruthy();
      expect(t.template).toContain('{agent_a}');
      expect(t.sensitivity).toBeGreaterThanOrEqual(1);
      expect(t.sensitivity).toBeLessThanOrEqual(3);
      expect(t.min_drama_level).toBeGreaterThanOrEqual(0);
      expect(t.min_drama_level).toBeLessThanOrEqual(10);
    }
  });

  it('covers all 6 categories', () => {
    const categories = new Set(SECRETS_POOL.map(t => t.category));
    expect(categories).toContain('medical');
    expect(categories).toContain('financial');
    expect(categories).toContain('witness');
    expect(categories).toContain('romantic');
    expect(categories).toContain('past');
    expect(categories).toContain('suspicion');
  });

  it('medical templates require medical job', () => {
    const medical = SECRETS_POOL.filter(t => t.category === 'medical');
    for (const t of medical) {
      if (t.constraints.job_required) {
        expect(t.constraints.job_required.some(j => ['doctor', 'medical_assistant'].includes(j))).toBe(true);
      }
    }
  });

  it('no template has sensitivity > 3', () => {
    expect(SECRETS_POOL.every(t => t.sensitivity <= 3)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — should FAIL**

Run: `cd D:/proyects/little-life && npx vitest run server/data/__tests__/secretsPool.test.ts`

- [ ] **Step 3: Create secretsPool.ts**

Create `server/data/secretsPool.ts`:

```typescript
// ─── Types ─────────────────────────────────────────────────────────────────

export interface SecretConstraints {
  /** At least one agent must have one of these jobs */
  job_required?: string[];
  /** Agent slot → personality axis → minimum value */
  personality?: Record<string, Record<string, number>>;
  /** Minimum friendship between agent_a and agent_b */
  min_friendship?: number;
  /** Flexibility: how much to relax personality thresholds if no match (+/- this value) */
  flexibility?: number;
}

export interface SecretTemplate {
  id: string;
  category: 'medical' | 'financial' | 'witness' | 'romantic' | 'past' | 'suspicion';
  template: string;
  sensitivity: 1 | 2 | 3;
  /** Number of agent slots (1, 2, or 3) */
  agent_slots: number;
  constraints: SecretConstraints;
  /** Minimum Drama slider value to include this template */
  min_drama_level: number;
  /** shared_knowledge type field */
  knowledge_type: string;
}

// ─── Pool ──────────────────────────────────────────────────────────────────

export const SECRETS_POOL: SecretTemplate[] = [
  // ── Medical (3) ──
  {
    id: 'med_prescription',
    category: 'medical',
    template: '{agent_a} is getting medication from {agent_b} without official records',
    sensitivity: 3,
    agent_slots: 2,
    constraints: { job_required: ['doctor', 'medical_assistant'], personality: { agent_a: { neuroticism: 40 } } },
    min_drama_level: 4,
    knowledge_type: 'secret_medical',
  },
  {
    id: 'med_off_books',
    category: 'medical',
    template: '{agent_a} is treating {agent_b}\'s injury off the books',
    sensitivity: 2,
    agent_slots: 2,
    constraints: { job_required: ['doctor', 'medical_assistant'] },
    min_drama_level: 3,
    knowledge_type: 'secret_medical',
  },
  {
    id: 'med_self_medicate',
    category: 'medical',
    template: '{agent_a} has been self-medicating with alcohol to cope with stress',
    sensitivity: 2,
    agent_slots: 1,
    constraints: { personality: { agent_a: { neuroticism: 40 } } },
    min_drama_level: 3,
    knowledge_type: 'secret_personal',
  },

  // ── Financial (4) ──
  {
    id: 'fin_secret_lending',
    category: 'financial',
    template: '{agent_a} has been secretly lending money to {agent_b} and hiding it from the books',
    sensitivity: 2,
    agent_slots: 2,
    constraints: { personality: { agent_a: { warmth: 40 } } },
    min_drama_level: 3,
    knowledge_type: 'financial',
  },
  {
    id: 'fin_unpaid_debt',
    category: 'financial',
    template: '{agent_a} owes {agent_b} months of unpaid debt',
    sensitivity: 1,
    agent_slots: 2,
    constraints: {},
    min_drama_level: 2,
    knowledge_type: 'financial',
  },
  {
    id: 'fin_skimming',
    category: 'financial',
    template: '{agent_a} has been skimming small amounts from their workplace funds',
    sensitivity: 2,
    agent_slots: 1,
    constraints: { personality: { agent_a: { morality: -50 } } },
    min_drama_level: 5,
    knowledge_type: 'financial',
  },
  {
    id: 'fin_irregularities',
    category: 'financial',
    template: '{agent_a} found irregularities in {agent_b}\'s financial records',
    sensitivity: 1,
    agent_slots: 2,
    constraints: { personality: { agent_a: { curiosity: 40 } } },
    min_drama_level: 2,
    knowledge_type: 'financial',
  },

  // ── Witness (3) ──
  {
    id: 'wit_violence',
    category: 'witness',
    template: '{agent_a} saw {agent_b} get violent with {agent_c}',
    sensitivity: 3,
    agent_slots: 3,
    constraints: { personality: { agent_b: { aggression: 50 } } },
    min_drama_level: 5,
    knowledge_type: 'witnessed_event',
  },
  {
    id: 'wit_overheard',
    category: 'witness',
    template: '{agent_a} overheard {agent_b} threatening {agent_c}',
    sensitivity: 2,
    agent_slots: 3,
    constraints: { personality: { agent_a: { curiosity: 40 } } },
    min_drama_level: 4,
    knowledge_type: 'witnessed_event',
  },
  {
    id: 'wit_stealing',
    category: 'witness',
    template: '{agent_a} caught {agent_b} stealing from the shop',
    sensitivity: 2,
    agent_slots: 2,
    constraints: { personality: { agent_b: { morality: -50 } } },
    min_drama_level: 4,
    knowledge_type: 'witnessed_event',
  },

  // ── Romantic (4) ──
  {
    id: 'rom_flirt_witnessed',
    category: 'romantic',
    template: '{agent_a} flirted with {agent_b} and {agent_c} saw it',
    sensitivity: 1,
    agent_slots: 3,
    constraints: { personality: { agent_a: { sensuality: 40 } } },
    min_drama_level: 2,
    knowledge_type: 'romantic',
  },
  {
    id: 'rom_secret_feelings',
    category: 'romantic',
    template: '{agent_a} has secret feelings for {agent_b}',
    sensitivity: 2,
    agent_slots: 2,
    constraints: { personality: { agent_a: { sensuality: 30 } } },
    min_drama_level: 2,
    knowledge_type: 'crush',
  },
  {
    id: 'rom_one_night',
    category: 'romantic',
    template: '{agent_a} and {agent_b} had a one-night encounter that nobody knows about',
    sensitivity: 2,
    agent_slots: 2,
    constraints: { personality: { agent_a: { sensuality: 50 }, agent_b: { sensuality: 50 } } },
    min_drama_level: 5,
    knowledge_type: 'secret_personal',
  },
  {
    id: 'rom_discovered_attraction',
    category: 'romantic',
    template: '{agent_a} discovered that {agent_b} is attracted to {agent_c}',
    sensitivity: 1,
    agent_slots: 3,
    constraints: { personality: { agent_a: { curiosity: 40 } } },
    min_drama_level: 3,
    knowledge_type: 'romantic',
  },

  // ── Past (3) ──
  {
    id: 'past_confession',
    category: 'past',
    template: '{agent_a} confided a shameful past event to {agent_b}',
    sensitivity: 2,
    agent_slots: 2,
    constraints: { min_friendship: 30 },
    min_drama_level: 3,
    knowledge_type: 'secret_told',
  },
  {
    id: 'past_shared_guilt',
    category: 'past',
    template: '{agent_a} was involved in something terrible and {agent_b} knows about it',
    sensitivity: 3,
    agent_slots: 2,
    constraints: {},
    min_drama_level: 6,
    knowledge_type: 'secret_told',
  },
  {
    id: 'past_suspicious_arrival',
    category: 'past',
    template: '{agent_a} left their previous life under suspicious circumstances',
    sensitivity: 2,
    agent_slots: 1,
    constraints: {},
    min_drama_level: 4,
    knowledge_type: 'secret_personal',
  },

  // ── Suspicion (3) ──
  {
    id: 'sus_theft',
    category: 'suspicion',
    template: '{agent_a} suspects {agent_b} of stealing',
    sensitivity: 1,
    agent_slots: 2,
    constraints: { personality: { agent_a: { curiosity: 40 } } },
    min_drama_level: 3,
    knowledge_type: 'suspicion',
  },
  {
    id: 'sus_watching',
    category: 'suspicion',
    template: '{agent_a} has been watching {agent_b}\'s movements closely',
    sensitivity: 1,
    agent_slots: 2,
    constraints: {},
    min_drama_level: 4,
    knowledge_type: 'suspicion',
  },
  {
    id: 'sus_identity',
    category: 'suspicion',
    template: '{agent_a} thinks {agent_b} is hiding something about their past',
    sensitivity: 2,
    agent_slots: 2,
    constraints: { personality: { agent_a: { curiosity: 50 } } },
    min_drama_level: 5,
    knowledge_type: 'suspicion',
  },
];
```

Note: For `fin_skimming`, the constraint `morality: -50` means morality BELOW 50 (inverted check). The generator should interpret negative values as "less than absolute value" checks.

- [ ] **Step 4: Run tests — all should PASS**

Run: `cd D:/proyects/little-life && npx vitest run server/data/__tests__/secretsPool.test.ts`

- [ ] **Step 5: Commit**

```bash
git add server/data/secretsPool.ts server/data/__tests__/secretsPool.test.ts
git commit -m "feat(setup): add secrets pool with 20 parameterized templates"
```

---

## Task 2: Romance Pool

**Files:**
- Create: `server/data/romancePool.ts`

- [ ] **Step 1: Create romancePool.ts**

Create `server/data/romancePool.ts`:

```typescript
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
```

- [ ] **Step 2: Commit**

```bash
git add server/data/romancePool.ts
git commit -m "feat(setup): add romance pool with 10 thread templates"
```

---

## Task 3: Setup Generator (TDD)

**Files:**
- Create: `server/lib/setupGenerator.ts`
- Create: `server/lib/__tests__/setupGenerator.test.ts`

- [ ] **Step 1: Write generator tests**

Create `server/lib/__tests__/setupGenerator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { generateFromSliders, type SliderConfig } from '../setupGenerator';

// Use default agents from the setup defaults
import { getDefaultAgents, getDefaultRelationships } from '../../src/components/setup/defaults';

// Note: generator is pure — no DB access. It takes agent/relationship data as input.

describe('generateFromSliders', () => {
  const baseAgents = getDefaultAgents();
  const baseRelationships = getDefaultRelationships();

  it('returns valid config with all required fields', () => {
    const result = generateFromSliders(
      { drama: 5, romance: 5, crime: 5, trust: 5 },
      baseAgents,
      baseRelationships,
    );
    expect(result.secrets).toBeDefined();
    expect(result.relationships).toBeDefined();
    expect(result.economyAdjustments).toBeDefined();
    expect(result.moodAdjustments).toBeDefined();
  });

  it('produces more secrets at higher drama', () => {
    const low = generateFromSliders({ drama: 2, romance: 5, crime: 5, trust: 5 }, baseAgents, baseRelationships);
    const high = generateFromSliders({ drama: 9, romance: 5, crime: 5, trust: 5 }, baseAgents, baseRelationships);
    expect(high.secrets.length).toBeGreaterThan(low.secrets.length);
  });

  it('produces more romance threads at higher romance', () => {
    const low = generateFromSliders({ drama: 5, romance: 1, crime: 5, trust: 5 }, baseAgents, baseRelationships);
    const high = generateFromSliders({ drama: 5, romance: 9, crime: 5, trust: 5 }, baseAgents, baseRelationships);
    expect(high.romanceThreads.length).toBeGreaterThan(low.romanceThreads.length);
  });

  it('increases wealth gaps at higher crime', () => {
    const low = generateFromSliders({ drama: 5, romance: 5, crime: 1, trust: 5 }, baseAgents, baseRelationships);
    const high = generateFromSliders({ drama: 5, romance: 5, crime: 9, trust: 5 }, baseAgents, baseRelationships);
    const lowRange = Math.max(...Object.values(low.economyAdjustments)) - Math.min(...Object.values(low.economyAdjustments));
    const highRange = Math.max(...Object.values(high.economyAdjustments)) - Math.min(...Object.values(high.economyAdjustments));
    expect(highRange).toBeGreaterThan(lowRange);
  });

  it('produces lower trust at low trust slider', () => {
    const low = generateFromSliders({ drama: 5, romance: 5, crime: 5, trust: 1 }, baseAgents, baseRelationships);
    expect(low.rivalPairs.length).toBeGreaterThan(0);
  });

  it('never assigns more secrets than target', () => {
    for (let drama = 0; drama <= 10; drama++) {
      const result = generateFromSliders({ drama, romance: 5, crime: 5, trust: 5 }, baseAgents, baseRelationships);
      const target = Math.round(drama * 1.2);
      expect(result.secrets.length).toBeLessThanOrEqual(target + 1); // +1 for rounding
    }
  });

  it('drama=0 produces zero secrets', () => {
    const result = generateFromSliders({ drama: 0, romance: 0, crime: 0, trust: 10 }, baseAgents, baseRelationships);
    expect(result.secrets.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests — should FAIL**

Run: `cd D:/proyects/little-life && npx vitest run server/lib/__tests__/setupGenerator.test.ts`

- [ ] **Step 3: Implement setupGenerator.ts**

Create `server/lib/setupGenerator.ts`. This is the core module — it must be a pure function (no DB access) so it can be tested and used for preview without side effects.

```typescript
import { SECRETS_POOL, type SecretTemplate } from '../data/secretsPool';
import { ROMANCE_POOL, type RomanceTemplate } from '../data/romancePool';
import type { AgentConfig, RelationshipConfig } from '../../src/components/setup/types';

// ─── Types ─────────────────────────────────────────────────────────────────

export interface SliderConfig {
  drama: number;    // 0-10
  romance: number;  // 0-10
  crime: number;    // 0-10
  trust: number;    // 0-10
}

export interface GeneratedSecret {
  template_id: string;
  content: string;
  type: string;
  sensitivity: number;
  subject_index: number;
  target_index: number | null;
  known_by_indices: number[];
}

export interface RomanceThread {
  template_id: string;
  agent_indices: number[];
  romance_values: Array<{ from: number; to: number; value: number }>;
  friendship_deltas: Array<{ from: number; to: number; delta: number }>;
  trust_deltas: Array<{ from: number; to: number; delta: number }>;
  secret?: GeneratedSecret;
}

export interface GenerationResult {
  secrets: GeneratedSecret[];
  romanceThreads: RomanceThread[];
  /** agent index → adjusted starting money */
  economyAdjustments: Record<number, number>;
  /** agent index → { mood, stress } */
  moodAdjustments: Record<number, { mood: number; stress: number }>;
  /** trust delta applied to all baseline relationships */
  trustDelta: number;
  /** pairs of agent indices that become rivals */
  rivalPairs: Array<[number, number]>;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function checkPersonalityConstraint(
  agent: AgentConfig,
  constraints: Record<string, number>,
  flexibility: number,
): boolean {
  for (const [axis, threshold] of Object.entries(constraints)) {
    const value = (agent.personality as Record<string, number>)[axis] ?? 50;
    if (threshold < 0) {
      // Negative threshold means "less than absolute value"
      if (value > Math.abs(threshold) + flexibility) return false;
    } else {
      if (value < threshold - flexibility) return false;
    }
  }
  return true;
}

function findValidAgents(
  agents: AgentConfig[],
  usedIndices: Set<number>,
  constraints: SecretTemplate['constraints'],
  flexibility: number,
): number[] {
  const valid: number[] = [];
  for (let i = 0; i < agents.length; i++) {
    if (usedIndices.has(i)) continue;
    const agent = agents[i];

    // Job check
    if (constraints.job_required) {
      const agentJob = agent.job?.toLowerCase() ?? '';
      if (!constraints.job_required.some(j => agentJob.includes(j))) continue;
    }

    // Personality check for agent_a slot
    if (constraints.personality?.agent_a) {
      if (!checkPersonalityConstraint(agent, constraints.personality.agent_a, flexibility)) continue;
    }

    valid.push(i);
  }
  return valid;
}

// ─── Generator ─────────────────────────────────────────────────────────────

export function generateFromSliders(
  sliders: SliderConfig,
  agents: AgentConfig[],
  relationships: RelationshipConfig[],
): GenerationResult {
  const { drama, romance, crime, trust } = sliders;

  // 1. Secrets
  const targetSecrets = Math.round(drama * 1.2);
  const secrets: GeneratedSecret[] = [];
  const shuffledPool = shuffle(SECRETS_POOL.filter(t => t.min_drama_level <= drama));

  for (const template of shuffledPool) {
    if (secrets.length >= targetSecrets) break;

    const usedInThis = new Set<number>();
    const flexibility = template.constraints.flexibility ?? 10;

    // Find agent_a
    const validA = findValidAgents(agents, usedInThis, template.constraints, flexibility);
    if (validA.length === 0) continue;
    const aIdx = validA[Math.floor(Math.random() * validA.length)];
    usedInThis.add(aIdx);

    // Find agent_b if needed
    let bIdx: number | null = null;
    if (template.agent_slots >= 2) {
      const bConstraints = { ...template.constraints };
      if (bConstraints.personality?.agent_b) {
        bConstraints.personality = { agent_a: bConstraints.personality.agent_b };
      } else {
        bConstraints.personality = undefined;
      }
      const validB = findValidAgents(agents, usedInThis, bConstraints, flexibility);
      if (validB.length === 0) continue;
      bIdx = validB[Math.floor(Math.random() * validB.length)];
      usedInThis.add(bIdx);
    }

    // Find agent_c if needed
    let cIdx: number | null = null;
    if (template.agent_slots >= 3) {
      const validC = agents.map((_, i) => i).filter(i => !usedInThis.has(i));
      if (validC.length === 0) continue;
      cIdx = validC[Math.floor(Math.random() * validC.length)];
    }

    // Fill template
    let content = template.template
      .replace('{agent_a}', agents[aIdx].name)
      .replace('{agent_b}', bIdx !== null ? agents[bIdx].name : '')
      .replace('{agent_c}', cIdx !== null ? agents[cIdx].name : '');

    const known_by = [aIdx];
    if (bIdx !== null && template.agent_slots >= 2) known_by.push(bIdx);

    secrets.push({
      template_id: template.id,
      content,
      type: template.knowledge_type,
      sensitivity: template.sensitivity,
      subject_index: aIdx,
      target_index: bIdx,
      known_by_indices: known_by,
    });
  }

  // 2. Romance threads
  const targetRomance = Math.round(romance * 0.4);
  const romanceThreads: RomanceThread[] = [];
  const shuffledRomance = shuffle(ROMANCE_POOL);
  const usedRomanceAgents = new Set<number>();

  for (const template of shuffledRomance) {
    if (romanceThreads.length >= targetRomance) break;

    const available = agents
      .map((a, i) => ({ agent: a, index: i }))
      .filter(({ index }) => !usedRomanceAgents.has(index));

    if (available.length < template.agent_count) continue;

    // Check age gap and personality constraints
    const candidates = shuffle(available);
    const selected: number[] = [];

    for (const { agent, index } of candidates) {
      if (selected.length >= template.agent_count) break;
      const slotIdx = selected.length;

      // Personality check
      if (template.constraints?.[slotIdx]) {
        if (!checkPersonalityConstraint(agent, template.constraints[slotIdx], 10)) continue;
      }

      // Age gap check
      if (template.max_age_gap && selected.length > 0) {
        const firstAge = agents[selected[0]].age;
        if (Math.abs(agent.age - firstAge) > template.max_age_gap) continue;
      }

      selected.push(index);
    }

    if (selected.length < template.agent_count) continue;

    // Map template indices to actual agent indices
    const thread: RomanceThread = {
      template_id: template.id,
      agent_indices: selected,
      romance_values: template.romance_values.map(v => ({
        from: selected[v.from], to: selected[v.to], value: v.value,
      })),
      friendship_deltas: (template.friendship_adjustments ?? []).map(v => ({
        from: selected[v.from], to: selected[v.to], delta: v.delta,
      })),
      trust_deltas: (template.trust_adjustments ?? []).map(v => ({
        from: selected[v.from], to: selected[v.to], delta: v.delta,
      })),
    };

    // Create secret if template specifies one
    if (template.creates_secret && template.secret_template) {
      let secretContent = template.secret_template;
      selected.forEach((agentIdx, slotIdx) => {
        secretContent = secretContent.replace(`{agent_${slotIdx}}`, agents[agentIdx].name);
      });

      const knownBy = (template.known_by ?? []).map(k => {
        if (typeof k === 'number') return selected[k];
        // 'friend' — pick a random agent not in the thread
        const friends = agents.map((_, i) => i).filter(i => !selected.includes(i));
        return friends.length > 0 ? friends[Math.floor(Math.random() * friends.length)] : selected[0];
      });

      thread.secret = {
        template_id: template.id,
        content: secretContent,
        type: 'romantic',
        sensitivity: template.secret_sensitivity ?? 1,
        subject_index: selected[0],
        target_index: selected.length > 1 ? selected[1] : null,
        known_by_indices: knownBy,
      };
    }

    romanceThreads.push(thread);
    selected.forEach(i => usedRomanceAgents.add(i));
  }

  // 3. Economy scaling
  const economyAdjustments: Record<number, number> = {};
  // AgentConfig has no startingMoney field — use salary as relative wealth indicator
  const baseMoney = agents.map((a, i) => ({ index: i, money: (a.salary ?? 20) * 2.5 }));
  baseMoney.sort((a, b) => b.money - a.money);

  for (let i = 0; i < baseMoney.length; i++) {
    const { index, money } = baseMoney[i];
    if (crime <= 3) {
      // Flatten toward 60-80
      economyAdjustments[index] = 60 + Math.round(Math.random() * 20);
    } else if (crime >= 7) {
      // Amplify gaps
      const rank = i / baseMoney.length;
      if (rank < 0.25) {
        economyAdjustments[index] = 100 + Math.round(Math.random() * 50);
      } else if (rank > 0.75) {
        economyAdjustments[index] = 10 + Math.round(Math.random() * 15);
      } else {
        economyAdjustments[index] = 40 + Math.round(Math.random() * 30);
      }
    } else {
      // Moderate scaling
      const factor = crime / 5;
      const deviation = (money - 60) * factor;
      economyAdjustments[index] = Math.round(60 + deviation);
    }
  }

  // 4. Trust calibration
  const trustDelta = (trust - 5) * 6; // trust=0 → -30, trust=5 → 0, trust=10 → +30
  const rivalPairs: Array<[number, number]> = [];

  if (trust <= 3) {
    // Inject rival pairs
    const numRivals = Math.round((4 - trust) * 0.8);
    const agentIndices = shuffle(agents.map((_, i) => i));
    for (let i = 0; i < numRivals * 2 && i + 1 < agentIndices.length; i += 2) {
      rivalPairs.push([agentIndices[i], agentIndices[i + 1]]);
    }
  }

  // 5. Mood adjustments
  const moodAdjustments: Record<number, { mood: number; stress: number }> = {};
  const numLowMood = Math.round(drama * 0.4);
  const moodTargets = shuffle(agents.map((_, i) => i)).slice(0, numLowMood);

  for (let i = 0; i < agents.length; i++) {
    if (moodTargets.includes(i)) {
      moodAdjustments[i] = {
        mood: 30 + Math.round(Math.random() * 15),
        stress: 40 + Math.round(Math.random() * 20),
      };
    } else {
      const baseMood = 55 + Math.round((10 - drama) * 2);
      moodAdjustments[i] = {
        mood: Math.min(80, baseMood + Math.round(Math.random() * 10)),
        stress: 10 + Math.round(Math.random() * 15),
      };
    }
  }

  return { secrets, romanceThreads, economyAdjustments, moodAdjustments, trustDelta, rivalPairs };
}
```

Note: The `AgentConfig` type from `src/components/setup/types.ts` needs to be importable from the server. Check `tsconfig.json` — if the server can't import from `src/`, create a minimal inline interface in `setupGenerator.ts` instead:
```typescript
interface GeneratorAgent {
  name: string;
  age: number;
  personality: Record<string, number>;
  salary?: number;
  job?: string;
}
```
Use this instead of importing `AgentConfig`. The generator should not depend on frontend types.

- [ ] **Step 4: Run tests — all should PASS**

Run: `cd D:/proyects/little-life && npx vitest run server/lib/__tests__/setupGenerator.test.ts`

If the import from `src/components/setup/types` fails, adjust to use inline types or re-export from a shared location.

- [ ] **Step 5: Commit**

```bash
git add server/lib/setupGenerator.ts server/lib/__tests__/setupGenerator.test.ts
git commit -m "feat(setup): add procedural drama generator with slider-based config"
```

---

## Task 4: Enrich Seed Data

**Files:**
- Modify: `server/db/seed.ts`
- Modify: `server/data/agents.ts` (if relationship data lives there)

- [ ] **Step 1: Add 12 new shared_knowledge entries to seed.ts**

Read `server/db/seed.ts`. Find the existing shared_knowledge seeding section (around lines 354-396). Add the 12 new conflict web secrets AFTER the existing entries. Each entry follows the exact same pattern as existing ones.

New entries to add (use `agentMap.get('Name')` for IDs):

```typescript
// ── Conflict Web Secrets ──
// Reuse existing variable names if already declared above (diegoId, luciaId, carlosId, rayId, marcoId, rosaId).
// Declare only new ones:
const sofiaId = agentMap.get('Dr. Sofia Petrov');
const omarId = agentMap.get('Omar Hassan');
const elenaId = agentMap.get('Elena Voss');
const jamesId = agentMap.get('James O\'Brien');
const yukiId = agentMap.get('Yuki Tanaka');
const thomasId = agentMap.get('Thomas Park');
const priyaId = agentMap.get('Priya Sharma');
// NOTE: diegoId, luciaId, carlosId, rayId, marcoId, rosaId should already be declared
// in the existing drama section above. If any are missing, add them too.

// ── Medical Loop ──
if (sofiaId && thomasId) {
  db.insert(shared_knowledge).values({
    type: 'secret_medical', subject_id: sofiaId, target_id: thomasId,
    content: 'Dr. Sofia Petrov has been prescribing Thomas Park unprescribed anxiety medication',
    sensitivity: 3, known_by: [sofiaId, thomasId],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}

if (sofiaId && diegoId) {
  db.insert(shared_knowledge).values({
    type: 'secret_medical', subject_id: sofiaId, target_id: diegoId,
    content: 'Dr. Sofia Petrov has been treating Diego Santos\'s hand injury off the books',
    sensitivity: 2, known_by: [sofiaId, diegoId],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}

// ── Conflict Web: Power Loop ──
const omarId = agentMap.get('Omar Hassan');
if (omarId && rayId && carlosId) {
  db.insert(shared_knowledge).values({
    type: 'witnessed_event', subject_id: omarId, target_id: rayId,
    content: 'Omar Hassan witnessed Ray Kowalski shove Carlos Mendez behind the tavern one night',
    sensitivity: 3, known_by: [omarId],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}

// ── Conflict Web: Information Loop ──
const elenaId = agentMap.get('Elena Voss');
const jamesId = agentMap.get('James O\'Brien');
if (jamesId && elenaId) {
  db.insert(shared_knowledge).values({
    type: 'secret_told', subject_id: jamesId, target_id: null,
    content: 'James O\'Brien was drinking the night his wife Margaret had her fall — he confided this guilt to Elena',
    sensitivity: 3, known_by: [jamesId, elenaId],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}

if (jamesId && marcoId) {
  db.insert(shared_knowledge).values({
    type: 'secret_told', subject_id: jamesId, target_id: null,
    content: 'James O\'Brien told Marco Rivera something while blacked out at the tavern — he can\'t remember what',
    sensitivity: 2, known_by: [jamesId, marcoId],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}

// ── Conflict Web: Witness ──
const yukiId = agentMap.get('Yuki Tanaka');
if (yukiId && thomasId) {
  db.insert(shared_knowledge).values({
    type: 'witnessed_event', subject_id: yukiId, target_id: thomasId2,
    content: 'Yuki Tanaka caught Thomas Park picking up medication from the clinic at odd hours',
    sensitivity: 2, known_by: [yukiId, thomasId],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}

// ── Conflict Web: Financial ──
if (thomasId) {
  db.insert(shared_knowledge).values({
    type: 'financial', subject_id: thomasId, target_id: null,
    content: 'Thomas Park has been skimming small amounts from town funds',
    sensitivity: 2, known_by: [thomasId],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}

const rosaId = agentMap.get('Rosa Chen');
if (rosaId) {
  db.insert(shared_knowledge).values({
    type: 'financial', subject_id: rosaId, target_id: null,
    content: 'Rosa Chen noticed discrepancies in the town financial ledger',
    sensitivity: 1, known_by: [rosaId],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}

if (rosaId && carlosId) {
  db.insert(shared_knowledge).values({
    type: 'financial', subject_id: rosaId, target_id: carlosId,
    content: 'Rosa Chen has been secretly extending Carlos Mendez credit and forging receipts to hide it',
    sensitivity: 2, known_by: [rosaId, carlosId],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}

// ── Conflict Web: Romantic ──
if (diegoId && priyaId && luciaId && marcoId) {
  db.insert(shared_knowledge).values({
    type: 'romantic', subject_id: diegoId, target_id: priyaId,
    content: 'Diego Santos flirted with Priya Sharma at the tavern last month',
    sensitivity: 1, known_by: [diegoId, priyaId, luciaId, marcoId],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}

if (luciaId && rosaId) {
  db.insert(shared_knowledge).values({
    type: 'financial', subject_id: luciaId2, target_id: rosaId,
    content: 'Lucia Fernandez found discrepancies in Rosa Chen\'s shop ledger',
    sensitivity: 1, known_by: [luciaId2],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}

// ── Conflict Web: Suspicion ──
if (carlosId && rayId) {
  db.insert(shared_knowledge).values({
    type: 'suspicion', subject_id: carlosId, target_id: rayId,
    content: 'Carlos Mendez suspects Ray Kowalski planted evidence against him',
    sensitivity: 1, known_by: [carlosId],
    created_at: now, is_active: true, source: 'backstory',
  }).run();
}
```

Note: Some variables like `thomasId`, `priyaId`, `marcoId` may already be declared in the existing drama section. Read the file first to avoid redeclarations — reuse existing variables or add new `agentMap.get()` calls as needed.

- [ ] **Step 2: Add relationship adjustments**

In the same seed.ts file, find the relationship seeding section. After relationships are inserted, add updates for the conflict web adjustments. Use the `relationships` table with UPDATE statements:

```typescript
// ── Conflict Web: Relationship Adjustments ──
// Sofia ↔ Omar: add romance
// (Find the relationship row and update romance values)
// The exact implementation depends on how relationships are stored —
// read the existing relationship insert code to match the pattern.
```

The implementer should read the existing relationship insert pattern and add the 7 relationship adjustments from the spec.

- [ ] **Step 3: Run seed reset to verify**

Run: `cd D:/proyects/little-life && npm run db:reset`
Expected: Seed completes without errors, "Inserted X memories" count increases.

- [ ] **Step 4: Commit**

```bash
git add server/db/seed.ts
git commit -m "feat(setup): enrich seed data with 12 conflict web secrets and relationship adjustments"
```

---

## Task 5: Setup Router Endpoint

**Files:**
- Modify: `server/routers/setup.ts`

- [ ] **Step 1: Add generateFromSliders query to setup router**

Read `server/routers/setup.ts`. Add a new query (not mutation — it doesn't write to DB) that calls the generator:

```typescript
import { z } from 'zod';
import { generateFromSliders } from '../lib/setupGenerator';
import { getDefaultAgents, getDefaultRelationships } from '../../src/components/setup/defaults';

// Add to the router:
generateFromSliders: publicProcedure
  .input(z.object({
    drama: z.number().min(0).max(10),
    romance: z.number().min(0).max(10),
    crime: z.number().min(0).max(10),
    trust: z.number().min(0).max(10),
  }))
  .query(({ input }) => {
    const agents = getDefaultAgents();
    const relationships = getDefaultRelationships();
    return generateFromSliders(input, agents, relationships);
  }),
```

Note: The import path to `defaults.ts` from `server/routers/` is `../../src/components/setup/defaults`. Verify this works with the project's TypeScript config. If `configRegistry.ts` (imported by defaults.ts) has browser-only dependencies, extract the type definitions into a shared file or mock the dependency.

**Integration note:** The `SetupConfigSchema` in `setup.ts` currently only has `agents`, `relationships`, `world`, `rules`. The `GenerationResult` from the generator includes secrets, romance threads, and economy adjustments. The frontend plan (Part 2) is responsible for:
1. Adding `shared_knowledge` and `economy_overrides` fields to `SetupConfigSchema`
2. Updating `seedWorld()` to consume these new fields
3. Transforming `GenerationResult` into the extended schema before calling `initialize`

**Presets note:** The 5 presets (Classic, Powder Keg, Love & Lies, Quiet Start, Total Chaos) are frontend constants — just named slider value tuples. They don't need a backend data file. The frontend plan will define them in `PresetSelector.tsx`.

- [ ] **Step 2: Run tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add server/routers/setup.ts
git commit -m "feat(setup): add generateFromSliders tRPC query endpoint"
```

---

## Task 6: Full Test Suite

- [ ] **Step 1: Run all tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All tests pass (186+ existing + new pool/generator tests)

- [ ] **Step 2: Run seed reset**

Run: `cd D:/proyects/little-life && npm run db:reset`
Expected: Completes without errors

- [ ] **Step 3: Verify TypeScript**

Run: `cd D:/proyects/little-life && npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Commit any fixes**

```bash
git add server/
git commit -m "fix(setup): address remaining issues from backend integration"
```
