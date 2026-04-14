# Agent Agency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace rule-based goal triggers with LLM-driven life ambitions and active goals that persist across days, feed into planning, influence decisions, and adapt when plans fail.

**Architecture:** Two-layer system — one life ambition (persistent) + up to 3 LLM-generated active goals per agent. Goals are free-form text mapped to existing interaction types via GoalMapper. Morning LLM review replaces proactive triggers; reactive triggers kept as fallback. PivotEvaluator handles stale goals with one pivot attempt before emotional abandonment.

**Tech Stack:** TypeScript, SQLite/Drizzle ORM, Ollama (Gemma 4 26B MoE), existing simEvents bus

**Spec:** `docs/superpowers/specs/2026-04-13-agent-agency-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/db/schema.ts` | Add new columns to `goals` + `aspirations` tables |
| `server/lib/goals/types.ts` | **NEW** — Shared types for goal system |
| `server/lib/goals/goalParser.ts` | **NEW** — Parse LLM structured JSON output |
| `server/lib/goals/GoalMapper.ts` | **NEW** — Map free-form goals to interaction types |
| `server/lib/goals/goalPrompts.ts` | **NEW** — LLM prompt templates |
| `server/lib/goals/GoalReviewer.ts` | **NEW** — Morning LLM review + generation |
| `server/lib/goals/PivotEvaluator.ts` | **NEW** — Stale goal detection + pivot |
| `server/lib/goals/instance.ts` | **NEW** — Singleton exports |
| `server/lib/goals/__tests__/goalParser.test.ts` | **NEW** — Parser tests |
| `server/lib/goals/__tests__/GoalMapper.test.ts` | **NEW** — Mapper tests |
| `server/lib/goals/__tests__/PivotEvaluator.test.ts` | **NEW** — Pivot evaluator tests |
| `server/lib/interactionConstants.ts` | Update `MAX_GOALS_PER_AGENT` 3 → 4 |
| `server/data/goalRegistry.ts` | Remove proactive triggers from `GOAL_TRIGGER_REGISTRY` |
| `server/engine/systems/goals.ts` | Integrate GoalReviewer + PivotEvaluator into goalsTick |
| `server/lib/planning/PlanGenerator.ts` | Load + pass active goals (fix `goals: []`) |
| `server/engine/systems/decisions.ts` | Add goalsMap + goal alignment scoring |
| `server/lib/memory/MemoryObserver.ts` | Update goal handlers, add pivoted/shifted handlers |
| `server/helpers/conversationHelpers.ts` | Include active goals in conversation context |
| `server/db/seed.ts` | Seed initial life ambitions for agents |

---

## Task 1: Schema Changes + Migration Defaults

**Files:**
- Modify: `server/db/schema.ts:522-540` (goals table), `server/db/schema.ts:544-560` (aspirations table)
- Modify: `server/db/index.ts` (add migration script after pragmas)
- Modify: `server/lib/interactionConstants.ts:247`

- [ ] **Step 1: Add new columns to `goals` table in schema.ts**

In `server/db/schema.ts`, add 5 new columns to the goals table definition:

```typescript
export const goals = sqliteTable(
  'goals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agent_id: integer('agent_id').notNull(),
    type: text('type').notNull(),
    target_id: integer('target_id'),
    motivation: text('motivation').notNull(),
    priority: real('priority').notNull(),
    progress: real('progress').notNull().default(0),
    status: text('status').notNull().default('active'),
    created_at: integer('created_at').notNull(),
    expires_at: integer('expires_at'),
    // NEW columns for LLM-driven goals
    description: text('description'),
    strategy: text('strategy'),
    mapped_interactions: text('mapped_interactions'),
    pivot_count: integer('pivot_count').notNull().default(0),
    source: text('source').notNull().default('reactive'),
  },
  (table) => [
    index('idx_goals_agent_status').on(table.agent_id, table.status),
    index('idx_goals_target').on(table.target_id),
  ]
);
```

- [ ] **Step 2: Add new columns to `aspirations` table in schema.ts**

```typescript
export const aspirations = sqliteTable(
  'aspirations',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    agent_id: integer('agent_id').notNull(),
    type: text('type').notNull(),
    intensity: real('intensity').notNull(),
    status: text('status').notNull().default('active'),
    adopted_at: integer('adopted_at').notNull(),
    shifted_at: integer('shifted_at'),
    trigger: text('trigger').notNull(),
    shifted_to: text('shifted_to'),
    // NEW columns for LLM-driven ambitions
    description: text('description'),
    shifted_reason: text('shifted_reason'),
  },
  (table) => [
    index('idx_aspirations_agent_status').on(table.agent_id, table.status),
  ]
);
```

- [ ] **Step 3: Add migration in `server/db/index.ts`**

After the existing pragma and index statements, add column migration:

```typescript
// ─── Schema migrations (additive columns) ─────────────────────────────────
function migrateSchema() {
  const addColumnIfMissing = (table: string, column: string, type: string, dflt?: string) => {
    try {
      sqlite.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${dflt ? ` DEFAULT ${dflt}` : ''}`);
    } catch {
      // Column already exists — ignore
    }
  };

  // Goals table extensions
  addColumnIfMissing('goals', 'description', 'TEXT');
  addColumnIfMissing('goals', 'strategy', 'TEXT');
  addColumnIfMissing('goals', 'mapped_interactions', 'TEXT');
  addColumnIfMissing('goals', 'pivot_count', 'INTEGER', '0');
  addColumnIfMissing('goals', 'source', 'TEXT', "'reactive'");

  // Aspirations table extensions
  addColumnIfMissing('aspirations', 'description', 'TEXT');
  addColumnIfMissing('aspirations', 'shifted_reason', 'TEXT');

  // Backfill existing goals with description = type
  sqlite.exec(`UPDATE goals SET description = type WHERE description IS NULL`);
  // Backfill existing aspirations with description from type
  sqlite.exec(`UPDATE aspirations SET description = type WHERE description IS NULL`);
}

migrateSchema();
```

- [ ] **Step 4: Update MAX_GOALS_PER_AGENT**

In `server/lib/interactionConstants.ts`, change:
```typescript
export const MAX_GOALS_PER_AGENT = 4;
```

- [ ] **Step 5: Verify the app starts without errors**

Run: `cd D:/proyects/little-life && npx tsx server/index.ts`
Expected: Server starts on port 3001, no migration errors. Kill after confirming.

- [ ] **Step 6: Commit**

```bash
git add server/db/schema.ts server/db/index.ts server/lib/interactionConstants.ts
git commit -m "feat(goals): add schema columns for LLM-driven goals and ambitions"
```

---

## Task 2: Types + Goal Parser (TDD)

**Files:**
- Create: `server/lib/goals/types.ts`
- Create: `server/lib/goals/goalParser.ts`
- Create: `server/lib/goals/__tests__/goalParser.test.ts`

- [ ] **Step 1: Create shared types**

Create `server/lib/goals/types.ts`:

```typescript
// ─── LLM Output Types ─────────────────────────────────────────────────────

export interface AmbitionShift {
  shift: string;
  category: string;
  reason: string;
}

export interface GoalReviewAction {
  goal_id: number;
  action: 'continue' | 'adjust' | 'abandon';
  reason: string;
  new_strategy?: string;
}

export interface NewGoalOutput {
  description: string;
  target_agent: string | null;
  category_hint: string;
  strategy: string;
  priority: number;
}

export interface GoalReviewResult {
  ambition: 'keep' | AmbitionShift;
  reviews: GoalReviewAction[];
  new_goals: NewGoalOutput[];
}

export interface PivotResult {
  new_strategy: string;
  new_category_hint?: string;
}

export interface AmbitionGenerationResult {
  description: string;
  category: string;
  reason: string;
}

// ─── Mapper Output ─────────────────────────────────────────────────────────

