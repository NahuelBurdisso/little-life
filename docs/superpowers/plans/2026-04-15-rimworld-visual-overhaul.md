# RimWorld Visual Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the art bible (`docs/superpowers/specs/art-bible.md`) to transform Little Life's visuals from bright/colorful to a muted RimWorld-style aesthetic across terrain, buildings, agents, UI, and particles.

**Architecture:** Update color constants in data files, restyle PixiJS rendering classes (TilemapRenderer, BuildingRenderer, AgentSprite, DayNightCycle, particles), and retheme React UI components via Tailwind classes. Each task changes one visual system independently — no cross-dependencies between tasks.

**Tech Stack:** PixiJS 8, React 19, TypeScript, Tailwind CSS, ShadCN

**Spec:** `docs/superpowers/specs/art-bible.md`

---

## File Structure

### Modified Files
| File | Changes |
|------|---------|
| `src/lib/tileMap.ts` | Replace terrain colors with art bible palette |
| `src/lib/spriteConfig.ts` | Replace agent color function with mood-based fill |
| `src/components/canvas/TilemapRenderer.ts` | Dark earth background |
| `src/components/canvas/BuildingRenderer.ts` | Art bible floor materials, wall style, zone overlays, door style |
| `src/components/canvas/AgentSprite.ts` | Dark body fill, state-colored outline, action glyphs |
| `src/components/canvas/SpritePool.ts` | Pass mood to AgentSprite for fill color |
| `src/components/canvas/DayNightCycle.ts` | Art bible tint values per phase |
| `src/components/canvas/BubbleSystem.ts` | Restyle speech bubbles to dark theme |
| `src/components/canvas/particles/profileRegistry.ts` | Cut to 7 profiles, muted colors |
| `src/components/ui/ActivityFeed.tsx` | RimWorld-style dark theme, monospace, gold accents |
| `src/styles/globals.css` | CSS custom properties for UI palette |

---

## Task 1: Terrain & World Palette

**Files:**
- Modify: `src/lib/tileMap.ts`
- Modify: `src/components/canvas/TilemapRenderer.ts`

- [ ] **Step 1: Update TERRAIN_COLORS to art bible palette**

```ts
// src/lib/tileMap.ts
export const TERRAIN_COLORS = {
  grass: 0x2d2a24,        // dark earth base (was 0x4a8c3f)
  path: 0x4a3d2c,         // dirt path (was 0xc4a66a)
  water: 0x1a2830,        // dark river (was 0x4a7fb5)
  bridge: 0x5a5040,       // muted wood (was 0x8B7355)
  building: 0x3d3228,     // dark building fill (was 0x555555)
  buildingRoof: 0x2a2520, // darker roof (was 0x666666)
  door: 0x8b6914,         // gold lintel (was 0x885533)
} as const;
```

- [ ] **Step 2: Verify TilemapRenderer uses TERRAIN_COLORS.grass**

Already does at line 70. No change needed — just verify the dark background renders.

- [ ] **Step 3: Visual check**

Run dev, verify world background is dark earth `#2d2a24` instead of bright green.

- [ ] **Step 4: Commit**

```bash
git add src/lib/tileMap.ts && git commit -m "feat(art): dark earth terrain palette per art bible"
```

---

## Task 2: Building Renderer Restyle

**Files:**
- Modify: `src/components/canvas/BuildingRenderer.ts`

- [ ] **Step 1: Update FLOOR_MATERIALS to art bible values**

```ts
const FLOOR_MATERIALS: Record<string, number> = {
  home: 0x6b5b45,
  shop: 0x5a5040,
  tavern: 0x7a4f35,
  clinic: 0xd8e8e0,
  town_hall: 0x7a6a4a,
  bakery: 0x6B5B4A,
  workshop: 0x4a4a42,
  prison: 0x6A6A6A,
};
```

- [ ] **Step 2: Update OPEN_AREA_COLORS to muted earth tones**

