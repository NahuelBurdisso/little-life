# Inner Monologue: Agent Thoughts Tab

## Problem

The simulation generates rich inner lives — goals, secrets, memories, opinions, strategies — but all of it is buried in the database or scattered across tabs. Watching agents walk between buildings is boring because you can't see what they're thinking. Information is distributed across Profile (current action, active states), Mind (known facts, memory log), and Social tabs without a unified "what is this agent's inner world" view.

## Solution

Add a 4th "Thoughts" tab to the AgentPanel with 4 collapsible layers of progressive disclosure. Template-assembled (zero LLM cost). Deduplicate by moving existing components to their natural home.

---

## Tab Structure

```
👤 Profile | 💬 Social | 🧠 Mind | 💭 Thoughts
```

### Thoughts Tab — 4 Layers

#### Layer 1: Surface (always expanded)

A template-assembled "current thought" sentence + state summary. Built from existing data, no LLM.

**Current thought** — single sentence combining:
- Active goal description (if any)
- Current action
- Last interaction partner (if recent)
- Mood modifier

Template patterns:
- With goal + action: *"Heading to the tavern. I want to [goal description]. Feeling [mood]."*
- With recent interaction: *"Just talked to [name]. [goal or reaction]. Feeling [mood]."*
- Idle: *"Nothing particular on my mind. Feeling [mood]."*
- Working: *"Working at [location]. Thinking about [goal or ambition]. Feeling [mood]."*

**Mood indicator** — emoji + word label:
- 80+: sparkles "Wonderful"
- 60-79: smile "Good"
- 40-59: neutral "Okay"
- 25-39: frown "Down"
- 0-24: sad "Miserable"

**Active states** — colored badges (moved from Profile tab):
- e.g., "drunk", "infatuated", "stressed" with severity

**Current action** — what they're doing right now (moved from Profile tab):
- e.g., "Socializing at Tavern", "Working at Farm", "Sleeping at Home 1"

#### Layer 2: Goals (collapsed by default)

Click header to expand. Shows the agent's ambition and active goals.

**Life ambition** — from `aspirations` table where `status = 'active'`:
- Category tag (colored pill: wealth=gold, love=pink, power=red, etc.)
- Description text in italics
- Example: `[love]` *"Find a deep, meaningful romantic connection"*

**Active goals** — from `goals` table where `status = 'active'`:
- Each goal shows:
  - Description text
  - Strategy in gray subtext
  - Progress bar (0-100%, colored by progress: red < 30%, yellow 30-70%, green > 70%)
  - Days active badge
  - Source badge: "LLM" (blue) or "reactive" (orange)
- Max 4 goals (matches MAX_GOALS_PER_AGENT)

#### Layer 3: Secrets & Opinions (collapsed by default)

Click header to expand. Shows what the agent knows and thinks about others.

**Secrets I hold** — from `shared_knowledge` where agent ID is in `known_by`:
- Each secret shows:
  - Content text (truncated to 1 line, expand on click)
  - Sensitivity icon: no icon (1), key icon (2), lock icon (3)
  - Type colored dot (financial=green, romantic=pink, witness=blue, medical=red, past=gray, suspicion=orange)
- Sorted: highest sensitivity first
- Max 10 shown

**What I think of others** — from `relationships` table, this agent's perspective:
- Top 5 strongest feelings (abs(friendship) + abs(romance))
- Each shows:
  - Agent name
  - One-line template based on values:
    - friendship > 50: *"I trust [name] deeply"*
    - friendship 20-50: *"[name] is a friend"*
    - friendship -20 to 20: *"I don't have strong feelings about [name]"*
    - friendship -50 to -20: *"I'm wary of [name]"*
    - friendship < -50: *"I can't stand [name]"*
    - romance > 30: *" and I have feelings for them"* (appended)
  - Small friendship/romance numbers in gray

#### Layer 4: Recent Memories (collapsed by default)

Click header to expand. The existing `MemoryLog` component, limited to 10 most recent.

- Same rendering as current MemoryLog: type badge, importance dots, time ago, description
- Valence border (green/red/gray)
- Filter pills: All, Conversation, Observation, Reflection, Plan
- Moved here from Mind tab (removed from Mind to avoid duplication)

---

## Deduplication Changes

### Moved TO Thoughts tab (remove from source):

