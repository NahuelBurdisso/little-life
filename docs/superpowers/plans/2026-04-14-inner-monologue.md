# Inner Monologue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Thoughts" tab to the AgentPanel with 4 progressive disclosure layers showing what agents are thinking, their goals, secrets, opinions, and memories.

**Architecture:** 4 new React components (ThoughtsTab, CurrentThought, GoalsView, SecretsOpinions), 1 new tRPC query (getAgentThoughts), deduplication of existing AgentPanel sections. Template-assembled thoughts, zero LLM cost.

**Tech Stack:** React 19, TypeScript, Tailwind CSS, tRPC

**Spec:** `docs/superpowers/specs/2026-04-14-inner-monologue-design.md`

---

## File Structure

| File | Responsibility |
|------|---------------|
| `server/routers/agents.ts` | Add `getAgentThoughts` query (goals + ambition) |
| `src/components/ui/CurrentThought.tsx` | **NEW** — Template sentence + mood + states + action |
| `src/components/ui/GoalsView.tsx` | **NEW** — Life ambition + active goals with progress bars |
| `src/components/ui/SecretsOpinions.tsx` | **NEW** — Secrets list + relationship opinions |
| `src/components/ui/ThoughtsTab.tsx` | **NEW** — Container with 4 collapsible layers |
| `src/components/ui/AgentPanel.tsx` | Add 4th tab, remove moved sections, wire ThoughtsTab |

---

## Task 1: Backend Query

**Files:**
- Modify: `server/routers/agents.ts`

- [ ] **Step 1: Add getAgentThoughts query**

Read `server/routers/agents.ts`. After the existing `getStates` query (around line 90), add:

```typescript
getAgentThoughts: publicProcedure
  .input(z.object({ agentId: z.number() }))
  .query(({ input }) => {
    const activeGoals = db.select().from(goals)
      .where(and(eq(goals.agent_id, input.agentId), eq(goals.status, 'active')))
      .all();
    const ambition = db.select().from(aspirations)
      .where(and(eq(aspirations.agent_id, input.agentId), eq(aspirations.status, 'active')))
      .get();
    return { goals: activeGoals, ambition: ambition ?? null };
  }),
```

Add imports at top (if not already there):
```typescript
import { goals, aspirations } from '../db/schema';
import { and } from 'drizzle-orm';
```

- [ ] **Step 2: Run tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All pass

- [ ] **Step 3: Commit**

```bash
git add server/routers/agents.ts
git commit -m "feat(thoughts): add getAgentThoughts tRPC query"
```

---

## Task 2: CurrentThought Component

**Files:**
- Create: `src/components/ui/CurrentThought.tsx`

- [ ] **Step 1: Create CurrentThought.tsx**

This component assembles a natural-sounding thought sentence from existing data. It also displays mood, active states, and current action (moved from Profile tab).