```ts
const OPEN_AREA_COLORS: Record<string, number> = {
  farm: 0x6b7c3a,        // packed dirt/grass (was 0x7cba4a)
  town_square: 0x8a7a5a, // stone tile (was 0xd4b483)
  park: 0x4a6b3a,        // grass (was 0x5a9c4f)
};
```

- [ ] **Step 3: Restyle wall rendering**

In `addBuilding()`:
- Wall stroke: 3px `#4a3f2e` (was 2px `#444444`)
- Add inner shadow: 2px inset stroke `#1a1510` at alpha 0.6 on south+east
- Zone fill alpha: lower from 0.55 to 0.40 (more transparent, floor shows through)
- Zone border: 1px dashed `#3a3028` (was 0.5px solid black)

- [ ] **Step 4: Restyle door rendering**

Door: `#8b6914` gold lintel bar (was brown rectangle)

- [ ] **Step 5: Visual check**

Run dev, verify buildings have dark earth floors, subtle zone boundaries, gold door accents.

- [ ] **Step 6: Commit**

```bash
git add src/components/canvas/BuildingRenderer.ts && git commit -m "feat(art): RimWorld building style — dark floors, gold doors, muted zones"
```

---

## Task 3: Agent Sprite Overhaul

**Files:**
- Modify: `src/components/canvas/AgentSprite.ts`
- Modify: `src/lib/spriteConfig.ts`
- Modify: `src/components/canvas/SpritePool.ts`

- [ ] **Step 1: Replace getAgentColor with mood-based fill**

```ts
// src/lib/spriteConfig.ts — replace getAgentColor
const MOOD_STOPS = [
  { mood: 0,   color: 0x1a1a2e }, // despair
  { mood: 25,  color: 0x4a3f5c }, // low
  { mood: 50,  color: 0x7a6f5a }, // neutral
  { mood: 75,  color: 0xc4a35a }, // good
  { mood: 100, color: 0xe8d5a3 }, // thriving
];

export function getMoodColor(mood: number): number {
  // HSL lerp between stops
  const clamped = Math.max(0, Math.min(100, mood));
  for (let i = 0; i < MOOD_STOPS.length - 1; i++) {
    const a = MOOD_STOPS[i], b = MOOD_STOPS[i + 1];
    if (clamped >= a.mood && clamped <= b.mood) {
      const t = (clamped - a.mood) / (b.mood - a.mood);
      return lerpColor(a.color, b.color, t);
    }
  }
  return MOOD_STOPS[MOOD_STOPS.length - 1].color;
}

function lerpColor(a: number, b: number, t: number): number {
  const ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  const br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  const r = Math.round(ar + (br - ar) * t);
  const g = Math.round(ag + (bg - ag) * t);
  const blue = Math.round(ab + (bb - ab) * t);
  return (r << 16) | (g << 8) | blue;
}

// Keep getAgentColor for backward compat but deprecate
```

- [ ] **Step 2: Restyle AgentSprite**

In AgentSprite constructor:
- Body fill: `0x2a2520` (dark, static — mood color applied via outline)
- Body outline: 1.5px stroke colored by state (was no outline, fill was colored)
- Letter fill: `0xd4c9a8` (warm parchment, was white)
- Name label fill: `0xa09070` (muted, was white)
- Selection ring: `0xc8a84b` gold (was `0xffdd44`)

- [ ] **Step 3: Add mood-based outline update**

Add `updateMood(mood: number)` method to AgentSprite:
```ts
updateMood(mood: number): void {
  this.circle.clear();
  this.circle.circle(0, 0, AGENT_RADIUS);
  this.circle.fill({ color: 0x2a2520 });
  this.circle.stroke({ width: 1.5, color: getMoodColor(mood) });
}
```

- [ ] **Step 4: Pass mood from SpritePool to AgentSprite**

In SpritePool.update(), after `sprite.updateStates()`:
```ts
sprite.updateMood(agent.needs?.mood ?? 50);
```

- [ ] **Step 5: Visual check**

Run dev, verify agents are dark circles with mood-colored outlines. Bright outline = thriving. Dark outline = suffering.

- [ ] **Step 6: Commit**

