# Little Life — Art Bible

**Date:** 2026-04-15
**Style Reference:** RimWorld
**Status:** Approved

---

## Section 1: Visual Identity Statement

**Core Rule:** When in doubt, choose the option a player can parse in under one second.

### Supporting Principles

1. **Terrain is background, agents are foreground.** Tiles use muted earth tones (desaturated browns, tans, gray-greens); agents and interactive objects carry the only saturated color. If a tile competes with agents for attention, darken it.

2. **Color communicates state, not aesthetics.** Every color choice must map to a readable data point (mood, zone type, selection). Pick legibility at 40% opacity over beauty at full opacity.

3. **Decoration earns its pixel count.** No visual element without a gameplay reason. If removing it doesn't make the game harder to read, remove it.

---

## Section 2: Mood & Atmosphere

### Day Phases

| Phase | Time | Overlay Tint | Alpha | Energy | Signature Detail |
|-------|------|-------------|-------|--------|-----------------|
| Dawn | 5–7am | `#FFB347` amber | 0.08 | Waking | Long eastward shadows |
| Morning | 7am–12pm | neutral | 0.00 | Crisp | Full saturation baseline |
| Afternoon | 12–5pm | `#FFF5CC` warm ivory | 0.05 | Steady | Terrain reads brightest |
| Evening | 5–8pm | `#FF8C42` deep amber | 0.12 | Winding | Warm agent edge glow |
| Night | 8pm–5am | `#1A1F3C` deep navy | 0.55 | Still | Only status rings + window lights visible |

### Seasons

| Season | Terrain Shift | Sky Tint | Alpha | Detail |
|--------|--------------|----------|-------|--------|
| Spring | Grass `#5FA85F` saturated | `#E8F4FF` cool blue | 0.04 | Scattered flower tiles (2%) |
| Summer | Grass bleaches to `#A8C46F` | `#FFF8E7` pale gold | 0.06 | Heat haze, flattened contrast |
| Autumn | Ground `#C4864A` / `#8B5E3C` russet | `#FFE0B2` peach | 0.10 | Leaf scatter tiles |
| Winter | Ground `#D6E8F0` grey-blue | `#EDF4FF` ice blue | 0.15 | Agent trails linger 2 frames |

Terrain palette shifts applied to tileset tint, not overlay. Agents remain fully saturated in all seasons.

### Weather

| Condition | Tint | Alpha | Detail |
|-----------|------|-------|--------|
| Clear | — | 0.00 | Baseline |
| Rain | `#4A6080` blue-grey | 0.18 | Terrain darkens; rain particles above terrain, below agents |
| Storm | `#2E3D55` dark slate | 0.30 | `#FFFFFF` 1-frame flash at 0.15 alpha for lightning |
| Snow | `#E8EFF5` pale blue | 0.20 | Snowfall particles; agents desaturate 10% |
| Fog | `#C8D4CC` grey-green | 0.35 | Sprites beyond 6 tiles fade to 40% alpha |

### Drama Levels

| Level | Tint | Alpha | Detail |
|-------|------|-------|--------|
| Calm | — | 0.00 | Baseline |
| Tense | `#8B2FC9` muted violet | 0.06 | Relationship particles pulse slower; UI accent → `#C084FC` |
| Crisis | `#C0392B` desaturated red | 0.10 | Involved agents get 1px `#FF4444` rim light |

Drama tints additive on top of day phase + weather. Combined alpha capped at 0.70.

**Master Contrast Rule:** Agent sprite minimum contrast against any overlay stack: 4.5:1. If below threshold, boost agent brightness +15%.

---

## Section 3: Color System

### Primary Palette

| Role | Hex | Usage |
|------|-----|-------|
| `terrain-base` | `#2d2a24` | Ground tiles, world base |
| `terrain-mid` | `#3d3a30` | Secondary ground, paths |
| `agent-neutral` | `#e8d5a3` | Agent fill at mood 50 |
| `accent-primary` | `#c8a84b` | UI highlights, gold, wealth |
| `accent-alert` | `#ef4444` | Danger, critical states |
| `accent-positive` | `#10b981` | Health, prosperity |

### Mood → Agent Fill

| Mood | Hex | Label |
|------|-----|-------|
| 0 | `#1a1a2e` | Despair — near-black blue |
| 25 | `#4a3f5c` | Low — muted purple-gray |
| 50 | `#7a6f5a` | Neutral — warm gray |
| 75 | `#c4a35a` | Good — warm gold |
| 100 | `#e8d5a3` | Thriving — bright parchment |

Smooth HSL lerp between stops. Dark agent = suffering, bright = thriving. State rings layered on top stay fully saturated.

### Relationship Colors

| Type | Hex | Style |
|------|-----|-------|
| Friendship | `#60a5fa` | Solid line |
| Romance | `#f472b6` | Solid + pulse animation |
| Rivalry | `#f97316` | Dashed line |
| Trust | `#34d399` | Dotted line |

