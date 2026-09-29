# Feedback pass — every action and area answers visually

**Goal:** anything the player or an agent *does* in the town produces something visible, and
every area (building, open space, UI panel) looks finished.

**Source:** two audits on 2026-09-29 (agent actions/locations vs canvas; player interactions vs UI).
Headline gaps: nudge results discarded; one generic canvas ping for every intervention; plan-chosen
zone activities arrive as plain `idle`; jog/comfort/theft/eating/shopping have no cue; places never
react to what happens inside (forge, oven, tavern, clinic, crops); outdoor zones and many interior
zones are 14%-alpha colour rects or text labels; heatwave/mysterious_stranger/bountiful_catch/
new_arrival/cloudy show nothing; buildings can't be clicked; two UI palettes; bare empty/loading states.

**Foundation (done, `2ff6e84`):** `lib/toast.ts` + `ui/Toasts.tsx`; `useNudge` toasts results and emits
`intervention` only on success with a typed `kind` (+ `locationId`, `amount`); canvas bus gained
`focus` / `focusLocation` (handled in `GameCanvas`); `introduce_agent` returns `agentId`.

## Workstreams (parallel, one worktree each)

| | Owner scope | Delivers |
|---|---|---|
| A | `systems/playerFx/` (+ intervention code moved out of `BeatSystem`), `player-fx.lua`, pause/speed overlay in `GameCanvas` JSX | per-kind canvas answer to each nudge, newcomer arrival, farewell, event burst; PAUSED banner |
| B | `decisions.ts` plan-verb fix, `held/heldItem.ts`, `BubbleSystem` activity emotes, `statePose.ts`, `AgentSprite`, `systems/activityFx/`, `activity-fx.lua`, work thought text | every agent activity has a pose/held item/emote/FX on the agent |
| C | `systems/placeLife/`, `place-life.lua`, crop seasons in `TilemapRenderer`, smoke block in `GameCanvas` | buildings and fields react to who's inside and what they do |
| D | `furniture.lua`, `BuildingRenderer` furniture + open-area zones | real props for every interior and outdoor zone |
| E | `townEvents/*`, `event-decor.lua`, `WeatherEffects`, `server/engine/systems/events.ts` | canvas presence for every event and weather |
| F1 | EventMenu, NudgeMenu, NewAgentDialog, SpeedControls, keyboard, ActivityFeed, new LocationPanel + building click | UI acknowledgement for every player control; buildings clickable |
| F2 | TopBar, AgentPanel + subviews, TownStats, RelationshipGraph, Conversation*, AgentTooltip, DramaAlerts, App toolbar/loading, setup/*, new AutoplayPanel | one warm palette, designed empty/loading states, clickable rows, autoplay exposed |

Merge order: E, D, C, B, A, F2, F1 (canvas first, UI last; `App.tsx`/`GameCanvas.tsx`/`systems/index.ts`
conflicts resolved by hand). Gate after each merge; live probe at the end.