```bash
git add src/lib/spriteConfig.ts src/components/canvas/AgentSprite.ts src/components/canvas/SpritePool.ts && git commit -m "feat(art): dark agent sprites with mood-colored outlines"
```

---

## Task 4: Day/Night Cycle Restyle

**Files:**
- Modify: `src/components/canvas/DayNightCycle.ts`

- [ ] **Step 1: Update phase tints to art bible values**

```ts
private getPhaseStyle(phase: string): { color: number; alpha: number } {
  switch (phase) {
    case "dawn":      return { color: 0xFFB347, alpha: 0.08 };  // was 0.15
    case "morning":   return { color: 0x000000, alpha: 0 };
    case "afternoon": return { color: 0xFFF5CC, alpha: 0.05 };  // new: warm ivory
    case "evening":   return { color: 0xFF8C42, alpha: 0.12 };  // was 0.2
    case "night":     return { color: 0x1A1F3C, alpha: 0.55 };  // was 0.4
    default:          return { color: 0x000000, alpha: 0 };
  }
}
```

Key changes: dawn/evening are subtler (RimWorld style). Night is deeper. Afternoon gets a warm tint.

- [ ] **Step 2: Commit**

```bash
git add src/components/canvas/DayNightCycle.ts && git commit -m "feat(art): subtle day/night tints per art bible"
```

---

## Task 5: Speech Bubble Restyle

**Files:**
- Modify: `src/components/canvas/BubbleSystem.ts`

- [ ] **Step 1: Restyle speech bubbles to dark theme**

Update styles:
```ts
const SPEECH_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 7,
  fill: 0xd4c9a8,      // warm parchment (was 0x222222 dark)
  wordWrap: true,
  wordWrapWidth: 100,
});
```

Bubble background: `0x1a1814` at 0.9 alpha (was white).
Bubble border: 1px `0xc8a84b` gold (was none or gray).

- [ ] **Step 2: Restyle thought text**

```ts
const THOUGHT_STYLE = new PIXI.TextStyle({
  fontFamily: "monospace",
  fontSize: 10,
  fill: 0x8a7f65,    // muted secondary (was 0x666666)
});
```

- [ ] **Step 3: Visual check**