export interface MappedGoal {
  type: string;
  mapped_interactions: string[];
  target_id: number | null;
}

// ─── Constants ─────────────────────────────────────────────────────────────

export const PIVOT_THRESHOLD_TICKS = 1440;
export const STALE_ABANDON_TICKS = 4320;
export const MAX_LLM_GOALS = 3;
```

- [ ] **Step 2: Write failing parser tests**

Create `server/lib/goals/__tests__/goalParser.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import {
  parseGoalReview,
  parsePivotResult,
  parseAmbitionGeneration,
} from '../goalParser';

describe('parseGoalReview', () => {
  it('parses valid JSON with keep ambition', () => {
    const raw = JSON.stringify({
      ambition: 'keep',
      reviews: [{ goal_id: 1, action: 'continue', reason: 'making progress' }],
      new_goals: [{ description: 'Save money', target_agent: null, category_hint: 'economic', strategy: 'work extra', priority: 0.6 }],
    });
    const result = parseGoalReview(raw);
    expect(result).not.toBeNull();
    expect(result!.ambition).toBe('keep');
    expect(result!.reviews).toHaveLength(1);
    expect(result!.reviews[0].action).toBe('continue');
    expect(result!.new_goals).toHaveLength(1);
    expect(result!.new_goals[0].priority).toBe(0.6);
  });

  it('parses ambition shift', () => {
    const raw = JSON.stringify({
      ambition: { shift: 'Find inner peace', category: 'freedom', reason: 'tired of chasing money' },
      reviews: [],
      new_goals: [],
    });
    const result = parseGoalReview(raw);
    expect(result).not.toBeNull();
    expect(result!.ambition).not.toBe('keep');
    const shift = result!.ambition as { shift: string; category: string; reason: string };
    expect(shift.shift).toBe('Find inner peace');
    expect(shift.category).toBe('freedom');
  });

  it('handles malformed JSON gracefully', () => {
    expect(parseGoalReview('not json at all')).toBeNull();
    expect(parseGoalReview('{ broken')).toBeNull();
    expect(parseGoalReview('')).toBeNull();
  });

  it('handles JSON wrapped in markdown code block', () => {
    const raw = '```json\n{"ambition":"keep","reviews":[],"new_goals":[]}\n```';
    const result = parseGoalReview(raw);
    expect(result).not.toBeNull();
    expect(result!.ambition).toBe('keep');
  });

  it('clamps priority to 0-1 range', () => {
    const raw = JSON.stringify({
      ambition: 'keep',
      reviews: [],
      new_goals: [{ description: 'Test', target_agent: null, category_hint: 'social', strategy: 'try', priority: 1.5 }],
    });
    const result = parseGoalReview(raw);
    expect(result!.new_goals[0].priority).toBe(1.0);
  });

  it('defaults missing priority to 0.5', () => {
    const raw = JSON.stringify({
      ambition: 'keep',
      reviews: [],
      new_goals: [{ description: 'Test', target_agent: null, category_hint: 'social', strategy: 'try' }],
    });
    const result = parseGoalReview(raw);
    expect(result!.new_goals[0].priority).toBe(0.5);
  });

  it('filters invalid review actions', () => {
    const raw = JSON.stringify({
      ambition: 'keep',
      reviews: [
        { goal_id: 1, action: 'continue', reason: 'ok' },
        { goal_id: 2, action: 'invalid_action', reason: 'bad' },
        { goal_id: 3, action: 'abandon', reason: 'done' },
      ],
      new_goals: [],
    });
    const result = parseGoalReview(raw);
    expect(result!.reviews).toHaveLength(2);
  });
});

describe('parsePivotResult', () => {
  it('parses valid pivot', () => {
    const raw = JSON.stringify({ new_strategy: 'Try a different approach', new_category_hint: 'social' });
    const result = parsePivotResult(raw);
    expect(result).not.toBeNull();
    expect(result!.new_strategy).toBe('Try a different approach');
  });

  it('returns null for missing strategy', () => {
    expect(parsePivotResult(JSON.stringify({ new_category_hint: 'social' }))).toBeNull();
    expect(parsePivotResult('garbage')).toBeNull();
  });
});