Line weight encodes strength (1–3px). Alpha encodes recency.

### Building Floor Palette

| Building | Hex | Material |
|----------|-----|----------|
| Home | `#6b5b45` | Worn wood |
| Shop | `#5a5040` | Dark wood |
| Tavern | `#7a4f35` | Red-brown wood |
| Clinic | `#d8e8e0` | Pale stone |
| Town Hall | `#7a6a4a` | Dressed stone |
| Bakery | `#6B5B4A` | Light wood |
| Workshop | `#4a4a42` | Concrete |
| Prison | `#6A6A6A` | Dark stone |
| Farm | `#6b7c3a` | Packed dirt/grass |
| Park | `#4a6b3a` | Grass |
| Town Square | `#8a7a5a` | Stone tile |

### Zone Overlay System

| Zone Privacy | Hex | Alpha |
|-------------|-----|-------|
| Public | `#ffffff` | 0.00 (no overlay) |
| Semi-public | `#a3b8cc` | 0.08 |
| Commercial | `#c8a84b` | 0.10 |
| Residential | `#c8a070` | 0.12 |
| Civic | `#7a9ab0` | 0.12 |
| Private | `#ff6b6b` | 0.15 |
| Restricted | `#ff0000` | 0.20 |

Alpha scales with privacy. Color communicates type.

### UI Palette (Dark Theme)

| Role | Hex |
|------|-----|
| `ui-bg-deep` | `#0f0e0b` |
| `ui-bg-panel` | `#1a1814` |
| `ui-bg-raised` | `#252219` |
| `ui-bg-hover` | `#2e2b20` |
| `ui-border` | `#3d3a2e` |
| `ui-border-accent` | `#6b5c30` |
| `ui-text-primary` | `#d4c9a8` |
| `ui-text-secondary` | `#8a7f65` |
| `ui-text-disabled` | `#4a4535` |
| `ui-accent-gold` | `#c8a84b` |
| `ui-accent-blue` | `#5a8fb0` |
| `ui-positive` | `#10b981` |
| `ui-negative` | `#ef4444` |
| `ui-warning` | `#f59e0b` |

No pure black. No pure white. `ui-text-primary` on `ui-bg-panel` = 7:1 contrast.

### System Coherence Rules

1. Terrain stays within `#1a1814` → `#5a5548`. Nothing in the world exceeds this range.
2. Agents are the only bright elements at world level.
3. State rings always more saturated than fill. Ring = emotion. Fill = wellbeing.
4. Zone overlays are hints, never dominant. Floor must be visible through overlay.
5. UI panels never use world colors — darker and cooler to maintain depth separation.

---

## Section 4: Tile & Zone Aesthetics

### Walls

| Property | Value |
|----------|-------|
| Color | `#4a3f2e` (stone) / `#3d3228` (wood) |
| Thickness | 3px inner stroke |
| Shadow | 2px offset, `#1a1510` at 60% alpha, south + east faces |
| Corner | Square, no rounding |
| Interior face | 1px lighter (`#5a4f3e`) |

### Doors

| Property | Value |
|----------|-------|
| Open | Gap in wall + 2px `#8b6914` lintel bar |
| Width | 2 tiles (64px) |

### Zone Differentiation

Zone boundaries: 1px dashed line `#3a3028`, dash 4px gap 4px. Zones use tint difference ≤ 8% luminance — never colored fills.

| Zone Type | Floor Tint |
|-----------|-----------|
| Bedroom | `#2a2018` |
| Kitchen | `#1e2218` (cool) |
| Workbench | `#251e14` + faint cross-hatch 10% alpha |
| Storage | `#1c1c18` |
| Social/common | `#22201a` |

### Furniture

5px monospace labels, `#a09070`, centered on tile. Uppercase: `BED`, `STOVE`, `BENCH`, `TABLE`, `CHEST`. No bitmap sprites in v1.

### Open Area Terrain

| Element | Color | Notes |
|---------|-------|-------|
| Grass | `#2d2a24` | Default ground |
| Dirt path | `#4a3d2c` | 2px noise dither at edges |
| Farm tilled | `#3a2e1e` | Row lines 1px `#2a2018` |
| Crops | `#2d3a1e` | Green tint on crop tiles only |
| River | `#1a2830` | Alpha pulse shimmer |
| Market stall | `#4a3828` | 1px gold `#c8a84b` top edge |

### Grid Lines

No visible grid by default. Debug mode: 1px `#3a3530` at 20% alpha.

---

## Section 5: Agent Visual Design

### Circle Geometry

| Property | Value |
|----------|-------|
| Radius | 10px |
| Body fill | `#2a2520` |
| Body outline | 1.5px, color = emotional state |
| Initial font | 8px monospace bold, `#d4c9a8` |
| Name label | 7px, `#a09070`, 2px below circle |