```tsx
interface CurrentThoughtProps {
  agent: {
    name: string;
    current_action: string;
    current_location: number | null;
  };
  needs: { mood: number; stress: number } | null;
  activeStates: Array<{ type: string; severity?: number }>;
  goals: Array<{ description: string | null; type: string }>;
  lastConversationPartner?: string | null;
}

function getMoodLabel(mood: number): { emoji: string; label: string } {
  if (mood >= 80) return { emoji: '✨', label: 'Wonderful' };
  if (mood >= 60) return { emoji: '😊', label: 'Good' };
  if (mood >= 40) return { emoji: '😐', label: 'Okay' };
  if (mood >= 25) return { emoji: '😔', label: 'Down' };
  return { emoji: '😢', label: 'Miserable' };
}

function describeAction(action: string): string {
  if (!action || action === 'idle') return 'Not doing anything particular';
  if (action === 'sleeping') return 'Sleeping';
  if (action === 'working') return 'Working';
  if (action === 'socializing') return 'Socializing';
  if (action === 'eating') return 'Eating';
  return action.replace(/_/g, ' ');
}

function buildThought(props: CurrentThoughtProps): string {
  const { agent, goals, needs, lastConversationPartner } = props;
  const action = describeAction(agent.current_action);
  const goalDesc = goals[0]?.description ?? goals[0]?.type ?? null;
  const mood = needs?.mood ?? 50;
  const moodWord = getMoodLabel(mood).label.toLowerCase();

  if (lastConversationPartner) {
    if (goalDesc) return `Just talked to ${lastConversationPartner}. I want to ${goalDesc}. Feeling ${moodWord}.`;
    return `Just talked to ${lastConversationPartner}. Feeling ${moodWord}.`;
  }
  if (agent.current_action === 'working') {
    if (goalDesc) return `Working. Thinking about how to ${goalDesc}. Feeling ${moodWord}.`;
    return `Working. Feeling ${moodWord}.`;
  }
  if (agent.current_action === 'sleeping') {
    return `Sleeping soundly...`;
  }
  if (goalDesc) {
    return `${action}. I want to ${goalDesc}. Feeling ${moodWord}.`;
  }
  return `Nothing particular on my mind. Feeling ${moodWord}.`;
}

export function CurrentThought(props: CurrentThoughtProps) {
  const { needs, activeStates } = props;
  const mood = needs?.mood ?? 50;
  const { emoji, label } = getMoodLabel(mood);
  const thought = buildThought(props);

  return (
    <div className="space-y-2">
      {/* Thought sentence */}
      <p className="text-sm italic text-gray-300 leading-relaxed">"{thought}"</p>

      {/* Mood */}
      <div className="flex items-center gap-2">
        <span className="text-lg">{emoji}</span>
        <span className="text-xs text-gray-400">Mood: {label} ({mood}%)</span>
        {needs && needs.stress > 30 && (
          <span className="text-xs text-orange-400 ml-auto">Stress: {Math.round(needs.stress)}%</span>
        )}
      </div>

      {/* Active states */}
      {activeStates.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {activeStates.map((s, i) => (
            <span key={i} className="px-2 py-0.5 rounded-full bg-gray-700 text-xs text-gray-300">
              {s.type}{s.severity ? ` ${Math.round(s.severity)}%` : ''}
            </span>
          ))}
        </div>
      )}

      {/* Current action */}
      <div className="text-xs text-gray-500">
        Currently: {describeAction(props.agent.current_action)}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ui/CurrentThought.tsx
git commit -m "feat(thoughts): add CurrentThought component with template sentences"
```

---

## Task 3: GoalsView Component

**Files:**
- Create: `src/components/ui/GoalsView.tsx`

- [ ] **Step 1: Create GoalsView.tsx**

Shows life ambition + active goals with progress bars.

```tsx
const CATEGORY_COLORS: Record<string, string> = {
  wealth: 'border-yellow-500 text-yellow-400',
  love: 'border-pink-500 text-pink-400',
  power: 'border-red-500 text-red-400',
  freedom: 'border-green-500 text-green-400',
  justice: 'border-blue-500 text-blue-400',
  knowledge: 'border-purple-500 text-purple-400',
  legacy: 'border-amber-500 text-amber-400',
  pleasure: 'border-orange-500 text-orange-400',
};

interface GoalsViewProps {
  ambition: {
    type: string;
    description: string | null;
  } | null;
  goals: Array<{
    id: number;
    type: string;
    description: string | null;
    strategy: string | null;
    progress: number;
    created_at: number;
    source: string;
  }>;
  currentTick: number;
}

function progressColor(p: number): string {
  if (p >= 0.7) return 'bg-green-500';
  if (p >= 0.3) return 'bg-yellow-500';
  return 'bg-red-500';
}

export function GoalsView({ ambition, goals, currentTick }: GoalsViewProps) {
  return (
    <div className="space-y-3">
      {/* Life ambition */}
      {ambition && (
        <div className={`border-l-2 pl-3 py-1 ${CATEGORY_COLORS[ambition.type] ?? 'border-gray-500 text-gray-400'}`}>
          <div className="text-[10px] uppercase tracking-wider opacity-60">Life Ambition</div>
          <div className="text-sm italic text-gray-200">{ambition.description ?? ambition.type}</div>
          <span className="inline-block mt-1 px-1.5 py-0.5 rounded text-[10px] bg-gray-700 text-gray-400">
            {ambition.type}
          </span>
        </div>
      )}

      {/* Active goals */}
      {goals.length === 0 && (
        <div className="text-xs text-gray-600 italic">No active goals</div>
      )}
      {goals.map((goal) => {
        const daysActive = Math.max(1, Math.floor((currentTick - goal.created_at) / 1440));
        return (
          <div key={goal.id} className="bg-gray-800/50 rounded-lg px-3 py-2 space-y-1">
            <div className="text-sm text-gray-200">{goal.description ?? goal.type}</div>
            {goal.strategy && (
              <div className="text-xs text-gray-500 italic">Strategy: {goal.strategy}</div>
            )}
            <div className="flex items-center gap-2">
              <div className="flex-1 h-1.5 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${progressColor(goal.progress)}`}
                  style={{ width: `${Math.round(goal.progress * 100)}%` }}
                />
              </div>
              <span className="text-[10px] text-gray-500">{Math.round(goal.progress * 100)}%</span>
            </div>
            <div className="flex gap-2 text-[10px]">
              <span className="text-gray-600">{daysActive}d active</span>
              <span className={goal.source === 'llm' ? 'text-blue-400' : 'text-orange-400'}>
                {goal.source === 'llm' ? 'LLM' : 'reactive'}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ui/GoalsView.tsx