describe('parseAmbitionGeneration', () => {
  it('parses valid ambition', () => {
    const raw = JSON.stringify({ description: 'Become wealthy', category: 'wealth', reason: 'grew up poor' });
    const result = parseAmbitionGeneration(raw);
    expect(result).not.toBeNull();
    expect(result!.description).toBe('Become wealthy');
  });

  it('returns null for missing fields', () => {
    expect(parseAmbitionGeneration(JSON.stringify({ description: 'Only desc' }))).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd D:/proyects/little-life && npx vitest run server/lib/goals/__tests__/goalParser.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement goalParser.ts**

Create `server/lib/goals/goalParser.ts`:

```typescript
import type {
  GoalReviewResult,
  GoalReviewAction,
  NewGoalOutput,
  AmbitionShift,
  PivotResult,
  AmbitionGenerationResult,
} from './types';

// ─── Helpers ───────────────────────────────────────────────────────────────

function extractJSON(raw: string): string {
  let cleaned = raw.trim();
  // Strip markdown code fences
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();
  return cleaned;
}

function safeParse(raw: string): unknown | null {
  try {
    return JSON.parse(extractJSON(raw));
  } catch {
    return null;
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

const VALID_ACTIONS = new Set(['continue', 'adjust', 'abandon']);

// ─── Parsers ───────────────────────────────────────────────────────────────

export function parseGoalReview(raw: string): GoalReviewResult | null {
  const data = safeParse(raw) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;

  // Parse ambition
  let ambition: 'keep' | AmbitionShift;
  if (data.ambition === 'keep') {
    ambition = 'keep';
  } else if (data.ambition && typeof data.ambition === 'object') {
    const a = data.ambition as Record<string, unknown>;
    if (typeof a.shift !== 'string' || typeof a.category !== 'string' || typeof a.reason !== 'string') return null;
    ambition = { shift: a.shift, category: a.category, reason: a.reason };
  } else {
    return null;
  }

  // Parse reviews
  const rawReviews = Array.isArray(data.reviews) ? data.reviews : [];
  const reviews: GoalReviewAction[] = rawReviews
    .filter((r: unknown) => {
      if (!r || typeof r !== 'object') return false;
      const obj = r as Record<string, unknown>;
      return typeof obj.goal_id === 'number' && VALID_ACTIONS.has(obj.action as string) && typeof obj.reason === 'string';
    })
    .map((r: unknown) => {
      const obj = r as Record<string, unknown>;
      return {
        goal_id: obj.goal_id as number,
        action: obj.action as 'continue' | 'adjust' | 'abandon',
        reason: obj.reason as string,
        new_strategy: typeof obj.new_strategy === 'string' ? obj.new_strategy : undefined,
      };
    });

  // Parse new goals
  const rawGoals = Array.isArray(data.new_goals) ? data.new_goals : [];
  const new_goals: NewGoalOutput[] = rawGoals
    .filter((g: unknown) => {
      if (!g || typeof g !== 'object') return false;
      const obj = g as Record<string, unknown>;
      return typeof obj.description === 'string' && typeof obj.strategy === 'string';
    })
    .map((g: unknown) => {
      const obj = g as Record<string, unknown>;
      return {
        description: obj.description as string,
        target_agent: typeof obj.target_agent === 'string' ? obj.target_agent : null,
        category_hint: typeof obj.category_hint === 'string' ? obj.category_hint : 'custom',
        strategy: obj.strategy as string,
        priority: typeof obj.priority === 'number' ? clamp(obj.priority, 0, 1) : 0.5,
      };
    });

  return { ambition, reviews, new_goals };
}

export function parsePivotResult(raw: string): PivotResult | null {
  const data = safeParse(raw) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.new_strategy !== 'string' || !data.new_strategy.trim()) return null;
  return {
    new_strategy: data.new_strategy,
    new_category_hint: typeof data.new_category_hint === 'string' ? data.new_category_hint : undefined,
  };
}

export function parseAmbitionGeneration(raw: string): AmbitionGenerationResult | null {
  const data = safeParse(raw) as Record<string, unknown> | null;
  if (!data || typeof data !== 'object') return null;
  if (typeof data.description !== 'string' || typeof data.category !== 'string' || typeof data.reason !== 'string') return null;
  return { description: data.description, category: data.category, reason: data.reason };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd D:/proyects/little-life && npx vitest run server/lib/goals/__tests__/goalParser.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/lib/goals/types.ts server/lib/goals/goalParser.ts server/lib/goals/__tests__/goalParser.test.ts
git commit -m "feat(goals): add goal types and LLM output parser with tests"
```

---

## Task 3: GoalMapper (TDD)

**Files:**
- Create: `server/lib/goals/GoalMapper.ts`
- Create: `server/lib/goals/__tests__/GoalMapper.test.ts`

- [ ] **Step 1: Write failing mapper tests**

Create `server/lib/goals/__tests__/GoalMapper.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { GoalMapper } from '../GoalMapper';

const mapper = new GoalMapper();

describe('GoalMapper', () => {
  describe('mapCategory', () => {
    it('maps romantic hint to flirt/date interactions', () => {
      const result = mapper.mapCategory('romantic');
      expect(result.type).toBe('seduce');
      expect(result.interactions).toContain('flirt');
      expect(result.interactions).toContain('date');
    });

    it('maps hostile hint to fight/rumor interactions', () => {
      const result = mapper.mapCategory('hostile');
      expect(result.type).toBe('revenge');
      expect(result.interactions).toContain('fight');
      expect(result.interactions).toContain('spread_rumor');
    });

    it('maps social hint to comfort/befriend interactions', () => {
      const result = mapper.mapCategory('social');
      expect(result.type).toBe('befriend');
      expect(result.interactions).toContain('comfort');
      expect(result.interactions).toContain('buy_drinks');
    });

    it('maps economic hint to work interactions', () => {
      const result = mapper.mapCategory('economic');
      expect(result.type).toBe('custom');
      expect(result.interactions).toContain('work');
    });

    it('maps investigative hint to eavesdrop/interrogate', () => {
      const result = mapper.mapCategory('investigative');
      expect(result.type).toBe('investigate');
      expect(result.interactions).toContain('eavesdrop');
    });

    it('maps protective hint to comfort/nurse', () => {
      const result = mapper.mapCategory('protective');
      expect(result.type).toBe('protect');
      expect(result.interactions).toContain('comfort');
      expect(result.interactions).toContain('nurse');
    });

    it('maps unknown hint to custom with broad interactions', () => {
      const result = mapper.mapCategory('unknown_thing');
      expect(result.type).toBe('custom');
      expect(result.interactions.length).toBeGreaterThan(3);
    });
  });

  describe('resolveAgentName', () => {
    it('returns null for null input', () => {
      expect(mapper.resolveAgentName(null, [])).toBeNull();
    });

    it('matches exact name case-insensitively', () => {
      const agents = [{ id: 1, name: 'Elena Voss' }, { id: 2, name: 'Marco Rivera' }];
      expect(mapper.resolveAgentName('elena voss', agents)).toBe(1);
    });

    it('matches substring', () => {
      const agents = [{ id: 1, name: 'Elena Voss' }, { id: 2, name: 'Marco Rivera' }];
      expect(mapper.resolveAgentName('Elena', agents)).toBe(1);
    });

    it('returns null for no match', () => {
      const agents = [{ id: 1, name: 'Elena Voss' }];
      expect(mapper.resolveAgentName('Nobody', agents)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd D:/proyects/little-life && npx vitest run server/lib/goals/__tests__/GoalMapper.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement GoalMapper**

Create `server/lib/goals/GoalMapper.ts`:

```typescript
import type { NewGoalOutput, MappedGoal } from './types';

// ─── Category → Interaction Mapping ────────────────────────────────────────

interface CategoryMapping {
  type: string;
  interactions: string[];
}

const CATEGORY_MAP: Record<string, CategoryMapping> = {
  romantic: { type: 'seduce', interactions: ['flirt', 'date', 'hookup', 'compliment'] },
  hostile: { type: 'revenge', interactions: ['fight', 'spread_rumor', 'vandalism', 'blackmail', 'pickpocket'] },
  social: { type: 'befriend', interactions: ['comfort', 'buy_drinks', 'lend_money', 'befriend'] },
  economic: { type: 'custom', interactions: ['work'] },
  investigative: { type: 'investigate', interactions: ['eavesdrop', 'interrogate'] },
  protective: { type: 'protect', interactions: ['comfort', 'nurse', 'lend_money'] },
  criminal: { type: 'steal_from', interactions: ['pickpocket', 'burglary', 'fraud', 'blackmail'] },
};

const CUSTOM_FALLBACK: CategoryMapping = {
  type: 'custom',
  interactions: ['comfort', 'buy_drinks', 'lend_money', 'befriend', 'work', 'eavesdrop'],
};

// ─── GoalMapper ────────────────────────────────────────────────────────────

export class GoalMapper {
  mapCategory(categoryHint: string): CategoryMapping {
    const lower = categoryHint.toLowerCase().trim();
    return CATEGORY_MAP[lower] ?? CUSTOM_FALLBACK;
  }

  resolveAgentName(name: string | null, allAgents: { id: number; name: string }[]): number | null {
    if (!name) return null;
    const lower = name.toLowerCase().trim();

    // Exact match (case-insensitive)
    const exact = allAgents.find(a => a.name.toLowerCase() === lower);
    if (exact) return exact.id;

    // Substring match (case-insensitive)
    const partial = allAgents.find(a => a.name.toLowerCase().includes(lower) || lower.includes(a.name.toLowerCase()));
    if (partial) return partial.id;

    return null;
  }

  map(goal: NewGoalOutput, allAgents: { id: number; name: string }[]): MappedGoal {
    const { type, interactions } = this.mapCategory(goal.category_hint);
    const target_id = this.resolveAgentName(goal.target_agent, allAgents);
    return { type, mapped_interactions: interactions, target_id };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd D:/proyects/little-life && npx vitest run server/lib/goals/__tests__/GoalMapper.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/goals/GoalMapper.ts server/lib/goals/__tests__/GoalMapper.test.ts
git commit -m "feat(goals): add GoalMapper with category-to-interaction mapping"
```

---

## Task 4: Goal Prompts

**Files:**
- Create: `server/lib/goals/goalPrompts.ts`

Reference: `server/lib/planning/planPrompts.ts` for prompt structure pattern, `server/lib/memory/reflectionPrompts.ts` for personality context pattern.

- [ ] **Step 1: Create goalPrompts.ts**

Create `server/lib/goals/goalPrompts.ts`:

```typescript
import type { PersonalityProfile } from '../personality';

// ─── Types ─────────────────────────────────────────────────────────────────

interface GoalReviewPromptParams {
  name: string;
  personality: PersonalityProfile;
  traits: string[];
  ambition: { description: string; type: string } | null;
  activeGoals: { id: number; description: string; strategy: string; progress: number; daysActive: number }[];
  recentMemories: string[];
  relationshipHighlights: string[];
  money: number;
  job: string | null;
  dayNumber: number;
}

interface PivotPromptParams {
  name: string;
  personality: PersonalityProfile;
  goalDescription: string;
  strategy: string;
  progress: number;
  daysActive: number;
  recentMemories: string[];
}

interface AmbitionGenerationParams {
  name: string;
  personality: PersonalityProfile;
  traits: string[];
  recentMemories: string[];
  money: number;
  job: string | null;
  relationshipHighlights: string[];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function personalitySummary(p: PersonalityProfile): string {
  const axes: string[] = [];
  if (p.aggression > 60) axes.push('aggressive');
  else if (p.aggression < 30) axes.push('peaceful');
  if (p.warmth > 60) axes.push('warm');
  else if (p.warmth < 30) axes.push('cold');
  if (p.curiosity > 60) axes.push('curious');
  if (p.neuroticism > 60) axes.push('anxious');
  else if (p.neuroticism < 30) axes.push('emotionally stable');
  if (p.impulsiveness > 60) axes.push('impulsive');
  if (p.morality > 60) axes.push('principled');
  else if (p.morality < 30) axes.push('amoral');
  if (p.sensuality > 60) axes.push('sensual');
  if (p.vanity > 60) axes.push('vain');
  if (p.loyalty > 60) axes.push('loyal');
  return axes.length > 0 ? axes.join(', ') : 'balanced';
}

// ─── Prompts ───────────────────────────────────────────────────────────────

export function buildGoalReviewPrompt(params: GoalReviewPromptParams): { system: string; user: string } {
  const {
    name, personality, traits, ambition, activeGoals,
    recentMemories, relationshipHighlights, money, job, dayNumber,
  } = params;

  const pSummary = personalitySummary(personality);
  const traitsList = traits.join(', ');

  const ambitionText = ambition
    ? `Your life ambition: "${ambition.description}" (category: ${ambition.type})`
    : 'You do not have a life ambition yet.';

  const goalsText = activeGoals.length > 0
    ? activeGoals.map(g =>
        `- [ID:${g.id}] "${g.description}" (strategy: ${g.strategy}, progress: ${Math.round(g.progress * 100)}%, ${g.daysActive} days active)`
      ).join('\n')
    : 'No active goals.';

  const memoriesText = recentMemories.length > 0
    ? recentMemories.map((m, i) => `${i + 1}. ${m}`).join('\n')
    : 'Nothing notable recently.';

  const relationshipsText = relationshipHighlights.length > 0
    ? relationshipHighlights.join('\n')
    : 'No notable relationships.';

  const system = `You are ${name}, a person living in a small town. Day ${dayNumber}.
Personality: ${pSummary}. Traits: ${traitsList}.
Money: ${money}. Job: ${job ?? 'unemployed'}.

${ambitionText}

Your active goals:
${goalsText}

Recent memories:
${memoriesText}

Key relationships:
${relationshipsText}

It's morning. Review your life ambition and goals. Decide what matters today.

Respond ONLY with valid JSON (no markdown, no explanation) in this exact format:
{
  "ambition": "keep" OR {"shift": "new ambition text", "category": "wealth|love|power|freedom|justice|knowledge|legacy|pleasure", "reason": "why"},
  "reviews": [{"goal_id": N, "action": "continue|adjust|abandon", "reason": "why", "new_strategy": "optional new approach"}],
  "new_goals": [{"description": "what you want", "target_agent": "Name or null", "category_hint": "romantic|hostile|social|economic|investigative|protective|custom", "strategy": "how you plan to do it", "priority": 0.0-1.0}]
}`;

  const user = 'Review your ambition and goals. Generate new goals if you have open slots (max 3 LLM goals). Think about what matters to you given your personality and recent experiences.';

  return { system, user };
}

export function buildPivotPrompt(params: PivotPromptParams): { system: string; user: string } {
  const { name, personality, goalDescription, strategy, progress, daysActive, recentMemories } = params;
  const pSummary = personalitySummary(personality);

  const memoriesText = recentMemories.length > 0
    ? recentMemories.map((m, i) => `${i + 1}. ${m}`).join('\n')
    : 'Nothing notable recently.';

  const system = `You are ${name}. Personality: ${pSummary}.

You have been pursuing this goal for ${daysActive} days with ${Math.round(progress * 100)}% progress:
Goal: "${goalDescription}"
Strategy: "${strategy}"

Your approach isn't working. Think about why and come up with a different strategy.

Recent memories:
${memoriesText}

Respond ONLY with valid JSON:
{"new_strategy": "your new approach", "new_category_hint": "romantic|hostile|social|economic|investigative|protective|custom"}`;

  const user = 'What new approach will you try?';

  return { system, user };
}

export function buildAmbitionGenerationPrompt(params: AmbitionGenerationParams): { system: string; user: string } {
  const { name, personality, traits, recentMemories, money, job, relationshipHighlights } = params;
  const pSummary = personalitySummary(personality);
  const traitsList = traits.join(', ');

  const memoriesText = recentMemories.length > 0
    ? recentMemories.map((m, i) => `${i + 1}. ${m}`).join('\n')
    : 'Starting a new life.';

  const relationshipsText = relationshipHighlights.length > 0
    ? relationshipHighlights.join('\n')
    : 'No close relationships yet.';

  const system = `You are ${name}, starting life in a small town.
Personality: ${pSummary}. Traits: ${traitsList}.
Money: ${money}. Job: ${job ?? 'unemployed'}.

Your memories:
${memoriesText}

Relationships:
${relationshipsText}

What is your deepest life ambition? What do you truly want most?

Respond ONLY with valid JSON:
{"description": "your life ambition in one sentence", "category": "wealth|love|power|freedom|justice|knowledge|legacy|pleasure", "reason": "why this matters to you"}`;

  const user = 'What is your life ambition?';

  return { system, user };
}
```

- [ ] **Step 2: Commit**

```bash
git add server/lib/goals/goalPrompts.ts
git commit -m "feat(goals): add LLM prompt templates for goal review, pivot, and ambition generation"
```

---

## Task 5: GoalReviewer

**Files:**
- Create: `server/lib/goals/GoalReviewer.ts`

- [ ] **Step 1: Implement GoalReviewer**

Create `server/lib/goals/GoalReviewer.ts`:

```typescript
import { db } from '../../db';
import { agents, goals, aspirations, economy, relationships, memories } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../constants';
import { getEffectivePersonality } from '../states';
import { simEvents } from '../simEvents';
import { logActivity } from '../activityLogger';
import { GoalMapper } from './GoalMapper';
import { parseGoalReview, parseAmbitionGeneration } from './goalParser';
import { buildGoalReviewPrompt, buildAmbitionGenerationPrompt } from './goalPrompts';
import { MAX_LLM_GOALS } from './types';
import type { GoalReviewAction } from './types';

export class GoalReviewer {
  private mapper = new GoalMapper();

  async review(agentId: number, currentTick: number, currentDay: number): Promise<void> {
    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent) return;

    // Ensure agent has a life ambition
    let ambition = db.select().from(aspirations)
      .where(and(eq(aspirations.agent_id, agentId), eq(aspirations.status, 'active')))
      .get();

    if (!ambition || !ambition.description) {
      await this.generateInitialAmbition(agentId, agent, currentTick);
      ambition = db.select().from(aspirations)
        .where(and(eq(aspirations.agent_id, agentId), eq(aspirations.status, 'active')))
        .get();
    }

    // Load context for LLM
    const activeGoals = db.select().from(goals)
      .where(and(eq(goals.agent_id, agentId), eq(goals.status, 'active'), eq(goals.source, 'llm')))
      .all();

    const recentMems = db.select({ description: memories.description })
      .from(memories)
      .where(and(eq(memories.agent_id, agentId), eq(memories.is_active, true)))
      .orderBy(desc(memories.created_at))
      .limit(20)
      .all();

    const agentEcon = db.select().from(economy).where(eq(economy.agent_id, agentId)).get();

    const allRels = db.select().from(relationships).all();
    const allAgents = db.select({ id: agents.id, name: agents.name }).from(agents).all();
    const agentNameMap = new Map(allAgents.map(a => [a.id, a.name]));

    // Relationships are stored with agent_a < agent_b, so check both directions
    const relHighlights = allRels
      .filter(r => r.agent_a === agentId || r.agent_b === agentId)
      .map(r => {
        const isA = r.agent_a === agentId;
        const otherId = isA ? r.agent_b : r.agent_a;
        const friendship = isA ? r.friendship_ab : r.friendship_ba;
        const romance = isA ? r.romance_ab : r.romance_ba;
        return { otherId, friendship, romance };
      })
      .filter(r => Math.abs(r.friendship) > 30 || Math.abs(r.romance) > 20)
      .slice(0, 5)
      .map(r => {
        const otherName = agentNameMap.get(r.otherId) ?? 'someone';
        const parts: string[] = [];
        if (r.friendship > 30) parts.push(`friend (${r.friendship})`);
        if (r.friendship < -30) parts.push(`enemy (${r.friendship})`);
        if (r.romance > 20) parts.push(`romantic interest (${r.romance})`);
        return `- ${otherName}: ${parts.join(', ')}`;
      });

    const personality = getEffectivePersonality(agentId);

    const prompt = buildGoalReviewPrompt({
      name: agent.name,
      personality,
      traits: agent.traits as string[],
      ambition: ambition ? { description: ambition.description ?? ambition.type, type: ambition.type } : null,
      activeGoals: activeGoals.map(g => ({
        id: g.id,
        description: g.description ?? g.type,
        strategy: g.strategy ?? '',
        progress: g.progress,
        daysActive: Math.max(1, Math.floor((currentTick - g.created_at) / 1440)),
      })),
      recentMemories: recentMems.map(m => m.description),
      relationshipHighlights: relHighlights,
      money: agentEcon?.money ?? 0,
      job: agentEcon?.job ?? null,
      dayNumber: currentDay,
    });

    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.CHAT_MODEL,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        options: { temperature: 0.7, num_predict: 512 },
      });

      const result = parseGoalReview(response.text);
      if (!result) {
        logActivity({ type: 'error', templateData: { system: 'goals', message: `GoalReviewer parse failed for ${agent.name}` } });
        return;
      }

      // Process ambition shift
      if (result.ambition !== 'keep' && ambition) {
        const shift = result.ambition;
        db.update(aspirations)
          .set({ status: 'shifted', shifted_at: currentTick, shifted_to: shift.category, shifted_reason: shift.reason })
          .where(eq(aspirations.id, ambition.id))
          .run();

        db.insert(aspirations).values({
          agent_id: agentId,
          type: shift.category,
          intensity: 1.0,
          status: 'active',
          adopted_at: currentTick,
          trigger: shift.reason,
          description: shift.shift,
        }).run();

        simEvents.emit('ambition:shifted', {
          agentId,
          oldDescription: ambition.description ?? ambition.type,
          newDescription: shift.shift,
          reason: shift.reason,
        });
      }

      // Process goal reviews
      for (const review of result.reviews) {
        this.processReview(review, agentId, currentTick);
      }

      // Create new LLM goals (respect slot limit)
      const currentLLMGoals = db.select().from(goals)
        .where(and(eq(goals.agent_id, agentId), eq(goals.status, 'active'), eq(goals.source, 'llm')))
        .all();
      const slotsAvailable = MAX_LLM_GOALS - currentLLMGoals.length;

      for (const newGoal of result.new_goals.slice(0, slotsAvailable)) {
        const mapped = this.mapper.map(newGoal, allAgents);

        db.insert(goals).values({
          agent_id: agentId,
          type: mapped.type,
          target_id: mapped.target_id,
          motivation: `Driven by ambition: ${ambition?.description ?? 'personal desire'}`,
          priority: newGoal.priority,
          progress: 0,
          status: 'active',
          created_at: currentTick,
          expires_at: null,
          description: newGoal.description,
          strategy: newGoal.strategy,
          mapped_interactions: JSON.stringify(mapped.mapped_interactions),
          pivot_count: 0,
          source: 'llm',
        }).run();

        simEvents.emit('goal:created', {
          agentId,
          goalType: mapped.type,
          description: newGoal.description,
          targetId: mapped.target_id,
        });
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logActivity({ type: 'error', templateData: { system: 'goals', message: `GoalReviewer LLM error for ${agent.name}: ${msg}` } });
    }
  }

  private processReview(review: GoalReviewAction, agentId: number, currentTick: number): void {
    const goal = db.select().from(goals).where(eq(goals.id, review.goal_id)).get();
    if (!goal || goal.agent_id !== agentId) return;

    if (review.action === 'abandon') {
      db.update(goals)
        .set({ status: 'abandoned' })
        .where(eq(goals.id, review.goal_id))
        .run();
      simEvents.emit('goal:abandoned', { agentId, goalType: goal.type, description: goal.description ?? goal.type });
    } else if (review.action === 'adjust' && review.new_strategy) {
      db.update(goals)
        .set({ strategy: review.new_strategy })
        .where(eq(goals.id, review.goal_id))
        .run();
    }
    // 'continue' = no-op
  }

  private async generateInitialAmbition(agentId: number, agent: any, currentTick: number): Promise<void> {
    const recentMems = db.select({ description: memories.description })
      .from(memories)
      .where(and(eq(memories.agent_id, agentId), eq(memories.is_active, true)))
      .orderBy(desc(memories.created_at))
      .limit(10)
      .all();

    const agentEcon = db.select().from(economy).where(eq(economy.agent_id, agentId)).get();
    const personality = getEffectivePersonality(agentId);

    const allRels = db.select().from(relationships).all();
    const allAgents = db.select({ id: agents.id, name: agents.name }).from(agents).all();
    const agentNameMap = new Map(allAgents.map(a => [a.id, a.name]));

    const relHighlights = allRels
      .filter(r => r.agent_a === agentId || r.agent_b === agentId)
      .map(r => {
        const isA = r.agent_a === agentId;
        const otherId = isA ? r.agent_b : r.agent_a;
        const friendship = isA ? r.friendship_ab : r.friendship_ba;
        const romance = isA ? r.romance_ab : r.romance_ba;
        return { otherId, friendship, romance };
      })
      .filter(r => Math.abs(r.friendship) > 20 || Math.abs(r.romance) > 10)
      .slice(0, 3)
      .map(r => `- ${agentNameMap.get(r.otherId) ?? 'someone'}: friendship ${r.friendship}, romance ${r.romance}`);

    const prompt = buildAmbitionGenerationPrompt({
      name: agent.name,
      personality,
      traits: agent.traits as string[],
      recentMemories: recentMems.map(m => m.description),
      money: agentEcon?.money ?? 0,
      job: agentEcon?.job ?? null,
      relationshipHighlights: relHighlights,
    });

    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.CHAT_MODEL,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        options: { temperature: 0.8, num_predict: 200 },
      });

      const result = parseAmbitionGeneration(response.text);
      if (!result) return;

      // Deactivate any existing ambitions
      db.update(aspirations)
        .set({ status: 'shifted', shifted_at: currentTick })
        .where(and(eq(aspirations.agent_id, agentId), eq(aspirations.status, 'active')))
        .run();

      db.insert(aspirations).values({
        agent_id: agentId,
        type: result.category,
        intensity: 1.0,
        status: 'active',
        adopted_at: currentTick,
        trigger: result.reason,
        description: result.description,
      }).run();
    } catch (error) {
      logActivity({ type: 'error', templateData: { system: 'goals', message: `Ambition generation failed for ${agent.name}` } });
    }
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add server/lib/goals/GoalReviewer.ts
git commit -m "feat(goals): add GoalReviewer for morning LLM goal review and generation"
```

---

## Task 6: PivotEvaluator (TDD)

**Files:**
- Create: `server/lib/goals/PivotEvaluator.ts`
- Create: `server/lib/goals/__tests__/PivotEvaluator.test.ts`

- [ ] **Step 1: Write failing tests**

Create `server/lib/goals/__tests__/PivotEvaluator.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { shouldPivot, shouldAbandonStale, computeEmotionalImportance } from '../PivotEvaluator';
import { PIVOT_THRESHOLD_TICKS, STALE_ABANDON_TICKS } from '../types';

describe('shouldPivot', () => {
  it('returns true when goal has no progress and exceeds threshold', () => {
    expect(shouldPivot(0, 0, PIVOT_THRESHOLD_TICKS + 100)).toBe(true);
  });

  it('returns false when goal has progress', () => {
    expect(shouldPivot(0.5, 0, PIVOT_THRESHOLD_TICKS + 100)).toBe(false);
  });

  it('returns false when already pivoted', () => {
    expect(shouldPivot(0, 1, PIVOT_THRESHOLD_TICKS + 100)).toBe(false);
  });

  it('returns false when not stale enough', () => {
    expect(shouldPivot(0, 0, PIVOT_THRESHOLD_TICKS - 100)).toBe(false);
  });
});

describe('shouldAbandonStale', () => {
  it('returns true when goal exceeds stale abandon threshold with no progress', () => {
    expect(shouldAbandonStale(0, STALE_ABANDON_TICKS + 1)).toBe(true);
  });

  it('returns false when goal has progress', () => {
    expect(shouldAbandonStale(0.1, STALE_ABANDON_TICKS + 1)).toBe(false);
  });
});

describe('computeEmotionalImportance', () => {
  it('returns higher importance for neurotic agents', () => {
    const base = computeEmotionalImportance(0.8, 3, { neuroticism: 50, impulsiveness: 50 });
    const neurotic = computeEmotionalImportance(0.8, 3, { neuroticism: 80, impulsiveness: 50 });
    expect(neurotic).toBeGreaterThan(base);
  });

  it('returns lower importance for impulsive agents', () => {
    const base = computeEmotionalImportance(0.8, 3, { neuroticism: 50, impulsiveness: 50 });
    const impulsive = computeEmotionalImportance(0.8, 3, { neuroticism: 50, impulsiveness: 80 });
    expect(impulsive).toBeLessThan(base);
  });

  it('scales with priority and days active', () => {
    const low = computeEmotionalImportance(0.3, 1, { neuroticism: 50, impulsiveness: 50 });
    const high = computeEmotionalImportance(0.9, 5, { neuroticism: 50, impulsiveness: 50 });
    expect(high).toBeGreaterThan(low);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd D:/proyects/little-life && npx vitest run server/lib/goals/__tests__/PivotEvaluator.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement PivotEvaluator**

Create `server/lib/goals/PivotEvaluator.ts`:

```typescript
import { db } from '../../db';
import { agents, goals, memories, worldState } from '../../db/schema';
import { eq, and, desc } from 'drizzle-orm';
import { callOllamaChat } from '../../ai/ollama';
import { CONFIG } from '../constants';
import { getEffectivePersonality } from '../states';
import { simEvents } from '../simEvents';
import { logActivity } from '../activityLogger';
import { GoalMapper } from './GoalMapper';
import { parsePivotResult } from './goalParser';
import { buildPivotPrompt } from './goalPrompts';
import { PIVOT_THRESHOLD_TICKS, STALE_ABANDON_TICKS } from './types';

// ─── Pure functions (exported for testing) ─────────────────────────────────

export function shouldPivot(progress: number, pivotCount: number, ticksElapsed: number): boolean {
  return progress === 0 && pivotCount === 0 && ticksElapsed >= PIVOT_THRESHOLD_TICKS;
}

export function shouldAbandonStale(progress: number, ticksElapsed: number): boolean {
  return progress === 0 && ticksElapsed >= STALE_ABANDON_TICKS;
}

export function computeEmotionalImportance(
  priority: number,
  daysActive: number,
  personality: { neuroticism: number; impulsiveness: number },
): number {
  let factor = 1.0;
  if (personality.neuroticism > 60) factor = 1.5;
  else if (personality.impulsiveness > 60) factor = 0.7;
  return priority * Math.min(daysActive, 7) / 7 * factor;
}

// ─── PivotEvaluator class ──────────────────────────────────────────────────

export class PivotEvaluator {
  private mapper = new GoalMapper();

  async evaluate(agentId: number, currentTick: number): Promise<void> {
    const activeGoals = db.select().from(goals)
      .where(and(eq(goals.agent_id, agentId), eq(goals.status, 'active')))
      .all();

    const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
    if (!agent) return;

    for (const goal of activeGoals) {
      const ticksElapsed = currentTick - goal.created_at;

      // Check if target is dead/inactive
      if (goal.target_id) {
        const target = db.select({ is_active: agents.is_active }).from(agents).where(eq(agents.id, goal.target_id)).get();
        if (target && !target.is_active) {
          this.abandonGoal(goal, agentId, 'target is no longer around');
          continue;
        }
      }

      // Safety net: 3-day stale abandon regardless of type
      if (shouldAbandonStale(goal.progress, ticksElapsed)) {
        this.abandonGoal(goal, agentId, 'no progress after extended time');
        continue;
      }

      // Pivot check (LLM goals only)
      if (goal.source === 'llm' && shouldPivot(goal.progress, goal.pivot_count, ticksElapsed)) {
        await this.attemptPivot(goal, agent, currentTick);
      }
    }
  }

  private async attemptPivot(goal: any, agent: any, currentTick: number): Promise<void> {
    const recentMems = db.select({ description: memories.description })
      .from(memories)
      .where(and(eq(memories.agent_id, agent.id), eq(memories.is_active, true)))
      .orderBy(desc(memories.created_at))
      .limit(10)
      .all();

    const personality = getEffectivePersonality(agent.id);
    const daysActive = Math.max(1, Math.floor((currentTick - goal.created_at) / 1440));

    const prompt = buildPivotPrompt({
      name: agent.name,
      personality,
      goalDescription: goal.description ?? goal.type,
      strategy: goal.strategy ?? '',
      progress: goal.progress,
      daysActive,
      recentMemories: recentMems.map(m => m.description),
    });

    try {
      const response = await callOllamaChat({
        model: CONFIG.AI.CHAT_MODEL,
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.user }],
        options: { temperature: 0.7, num_predict: 200 },
      });

      const result = parsePivotResult(response.text);
      if (!result) {
        this.abandonGoal(goal, agent.id, 'could not find a new approach');
        return;
      }

      // Update goal with new strategy
      const updates: Record<string, unknown> = {
        strategy: result.new_strategy,
        pivot_count: 1,
      };

      if (result.new_category_hint) {
        const allAgents = db.select({ id: agents.id, name: agents.name }).from(agents).all();
        const mapped = this.mapper.mapCategory(result.new_category_hint);
        updates.mapped_interactions = JSON.stringify(mapped.interactions);
        updates.type = mapped.type;
      }

      db.update(goals).set(updates).where(eq(goals.id, goal.id)).run();

      simEvents.emit('goal:pivoted', {
        agentId: agent.id,
        description: goal.description ?? goal.type,
        newStrategy: result.new_strategy,
      });
    } catch (error) {
      logActivity({ type: 'error', templateData: { system: 'goals', message: `Pivot LLM failed for ${agent.name}: ${goal.description}` } });
      this.abandonGoal(goal, agent.id, 'failed to find alternative approach');
    }
  }

  private abandonGoal(goal: any, agentId: number, reason: string): void {
    db.update(goals)
      .set({ status: 'abandoned' })
      .where(eq(goals.id, goal.id))
      .run();

    simEvents.emit('goal:abandoned', {
      agentId,
      goalType: goal.type,
      description: goal.description ?? goal.type,
      reason,
    });

    // Emotional consequences for pivoted goals
    if (goal.pivot_count > 0) {
      const personality = getEffectivePersonality(agentId);
      const currentTick = db.select({ time: worldState.time }).from(worldState).get()?.time?.totalTicks ?? 0;
      const daysActive = Math.max(1, Math.floor((currentTick - goal.created_at) / 1440));
      const importance = computeEmotionalImportance(goal.priority, daysActive, personality);

      if (importance > 0.6) {
        simEvents.emit('goal:emotional_failure', { agentId, importance, personality });
      }
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd D:/proyects/little-life && npx vitest run server/lib/goals/__tests__/PivotEvaluator.test.ts`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add server/lib/goals/PivotEvaluator.ts server/lib/goals/__tests__/PivotEvaluator.test.ts
git commit -m "feat(goals): add PivotEvaluator with stale detection, pivot attempts, and emotional consequences"
```

---

## Task 7: Instance + Registry Cleanup

**Files:**
- Create: `server/lib/goals/instance.ts`
- Modify: `server/data/goalRegistry.ts`

- [ ] **Step 1: Create instance.ts**

Create `server/lib/goals/instance.ts`:

```typescript
import { GoalReviewer } from './GoalReviewer';
import { GoalMapper } from './GoalMapper';
import { PivotEvaluator } from './PivotEvaluator';

export const goalReviewer = new GoalReviewer();
export const goalMapper = new GoalMapper();
export const pivotEvaluator = new PivotEvaluator();
```

- [ ] **Step 2: Remove proactive triggers from GOAL_TRIGGER_REGISTRY**

In `server/data/goalRegistry.ts`, find `GOAL_TRIGGER_REGISTRY` and remove entries where `condition.type` is `aspiration_pressure` or `condition.type` is `relationship_threshold`. Keep all entries where `condition.type` is `state_gained` or `fact_learned`.

These are reactive triggers to KEEP:
- `state_gained:angry` → revenge
- `state_gained:infatuated` → seduce
- `fact_learned:theft` → revenge (if victim)
- `fact_learned:affair` → revenge (if involves partner)
- `state_gained:heartbroken` → comfort_grieving (observers)
- `state_gained:grieving` → comfort_grieving (observers)

These are proactive triggers to REMOVE:
- `aspiration_pressure` (wealth + low money → steal_from)
- `relationship_threshold` (friendship < -60 → undermine)
- Any others with condition.type matching `aspiration_pressure` or `relationship_threshold`

- [ ] **Step 3: Commit**

```bash
git add server/lib/goals/instance.ts server/data/goalRegistry.ts
git commit -m "feat(goals): add singleton instances, remove proactive goal triggers"
```

---

## Task 8: Integrate into goalsTick

**Files:**
- Modify: `server/engine/systems/goals.ts`

- [ ] **Step 1: Add imports and morning review hook**

In `server/engine/systems/goals.ts`, add imports at the top:

```typescript
import { goalReviewer, pivotEvaluator } from '../../lib/goals/instance';
```

- [ ] **Step 2: Modify goalsTick to integrate GoalReviewer + PivotEvaluator**

Modify the `goalsTick()` function to:
1. Detect day change (check if hour just passed wake time)
2. Call `goalReviewer.review()` on day change before abandonment
3. Call `pivotEvaluator.evaluate()` after abandonment

```typescript
export function goalsTick(): void {
  const activeAgents = db.select().from(agents).where(eq(agents.is_active, true)).all();
  const currentTick = getCurrentTick();
  const world = db.select().from(worldState).limit(1).all()[0];
  const isDayChange = world?.pending_transitions?.some(
    (t: any) => t.type === 'day_changed'
  ) ?? false;

  for (const agent of activeAgents) {
    const agentGoals = db.select().from(goals)
      .where(and(eq(goals.agent_id, agent.id), eq(goals.status, 'active')))
      .all();

    // 1. Morning LLM review (on day change only, async fire-and-forget)
    if (isDayChange) {
      void goalReviewer.review(agent.id, currentTick, world?.time?.day ?? 1);
    }

    // 2. Evaluate abandonment on existing goals (rule-based)
    for (const goal of agentGoals) {
      evaluateAbandonment(agent, goal, currentTick);
    }

    // 3. Evaluate passive goal progress
    for (const goal of agentGoals) {
      if (goal.status === 'active') {
        evaluatePassiveProgress(agent, goal, currentTick);
      }
    }

    // 4. Check reactive triggers for new goals (2-arg signature: agent, currentTick)
    evaluateTriggers(agent, currentTick);

    // 5. Pivot evaluation (async fire-and-forget)
    void pivotEvaluator.evaluate(agent.id, currentTick);
  }
}
```

Note: Keep the existing `evaluateAbandonment`, `evaluatePassiveProgress`, and `evaluateTriggers` functions unchanged. The GoalReviewer and PivotEvaluator run as async fire-and-forget (same pattern as `reflectionRunner.queueReflection()` in tick.ts). Since both GoalReviewer and PivotEvaluator operate on per-agent data and the tick interval is 1000ms, race conditions are unlikely — LLM calls take 2-5 seconds but only modify the calling agent's goals. The existing `PlanGenerator` uses the same fire-and-forget pattern via `queueGeneration()`.

- [ ] **Step 3: Commit**

```bash
git add server/engine/systems/goals.ts
git commit -m "feat(goals): integrate GoalReviewer and PivotEvaluator into goalsTick"
```

---

## Task 9: Goals → Planning Integration

**Files:**
- Modify: `server/lib/planning/PlanGenerator.ts:207`

- [ ] **Step 1: Fix goals: [] in PlanGenerator**

In `server/lib/planning/PlanGenerator.ts`, find line 207 where `goals: []` is passed. Replace with:

```typescript
// Load active goals for this agent
const activeGoals = db.select().from(goals)
  .where(and(eq(goals.agent_id, agentId), eq(goals.status, 'active')))
  .all();
```

Add import at top of file:
```typescript
import { goals } from '../../db/schema';
```

Then at line 207, replace `goals: [],` with:
```typescript
goals: activeGoals.map(g => {
  const desc = g.description ?? g.type;
  return g.strategy ? `${desc} (strategy: ${g.strategy})` : desc;
}),
```

- [ ] **Step 2: Verify plan generation includes goals**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All existing tests pass (155+)

- [ ] **Step 3: Commit**

```bash
git add server/lib/planning/PlanGenerator.ts
git commit -m "feat(goals): feed active goals into daily plan generation"
```

---

## Task 10: Goals → Decisions Integration

**Files:**
- Modify: `server/engine/systems/decisions.ts`

- [ ] **Step 1: Add goalsMap pre-loading**

In `server/engine/systems/decisions.ts`, find the pre-loading section (around line 608-625 where `needsMap` and `econMap` are created). Add after them:

```typescript
import { goals } from '../../db/schema';
```

And in the tick function, after the econMap:
```typescript
// Pre-load active goals for goal alignment scoring
const allActiveGoals = db.select().from(goals).where(eq(goals.status, 'active')).all();
const goalsMap = new Map<number, typeof allActiveGoals>();
for (const g of allActiveGoals) {
  const arr = goalsMap.get(g.agent_id) ?? [];
  arr.push(g);
  goalsMap.set(g.agent_id, arr);
}
```

- [ ] **Step 2: Add goal alignment scoring in free-time decisions**

Find the free-time/social action scoring section. After existing scoring, add goal alignment bonus:

```typescript
// Goal alignment bonus
const agentGoals = goalsMap.get(agent.id) ?? [];
for (const goal of agentGoals) {
  if (!goal.mapped_interactions) continue;
  const mapped = JSON.parse(goal.mapped_interactions) as string[];
  if (goal.target_id && mapped.length > 0) {
    const target = activeAgents.find(a => a.id === goal.target_id);
    if (target && agent.current_location === target.current_location) {
      score += Math.round(2500 * goal.priority);
    }
  }
}
```

The exact insertion point depends on the structure — look for where `scoreFreeTimeActions` or social scoring happens.

- [ ] **Step 3: Commit**

```bash
git add server/engine/systems/decisions.ts
git commit -m "feat(goals): add goal alignment scoring to decision system"
```

---

## Task 11: Goals → Memory + Conversations

**Files:**
- Modify: `server/lib/memory/MemoryObserver.ts`
- Modify: `server/helpers/conversationHelpers.ts`

- [ ] **Step 1: Update existing goal handlers in MemoryObserver**

In `server/lib/memory/MemoryObserver.ts`, find the goal event handlers (around lines 181-192). Update them to use `description` field:

```typescript
simEvents.on('goal:created', ({ agentId, goalType, description }: { agentId: number; goalType: string; description?: string }) => {
  const desc = description ?? goalType;
  memoryService.record(agentId, 'observation', `I've decided to ${desc}.`, { subtype: 'goal' }, 0, 5);
});

simEvents.on('goal:completed', ({ agentId, goalType, description }: { agentId: number; goalType: string; description?: string }) => {
  const desc = description ?? goalType;
  memoryService.record(agentId, 'observation', `I accomplished my goal: ${desc}.`, { subtype: 'goal' }, 0.5, 7);
});

simEvents.on('goal:abandoned', ({ agentId, goalType, description, reason }: { agentId: number; goalType: string; description?: string; reason?: string }) => {
  const desc = description ?? goalType;
  const reasonText = reason ? ` ${reason}.` : '';
  memoryService.record(agentId, 'observation', `I gave up on ${desc}.${reasonText}`, { subtype: 'goal' }, -0.2, 4);
});
```

- [ ] **Step 2: Add new event handlers for pivot and ambition shift**

Add after the existing goal handlers:

```typescript
simEvents.on('goal:pivoted', ({ agentId, description, newStrategy }: { agentId: number; description: string; newStrategy: string }) => {
  memoryService.record(agentId, 'observation', `My approach to ${description} wasn't working. I'm going to try: ${newStrategy}.`, { subtype: 'goal' }, 0, 5);
});

simEvents.on('ambition:shifted', ({ agentId, oldDescription, newDescription, reason }: { agentId: number; oldDescription: string; newDescription: string; reason: string }) => {
  memoryService.record(agentId, 'observation', `I used to want "${oldDescription}". Now I want "${newDescription}" because ${reason}.`, { subtype: 'ambition' }, 0.3, 8);
});

simEvents.on('goal:emotional_failure', ({ agentId, importance, personality }: { agentId: number; importance: number; personality: any }) => {
  memoryService.record(agentId, 'observation', `I feel the weight of failure. My efforts didn't lead anywhere.`, { subtype: 'emotion' }, -0.5, 6);

  // Trigger emotional states based on personality (spec section 6)
  if (personality.neuroticism > 60) {
    simEvents.emit('state:apply', { agentId, state: importance > 0.8 ? 'depressed' : 'stressed' });
  } else if (personality.aggression > 60) {
    simEvents.emit('state:apply', { agentId, state: 'angry' });
  }
});
```

- [ ] **Step 3: Add active goals to conversation context**

In `server/helpers/conversationHelpers.ts`, after loading speaker data, load their active goals:

Add import:
```typescript
import { goals } from '../db/schema';
```

After the relationship query, add:
```typescript
// Load speaker's active goals for conversation context
const speakerGoals = db.select().from(goals)
  .where(and(eq(goals.agent_id, speakerId), eq(goals.status, 'active')))
  .all()
  .filter(g => g.description)
  .map(g => g.description!)
  .slice(0, 3);
```

Add `speakerGoals` to the return object:
```typescript
return {
  conversation, speaker, speakerNeeds, speakerEcon,
  otherAgent, relationship, memories: relevantMemories,
  location, world, effectivePersonality, statePrompts,
  gossipFacts, situationalPrompt, speakerGoals,  // ← ADD THIS
};
```

Then in `server/ai/generateResponse.ts` (or wherever the conversation prompt is built), find where `situationalPrompt` or `statePrompts` are included in the system prompt. Add after them:
```typescript
const goalsContext = context.speakerGoals?.length
  ? `\nYour current goals: ${context.speakerGoals.join('; ')}`
  : '';
```
Append `goalsContext` to the system prompt string.

- [ ] **Step 4: Run all tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add server/lib/memory/MemoryObserver.ts server/helpers/conversationHelpers.ts
git commit -m "feat(goals): update memory handlers for LLM goals, add goals to conversation context"
```

---

## Task 12: Seed Data + Final Verification

**Files:**
- Modify: `server/db/seed.ts`

- [ ] **Step 1: Add initial ambitions to agent seeding**

In `server/db/seed.ts`, after the needs seeding loop (around line 196), add ambition seeding:

```typescript
// ─── Seed initial life ambitions ──────────────────────────────────────────
const AMBITION_SEEDS: Record<string, { type: string; description: string; trigger: string }> = {
  'Elena Voss': { type: 'knowledge', description: 'Understand the world and share that knowledge with others', trigger: 'innate curiosity' },
  'Marco Rivera': { type: 'power', description: 'Become the most influential person in town', trigger: 'desire for respect' },
  'Priya Sharma': { type: 'love', description: 'Find a deep, meaningful romantic connection', trigger: 'longing for companionship' },
  'Carlos Mendez': { type: 'wealth', description: 'Escape poverty and build financial security', trigger: 'years of hardship' },
  'Yuki Tanaka': { type: 'legacy', description: 'Create something beautiful that outlasts me', trigger: 'artistic passion' },
  'Omar Hassan': { type: 'justice', description: 'Make this town fair for everyone', trigger: 'witnessing inequality' },
  'Lucia Fernandez': { type: 'freedom', description: 'Live life on my own terms without constraints', trigger: 'feeling trapped' },
  'Thomas Park': { type: 'pleasure', description: 'Enjoy every day and not worry about tomorrow', trigger: 'life is short' },
  'Rosa Martinez': { type: 'love', description: 'Build a warm family and nurture those I care about', trigger: 'maternal instinct' },
  'James Chen': { type: 'wealth', description: 'Build a successful business from nothing', trigger: 'entrepreneurial drive' },
  'Diego Santos': { type: 'love', description: 'Win the heart of the person I admire', trigger: 'romantic longing' },
  'Mei Wong': { type: 'knowledge', description: 'Discover the secrets and stories hidden in this town', trigger: 'insatiable curiosity' },
};

for (const [name, ambition] of Object.entries(AMBITION_SEEDS)) {
  const id = agentMap.get(name);
  if (!id) continue;
  db.insert(aspirations).values({
    agent_id: id,
    type: ambition.type,
    intensity: 1.0,
    status: 'active',
    adopted_at: 0,
    trigger: ambition.trigger,
    description: ambition.description,
  }).run();
}
```

- [ ] **Step 2: Run full test suite**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All tests pass (155 existing + new parser/mapper/pivot tests)

- [ ] **Step 3: Verify app starts and seed works**

Run: `cd D:/proyects/little-life && npm run db:reset`
Expected: Seed completes without errors, ambitions are created.

- [ ] **Step 4: Commit**

```bash
git add server/db/seed.ts
git commit -m "feat(goals): seed initial life ambitions for all agents"
```

---

## Task 13: Run Full Test Suite + Smoke Test

- [ ] **Step 1: Run all tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Start the server and verify no runtime errors**

Run: `cd D:/proyects/little-life && npm run db:reset && npm run dev`
Expected: Server starts, no migration errors, no crash on first tick. Check console for GoalReviewer activity on day change.

- [ ] **Step 3: Final commit if any fixes needed**

```bash
git add server/
git commit -m "fix(goals): address any remaining issues from integration testing"
```