| Data | From | To |
|------|------|----|
| Current Action text | Profile tab | Thoughts → Layer 1 |
| Active States badges | Profile tab | Thoughts → Layer 1 |
| Known Facts list | Mind tab | Thoughts → Layer 3 (as "Secrets I hold") |
| Memory Log | Mind tab | Thoughts → Layer 4 |

### Stays in original tab:

| Data | Tab | Reason |
|------|-----|--------|
| Needs Bars (hunger, energy, etc.) | Profile | Stats, not thoughts |
| Mood bar | Profile | Keep the bar visualization, Thoughts gets the emoji/word |
| Economy (money, job) | Profile | Stats |
| Traits pills | Profile | Identity, not thoughts |
| Personality axes | Profile | Identity |
| Relationship List | Social | Interactions, not inner thoughts |
| Conversations | Social | External dialogue |
| Self-Concept | Mind | Self-awareness |
| Backstory | Mind | Static background |
| Schedule grid | Mind | Structure |
| Plan Timeline | Mind | External plan (Thoughts shows goals, Mind shows schedule) |

---

## Data Sources

All data comes from existing tRPC queries — no new endpoints needed:

| Layer | Data source | Existing query |
|-------|------------|----------------|
| Surface thought | Agent row + goals + needs | `trpc.agents.getActive` (already loaded) |
| Goals | `goals` table | New query: `trpc.agents.getGoals` or inline in panel |
| Secrets | `shared_knowledge` table | `trpc.knowledge.getForAgent` (exists) |
| Opinions | `relationships` table | Already loaded in Social tab |
| Memories | `memories` table | `trpc.memories.getRecent` (exists) |

**One new query needed:** Agent's active goals with ambition. Add to agents router:
```typescript
getAgentThoughts: publicProcedure
  .input(z.object({ agentId: z.number() }))
  .query(({ input }) => {
    const activeGoals = db.select().from(goals)
      .where(and(eq(goals.agent_id, input.agentId), eq(goals.status, 'active'))).all();
    const ambition = db.select().from(aspirations)
      .where(and(eq(aspirations.agent_id, input.agentId), eq(aspirations.status, 'active'))).get();
    return { goals: activeGoals, ambition };
  }),
```

---

## Component Structure

### New components:
- `src/components/ui/ThoughtsTab.tsx` — Main container with 4 collapsible sections
- `src/components/ui/CurrentThought.tsx` — Template-assembled thought sentence + mood + states + action
- `src/components/ui/GoalsView.tsx` — Ambition + active goals with progress bars
- `src/components/ui/SecretsOpinions.tsx` — Secrets list + relationship opinions

### Modified components:
- `src/components/ui/AgentPanel.tsx` — Add 4th tab, wire new components
- `src/components/ui/MemoryLog.tsx` — No changes (reused in Layer 4)

### Removed from existing tabs:
- Profile tab: Remove "Current Action" section, remove "Active States" section
- Mind tab: Remove "Known Facts" section, remove "Memory Log" section

---

## Styling

Follow existing AgentPanel patterns:
- Dark theme: `bg-gray-800`, `bg-gray-900`, `text-white`
- Collapsible headers: click to toggle, chevron indicator (▸ collapsed, ▾ expanded)
- Section spacing: `space-y-3` between layers
- Badges: existing colored pill pattern (e.g., state badges, trait pills)
- Progress bars: thin `h-1.5` bars with color gradient

### Layer-specific styling:
- **Surface**: No collapse header, always visible. Thought text in `text-sm italic text-gray-300`. Mood emoji large (20px). States as inline badges.
- **Goals**: Ambition has category color border-left. Goal cards are compact with inline progress bar.
- **Secrets**: Sensitivity icons inline. Type dots use existing fact color scheme from Mind tab.
- **Opinions**: Compact list, one line per agent. Gray subtext for values.
- **Memories**: Exact same styling as current MemoryLog.

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/components/ui/ThoughtsTab.tsx` | **NEW** — Main container with 4 collapsible layers |
| `src/components/ui/CurrentThought.tsx` | **NEW** — Template sentence + mood + states + action |
| `src/components/ui/GoalsView.tsx` | **NEW** — Ambition + goals with progress |
| `src/components/ui/SecretsOpinions.tsx` | **NEW** — Secrets list + opinions |
| `src/components/ui/AgentPanel.tsx` | Add 4th "Thoughts" tab, remove moved sections |
| `server/routers/agents.ts` | Add `getAgentThoughts` query |