git commit -m "feat(thoughts): add GoalsView component with ambition and progress bars"
```

---

## Task 4: SecretsOpinions Component

**Files:**
- Create: `src/components/ui/SecretsOpinions.tsx`

- [ ] **Step 1: Create SecretsOpinions.tsx**

This extracts the KnownFacts logic from AgentPanel (lines 27-96) and adds the opinions section.

Read `src/components/ui/AgentPanel.tsx` lines 27-96 to see the existing KnownFacts component. The new component reuses that rendering but adds the opinions section.

```tsx
import { trpc } from '../../lib/trpc';

const TYPE_COLORS: Record<string, string> = {
  crush: 'bg-pink-500',
  affair: 'bg-pink-600',
  romantic: 'bg-pink-400',
  theft: 'bg-red-500',
  financial: 'bg-green-500',
  secret_told: 'bg-purple-500',
  secret_medical: 'bg-red-400',
  secret_personal: 'bg-gray-400',
  witnessed_event: 'bg-blue-500',
  suspicion: 'bg-orange-500',
  blackmail: 'bg-red-700',
};

const SENSITIVITY_ICONS = ['', '🔑', '🔒'];

interface SecretsOpinionsProps {
  agentId: number;
  relationships: Array<{
    otherName: string;
    friendship: number;
    romance: number;
  }>;
}

function opinionText(friendship: number, romance: number): string {
  let text = '';
  if (friendship > 50) text = 'I trust them deeply';
  else if (friendship > 20) text = 'They are a friend';
  else if (friendship > -20) text = "I don't have strong feelings about them";
  else if (friendship > -50) text = "I'm wary of them";
  else text = "I can't stand them";

  if (romance > 30) text += ' — and I have feelings for them';
  return text;
}