### Action Communication

| Action | Visual |
|--------|--------|
| Walking | Gold 4px dash trail, 3 dashes, 200ms fade |
| Working | 3px gold spinning arc, 1.2s rotation |
| Sleeping | `zz` replaces initial; outline dims 40% |
| Eating | Fork glyph replaces initial |
| Fighting | Red outline pulses 4Hz; ±1px shake |
| Talking | Speech bubble active |
| Idle | No animation, full opacity |

### State Stacking

Primary state = outer ring color. Secondary state = inner 1px dashed ring at 60%. Max 2 rings.

### Interior Glow

Additive blend, white, radius 14px, alpha 0.12. Active when inside building.

### Selection Ring

Gold `#c8a84b` ellipse 18×6px, 1.5px stroke, slow pulse 0.8–1.0 alpha.

---

## Section 6: UI Visual Direction

### Panel Chrome

| Property | Value |
|----------|-------|
| Background | `#1a1814` |
| Border | 1px `#3a3028` |
| Corner radius | 0px (hard corners) |
| Header | `#221e18`, 9px monospace uppercase, `#c8a84b` |

### Tabs

Active: `#2a2520` fill, 1px top gold, text `#d4c9a8`. Inactive: `#1a1814`, text `#787060`. 8px monospace uppercase, 24px height.

### Activity Feed

20px fixed entry height. 8px monospace. Timestamp `#504838` 32px wide. Category glyph in 10×10 colored box. Message text `#a09070` truncated to 1 line. New entry flash: `#2a2010` fades 400ms.

### Category Glyphs

| Category | Color | Glyph |
|----------|-------|-------|
| Chat | `#6080c0` | `[ ]` |
| Economy | `#c8a84b` | `$` |
| Drama | `#a03028` | `!` |
| States | `#787060` | `◆` |
| Social | `#a0c060` | `♦` |
| Goals | `#c07840` | `▶` |
| System | `#504838` | `⚙` |

### Scrollbar

Track `#141210` 6px. Thumb `#3a3028` 6px rounded 2px. No arrows.

### Modals

Backdrop `#000000` 60%. Modal `#1a1814`, 1px `#c8a84b` border, 640px max. Hard corners.

---

## Section 7: VFX & Particle Style

### Particle Profiles (7 active)

| Profile | Color | Count | Blend |
|---------|-------|-------|-------|
| Sparkle (positive) | `#e8d5a3` 60% | 4–6 | Additive |
| Conflict (fight) | `#a03028` | 8–12 | Normal |
| Trade | `#c8a84b` 70% | 5–8 | Normal |
| Speech | `#6080c0` 50% | 3–5 | Additive |
| Death | `#3a3028` → transparent | 15–20 | Normal |
| Rain | `#1a2830` | Max 200 | Normal |
| Snow | `#c8d0d8` 60% | Max 150 | Normal |

Cut profiles: sleep_zz, work_dust, love, celebration, hunger, xp_gain, fireflies (text glyphs or state rings cover these).

### Particle Rules

- No pure white particles. Max brightness: `#e8d5a3`
- Alpha range: 0.3–0.8 (never opaque)
- Environmental particles: alpha 0.4–0.7 max
- Rain as 2×6px diagonal lines. Snow as 2×2px squares. Leaves as 4×4px rotating rects.

---

## Section 8: Asset Standards

### Dimensions

| Asset | Size |
|-------|------|
| Tile | 32×32px |
| Particle texture | 128×128px |
| Agent sprite (future) | 32×32px |
| UI icon | 10×10px (glyph preferred) |

### Color Format

PixiJS: `0xRRGGBB`. CSS/Tailwind: `#rrggbb`. Never `rgba()` in PixiJS.

### Naming Convention

`[category]_[name]_[variant].[ext]` — all lowercase, underscores only.

### Fallback Rendering

| Asset | Fallback |
|-------|----------|
| Terrain | Solid `#2d2a24` fill |
| Wall | Solid `#4a3f2e` + 1px border |
| Particle | 16px white circle via Graphics |
| Agent | Colored circle (existing) |
| UI icon | Monospace glyph |

Fallbacks log once to console, never throw.

### Performance Budget

| Metric | Target | Limit |
|--------|--------|-------|
| Draw calls | ≤ 80 | 120 |
| Active particles | ≤ 300 | 500 |
| Texture memory | ≤ 64MB | 128MB |
| Target FPS | 60 | 30 (degraded) |

### Layer Stack (z-order)

| Layer | Index | Contents |
|-------|-------|----------|
| terrain | 0 | Ground tiles |
| zones | 1 | Zone overlays |
| furniture | 2 | Labels + rects |
| walls | 3 | Walls + doors |
| agents | 4 | Circles + rings |
| particles | 5 | All VFX |
| ui_world | 6 | Speech bubbles, world labels |

React handles all panel chrome — never render UI panels into PixiJS stage.