Run dev, trigger a conversation, verify bubbles are dark with gold border and parchment text.

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/BubbleSystem.ts && git commit -m "feat(art): dark speech bubbles with gold accent"
```

---

## Task 6: Particle System Trim

**Files:**
- Modify: `src/components/canvas/particles/profileRegistry.ts`

- [ ] **Step 1: Cut particle profiles from 14 to 7**

Keep: drunk_bubbles (rename to `sparkle`), angry_sparks (rename to `conflict`), environmental rain, environmental snow, environmental leaves.

Add: `trade` (gold coins arc), `speech` (blue float).

Remove: infatuated_hearts, heartbroken_rain, depressed_cloud, stressed_sparks, euphoric_stars, confident_glow, sick_fumes, lonely_motes, dawn_motes.

- [ ] **Step 2: Mute remaining profile colors**

All particle colors from art bible:
- Sparkle: `0xe8d5a3` at 0.6 alpha
- Conflict: `0xa03028` at 0.7 alpha
- Trade: `0xc8a84b` at 0.7 alpha
- Speech: `0x6080c0` at 0.5 alpha
- Rain: `0x1a2830`, 2×6px lines
- Snow: `0xc8d0d8` at 0.6, 2×2px
- Leaves: `0x4a5028` / `0x6a5828`, 4×4px

- [ ] **Step 3: Set max particle alpha to 0.8**

In each remaining profile, cap `alpha` field at 0.8.

- [ ] **Step 4: Commit**

```bash
git add src/components/canvas/particles/profileRegistry.ts && git commit -m "feat(art): trim particles to 7 profiles, muted RimWorld palette"
```

---

## Task 7: Activity Feed UI Restyle

**Files:**
- Modify: `src/components/ui/ActivityFeed.tsx`

- [ ] **Step 1: Replace Tailwind classes with art bible UI palette**

Container: `bg-[#1a1814]` border `border-[#3a3028]` (was `bg-gray-800 border-gray-700`)

Filter buttons: text `text-[#d4c9a8]`, border `border-[#3a3028]`, active bg uses category color at 20%.

Event entries: text `text-[#a09070]` (was `text-gray-300`), timestamp `text-[#504838]`, drama text `text-[#a03028]` (was `text-red-300`).

- [ ] **Step 2: Update category colors to art bible**

```ts
const EVENT_CATEGORIES = {
  conversation: { icon: '[ ]', color: '#6080c0', label: 'Chat' },
  economy:      { icon: '$',   color: '#c8a84b', label: 'Econ' },
  drama:        { icon: '!',   color: '#a03028', label: 'Drama' },
  state_change: { icon: '◆',   color: '#787060', label: 'States' },
  relationship: { icon: '♦',   color: '#a0c060', label: 'Social' },
  world_event:  { icon: '~',   color: '#4080a0', label: 'World' },
  goal:         { icon: '▶',   color: '#c07840', label: 'Goals' },
  aspiration:   { icon: '★',   color: '#9b7ab0', label: 'Dreams' },
  system:       { icon: '⚙',   color: '#504838', label: 'System' },
  error:        { icon: '✕',   color: '#a03028', label: 'Errors' },
  planning:     { icon: '▷',   color: '#c8a84b', label: 'Plans' },
  cascade:      { icon: '⛓',   color: '#c07840', label: 'Cascade' },
} as const;
```

- [ ] **Step 3: Monospace font + hard corners**

Remove `rounded-full` from filter buttons → use `rounded-none` or just remove rounding.
Font: ensure all text uses `font-mono` class.

- [ ] **Step 4: Visual check**

Run dev, verify activity feed has dark parchment theme, gold accents, monospace text, no rounded corners.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/ActivityFeed.tsx && git commit -m "feat(art): RimWorld-style activity feed — dark theme, gold accents, monospace"
```

---

## Task 8: CSS Custom Properties for UI Palette

**Files:**
- Modify: `src/styles/globals.css`

- [ ] **Step 1: Add art bible CSS variables**

```css
@import "tailwindcss";

:root {
  --ui-bg-deep: #0f0e0b;
  --ui-bg-panel: #1a1814;
  --ui-bg-raised: #252219;
  --ui-bg-hover: #2e2b20;
  --ui-border: #3d3a2e;
  --ui-border-accent: #6b5c30;
  --ui-text-primary: #d4c9a8;
  --ui-text-secondary: #8a7f65;
  --ui-text-disabled: #4a4535;
  --ui-accent-gold: #c8a84b;
  --ui-accent-blue: #5a8fb0;
  --ui-positive: #10b981;
  --ui-negative: #ef4444;
  --ui-warning: #f59e0b;
}

body {
  background-color: var(--ui-bg-deep);
  color: var(--ui-text-primary);
  font-family: monospace;
}
```

These variables can be used by other UI components (AgentPanel, RelationshipGraph, etc.) without modifying each one now.

- [ ] **Step 2: Commit**

```bash
git add src/styles/globals.css && git commit -m "feat(art): CSS custom properties for RimWorld UI palette"
```

---

## Task 9: Integration Smoke Test

- [ ] **Step 1: Run full test suite**

```bash
cd D:/proyects/little-life && npx vitest run
```
Expected: All 331 tests pass (visual changes don't affect logic tests)

- [ ] **Step 2: Type check**

```bash
cd D:/proyects/little-life && npx tsc --noEmit 2>&1 | grep -v "6133"
```
Expected: No errors

- [ ] **Step 3: Manual visual verification**

Run simulation. Verify:
- Dark earth terrain (not bright green)
- Dark buildings with muted zone overlays
- Dark agent circles with mood-colored outlines
- Subtle day/night tinting
- Dark speech bubbles with gold borders
- Muted particle effects (7 profiles, no hearts/clouds)
- Dark activity feed with gold accents and monospace text

- [ ] **Step 4: Final commit**

```bash
git add -u && git commit -m "feat(art): RimWorld visual overhaul complete — art bible applied"
```