export function SecretsOpinions({ agentId, relationships }: SecretsOpinionsProps) {
  const { data: facts } = trpc.knowledge.getKnownBy.useQuery({ agentId });

  // Sort relationships by strongest feeling
  const topRelationships = [...relationships]
    .sort((a, b) => (Math.abs(b.friendship) + Math.abs(b.romance)) - (Math.abs(a.friendship) + Math.abs(a.romance)))
    .slice(0, 5);

  const sortedFacts = [...(facts ?? [])]
    .sort((a, b) => (b.sensitivity ?? 0) - (a.sensitivity ?? 0))
    .slice(0, 10);

  return (
    <div className="space-y-4">
      {/* Secrets */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">Secrets I Hold ({sortedFacts.length})</div>
        {sortedFacts.length === 0 && (
          <div className="text-xs text-gray-600 italic">No secrets known</div>
        )}
        <div className="space-y-1 max-h-40 overflow-y-auto">
          {sortedFacts.map((fact: any) => (
            <div key={fact.id} className="flex items-start gap-1.5 text-xs text-gray-400">
              <span className={`inline-block w-2 h-2 rounded-full mt-1 flex-shrink-0 ${TYPE_COLORS[fact.type] ?? 'bg-gray-600'}`} />
              <span className="flex-1 line-clamp-1">{fact.content}</span>
              {fact.sensitivity > 1 && (
                <span className="flex-shrink-0 text-[10px]">{SENSITIVITY_ICONS[fact.sensitivity - 1]}</span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Opinions */}
      <div>
        <div className="text-[10px] uppercase tracking-wider text-gray-500 mb-2">What I Think of Others</div>
        {topRelationships.length === 0 && (
          <div className="text-xs text-gray-600 italic">No strong feelings about anyone</div>
        )}
        <div className="space-y-1.5">
          {topRelationships.map((rel, i) => (
            <div key={i} className="flex items-center gap-2 text-xs">
              <span className="text-gray-200 font-medium w-24 truncate">{rel.otherName}</span>
              <span className="text-gray-500 flex-1 italic">{opinionText(rel.friendship, rel.romance)}</span>
              <span className="text-gray-600 text-[10px] flex-shrink-0">
                {rel.friendship > 0 ? '+' : ''}{rel.friendship}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
```

Note: The implementer needs to read how `KnownFacts` queries data in AgentPanel.tsx (line 28: `trpc.knowledge.getKnownBy.useQuery({ agentId })`) and match the response shape. The `relationships` prop should be pre-processed by the parent (AgentPanel) to extract the agent's perspective values (friendship_ab vs friendship_ba depending on direction).

- [ ] **Step 2: Commit**

```bash
git add src/components/ui/SecretsOpinions.tsx
git commit -m "feat(thoughts): add SecretsOpinions component with secrets list and opinions"
```

---

## Task 5: ThoughtsTab Container

**Files:**
- Create: `src/components/ui/ThoughtsTab.tsx`

- [ ] **Step 1: Create ThoughtsTab.tsx**

Container component with 4 collapsible sections. Wires the sub-components together.

```tsx
import { useState } from 'react';
import { CurrentThought } from './CurrentThought';
import { GoalsView } from './GoalsView';
import { SecretsOpinions } from './SecretsOpinions';
import MemoryLog from './MemoryLog';
import { trpc } from '../../lib/trpc';

interface ThoughtsTabProps {
  agent: any;
  needs: any;
  activeStates: any[];
  memories: any[];
  worldTick: number;
  tickSpeed: number;
  relationships: Array<{ otherName: string; friendship: number; romance: number }>;
  lastConversationPartner?: string | null;
}

function CollapsibleSection({ title, defaultOpen, children }: {
  title: string; defaultOpen: boolean; children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between py-1.5 text-xs font-medium text-gray-400 hover:text-gray-200 transition-colors"
      >
        <span>{title}</span>
        <span className="text-[10px]">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="pb-2">{children}</div>}
    </div>
  );
}

export function ThoughtsTab(props: ThoughtsTabProps) {
  const { agent, needs, activeStates, memories, worldTick, tickSpeed, relationships, lastConversationPartner } = props;

  const { data: thoughtsData } = trpc.agents.getAgentThoughts.useQuery(
    { agentId: Number(agent.id) },
    { refetchInterval: 5000 },
  );

  const agentGoals = thoughtsData?.goals ?? [];
  const ambition = thoughtsData?.ambition ?? null;

  return (
    <div className="px-3 py-2 space-y-1 overflow-y-auto" style={{ maxHeight: 'calc(100vh - 200px)' }}>
      {/* Layer 1: Surface — always visible */}
      <CurrentThought
        agent={agent}
        needs={needs}
        activeStates={activeStates}
        goals={agentGoals}
        lastConversationPartner={lastConversationPartner}
      />

      <div className="border-t border-gray-700/50 mt-2" />

      {/* Layer 2: Goals */}
      <CollapsibleSection title="Goals & Ambition" defaultOpen={false}>
        <GoalsView
          ambition={ambition}
          goals={agentGoals}
          currentTick={worldTick}
        />
      </CollapsibleSection>

      <div className="border-t border-gray-700/50" />

      {/* Layer 3: Secrets & Opinions */}
      <CollapsibleSection title="Secrets & Opinions" defaultOpen={false}>
        <SecretsOpinions
          agentId={Number(agent.id)}
          relationships={relationships}
        />
      </CollapsibleSection>

      <div className="border-t border-gray-700/50" />

      {/* Layer 4: Memory Stream */}
      <CollapsibleSection title="Recent Memories" defaultOpen={false}>
        <MemoryLog
          memories={(memories ?? []).slice(0, 10)}
          worldTick={worldTick}
          tickSpeed={tickSpeed}
        />
      </CollapsibleSection>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ui/ThoughtsTab.tsx
git commit -m "feat(thoughts): add ThoughtsTab container with 4 collapsible layers"
```

---

## Task 6: Wire into AgentPanel + Deduplication

**Files:**
- Modify: `src/components/ui/AgentPanel.tsx`

This is the biggest task — it modifies the existing AgentPanel to add the 4th tab and remove moved sections.

- [ ] **Step 1: Read AgentPanel.tsx fully**

Read `src/components/ui/AgentPanel.tsx` completely. Understand the tab structure, data loading, and section rendering.

- [ ] **Step 2: Add imports and update TabId**

Add at top:
```tsx
import { ThoughtsTab } from './ThoughtsTab';
```

Change TabId (line 16):
```tsx
type TabId = "profile" | "social" | "mind" | "thoughts";
```

Update tabs array (around line 240):
```tsx
const tabs: { id: TabId; label: string }[] = [
  { id: "profile", label: "👤 Profile" },
  { id: "social", label: "💬 Social" },
  { id: "mind", label: "🧠 Mind" },
  { id: "thoughts", label: "💭 Thoughts" },
];
```

- [ ] **Step 3: Remove moved sections from Profile tab**

Find and remove the "Current Action" section (around lines 299-303):
```tsx
{/* Current action */}
<div className="px-3 py-2 border-b border-gray-700 text-sm text-gray-300">
  <span className="text-gray-500">Currently: </span>
  {describeAction(agent.current_action)}
</div>
```

Find and remove the "Active States" section (around lines 305-311):
```tsx
{/* Active states */}
<div className="px-3 py-2 border-b border-gray-700">
  <div className="text-xs text-gray-500 font-medium mb-1.5">
    Active States
  </div>
  <ActiveStates states={agentStates ?? []} />
</div>
```

- [ ] **Step 4: Remove moved sections from Mind tab**

Find and remove the KnownFacts rendering in the Mind tab (the `<KnownFacts agentId={...} />` call).

Find and remove the MemoryLog rendering in the Mind tab (around lines 431-436):
```tsx
<MemoryLog
  memories={memories ?? []}
  worldTick={worldTick}
  tickSpeed={tickSpeed}
/>
```

- [ ] **Step 5: Add Thoughts tab rendering**

In the tab content conditional section, add the Thoughts tab case. You'll need to prepare the `relationships` prop by extracting the agent's perspective from the relationship data.

The implementer should check how relationships are loaded in the Social tab and extract a simplified array for the ThoughtsTab:

```tsx
{activeTab === "thoughts" && agent && (
  <ThoughtsTab
    agent={agent}
    needs={agentNeeds}
    activeStates={agentStates ?? []}
    memories={memories ?? []}
    worldTick={worldTick}
    tickSpeed={tickSpeed}
    relationships={relationshipsList}
    lastConversationPartner={lastConvoPartner}
  />
)}
```

The `relationshipsList` should be built from the existing relationship data, mapping each to `{ otherName, friendship, romance }` from the selected agent's perspective.

The `lastConvoPartner` can be extracted from the conversation history query (already loaded for the Social tab).

- [ ] **Step 6: Run TypeScript check**

Run: `cd D:/proyects/little-life && npx tsc --noEmit`
Fix any errors.

- [ ] **Step 7: Run tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All pass

- [ ] **Step 8: Commit**

```bash
git add src/components/ui/AgentPanel.tsx
git commit -m "feat(thoughts): wire Thoughts tab into AgentPanel, deduplicate sections"
```

---

## Task 7: Final Verification

- [ ] **Step 1: Run all tests**

Run: `cd D:/proyects/little-life && npx vitest run`
Expected: All pass

- [ ] **Step 2: TypeScript check**

Run: `cd D:/proyects/little-life && npx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit any fixes**

```bash
git add src/
git commit -m "fix(thoughts): address remaining issues from integration"
```
