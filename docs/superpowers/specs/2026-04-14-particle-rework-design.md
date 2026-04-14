# Particle System Rework: Expressive & Dramatic

## Problem

The current particle system looks bad:
- Particles are nearly invisible (0.02 scale = ~10px from 512px textures)
- Most effects don't rotate — static circles look cheap
- No burst on state trigger — effects fade in gradually instead of popping
- Sad states (grieving, depressed) have emission rate=1, barely visible
- Colors repeat across emotions (drunk gold vs confident gold)
- Particles render above UI bubbles, occluding text
- 500 particle pool overflows with 12 agents + weather
- depressed_cloud shoots in random directions instead of drifting down
- Environmental effects are incomplete (no rain, no leaves, no petals)

## Solution

Full rework of the profile registry and engine tweaks. Architecture stays the same (data-driven profiles, object pool, trigger matching) — the system is well-designed, just poorly tuned.

### Design Direction

**Expressive & Dramatic** — larger particles (8-16px), glow effects, burst on state trigger, anime-style emotion indicators. Each emotion has a unique shape + color + motion signature that's immediately recognizable.

---

## Emotion → Particle Mapping

### Agent State Particles (9 profiles)

#### 1. `drunk_bubbles` (reworked)
- **Shape:** circle (Kenney soft glow)
- **Colors:** `[0xfbbf24, 0xf59e0b, 0xd97706]` (golden amber)
- **Scale:** 0.04-0.08
- **Motion:** Upward with sinusoidal horizontal wobble (direction: [-0.7π, -0.3π])
- **Speed:** 8-15 px/s
- **Gravity:** -3 (gentle upward assist)
- **Rotation:** 0.5 rad/s
- **Rate:** 2/s, maxAlive: 6, lifetime: 2-3.5s
- **Burst:** 3 on activation
- **Fade:** fadeIn 0.3s, fadeOut 0.6s
- **Offset:** (0, -10) above head

#### 2. `infatuated_hearts` (reworked)
- **Shape:** heart (programmatic)
- **Colors:** `[0xec4899, 0xf472b6, 0xfb7185]` (pink spectrum)
- **Scale:** 0.05-0.10
- **Motion:** Burst outward-upward (direction: [-0.9π, -0.1π]), decelerate
- **Speed:** 15-25 px/s (fast burst, slows via friction)
- **Gravity:** -2
- **Rotation:** 1.5 rad/s (spinning hearts)
- **Rate:** 2.5/s, maxAlive: 7, lifetime: 2-3s
- **Burst:** 5 on activation
- **Fade:** fadeIn 0.2s, fadeOut 0.8s
- **Offset:** (0, -8)

#### 3. `angry_sparks` (reworked)
- **Shape:** spark (Kenney hard edge glow)
- **Colors:** `[0xef4444, 0xf97316, 0xfbbf24]` (red → orange → gold)
- **Scale:** 0.03-0.07
- **Motion:** Explosive all directions (direction: [-π, π])
- **Speed:** 25-45 px/s (fast, violent)
- **Gravity:** 5 (sparks arc down after burst)
- **Rotation:** 4 rad/s (fast spin)
- **Rate:** 4/s, maxAlive: 10, lifetime: 0.4-1.0s
- **Burst:** 8 on activation
- **Fade:** fadeIn 0.05s, fadeOut 0.3s
- **Offset:** (0, -6)

#### 4. `grieving_tears` (reworked)
- **Shape:** raindrop (Kenney tight glow)
- **Colors:** `[0x3b82f6, 0x60a5fa, 0x93c5fd]` (blue spectrum)
- **Scale:** 0.04-0.07
- **Motion:** Downward (direction: [0.35π, 0.65π])
- **Speed:** 10-18 px/s
- **Gravity:** 15 (heavy, accelerating drops)
- **Rotation:** 0
- **Rate:** 2.5/s, maxAlive: 6, lifetime: 1.5-2.5s
- **Burst:** 4 on activation
- **Fade:** fadeIn 0.2s, fadeOut 0.4s
- **Offset:** (0, -4)

#### 5. `depressed_cloud` (reworked — major change)
- **Shape:** circle (Kenney soft glow)
- **Colors:** `[0x7c3aed, 0x8b5cf6, 0x6d28d9]` (deep purple)
- **Scale:** 0.06-0.10 (larger, cloud-like)
- **Motion:** Slow drift downward with slight sway (direction: [0.3π, 0.7π])
- **Speed:** 3-6 px/s (very slow, heavy)
- **Gravity:** 2 (gentle downward pull)
- **Rotation:** 0.2 rad/s
- **Rate:** 2/s, maxAlive: 6, lifetime: 2.5-4s
- **Burst:** 0 (gradual onset, no burst — depression creeps in)
- **Fade:** fadeIn 0.8s, fadeOut 1.0s (long fade = lingering)
- **Alpha:** 0.35 (dim, oppressive)
- **Offset:** (0, -14) (higher up — cloud-like)

#### 6. `confident_sparkle` (reworked)
- **Shape:** star (programmatic 5-point)
- **Colors:** `[0xfacc15, 0xfde047, 0xfef08a]` (golden yellow)
- **Scale:** 0.04-0.08
- **Motion:** Outward with slight upward bias (direction: [-0.8π, -0.2π])
- **Speed:** 5-12 px/s
- **Gravity:** -1
- **Rotation:** 2 rad/s
- **Rate:** 2/s, maxAlive: 6, lifetime: 1.5-2.5s
- **Burst:** 4 on activation
- **Fade:** fadeIn 0.15s, fadeOut 0.5s
- **Offset:** (0, -8)

#### 7. `sick_miasma` (reworked)
- **Shape:** circle (Kenney soft glow)
- **Colors:** `[0x22c55e, 0x4ade80, 0x86efac]` (green spectrum)
- **Scale:** 0.05-0.10 (smoke puffs)
- **Motion:** Upward with lateral wobble (direction: [-0.8π, -0.2π])
- **Speed:** 4-8 px/s
- **Gravity:** -2 (rises like smoke)
- **Rotation:** 0.3 rad/s
- **Rate:** 1.5/s, maxAlive: 5, lifetime: 2-4s
- **Burst:** 0 (gradual, like sickness itself)
- **Fade:** fadeIn 0.5s, fadeOut 1.2s (slow dissolve)
- **Alpha:** 0.4
- **Offset:** (0, -4)

#### 8. `stressed_bolts` (new)
- **Shape:** spark (Kenney hard edge)
- **Colors:** `[0xf97316, 0xfb923c, 0xfdba74]` (orange spectrum)
- **Scale:** 0.03-0.05
- **Motion:** Erratic short bursts (direction: [-π, π])
- **Speed:** 15-30 px/s
- **Gravity:** 0
- **Rotation:** 6 rad/s (very fast, jittery)
- **Rate:** 3/s, maxAlive: 5, lifetime: 0.3-0.6s (very short — flash and gone)
- **Burst:** 3 on activation
- **Fade:** fadeIn 0.02s, fadeOut 0.1s (instant flash)
- **Alpha:** 0.8 (bright flash)
- **Offset:** (0, -10)

#### 9. `sleeping_zzz` (reworked)
- **Shape:** circle (will look like soft glow dots — Z shape not feasible with current texture system)
- **Colors:** `[0x8b5cf6, 0xa78bfa, 0xc4b5fd]` (soft purple)
- **Scale:** 0.03-0.06
- **Motion:** Upward-right diagonal (direction: [-0.6π, -0.3π])
- **Speed:** 4-8 px/s
- **Gravity:** -1
- **Rotation:** 0
- **Rate:** 1/s, maxAlive: 3, lifetime: 2.5-4s
- **Burst:** 0
- **Fade:** fadeIn 0.5s, fadeOut 1.0s
- **Alpha:** 0.5
- **Offset:** (4, -8)

### Environmental Particles (5 profiles)

#### 10. `weather_snow` (reworked)
- **Shape:** circle (Kenney soft glow)
- **Colors:** `[0xe2e8f0, 0xcbd5e1, 0xf1f5f9]` (white/silver)
- **Scale:** 0.02-0.05
- **Trigger:** season=winter
- **Spread:** 500 (wide viewport fill)
- **Motion:** Downward with gentle lateral drift
- **Speed:** 8-15 px/s
- **Gravity:** 3
- **Rotation:** 0.5 rad/s
- **Rate:** 10/s, maxAlive: 80, lifetime: 5-10s
- **Fade:** fadeIn 0.5s, fadeOut 1.5s
- **Alpha:** 0.5

#### 11. `autumn_leaves` (new)
- **Shape:** leaf (Kenney circle_03)
- **Colors:** `[0xf97316, 0xeab308, 0xdc2626, 0x854d0e]` (orange/gold/red/brown)
- **Scale:** 0.03-0.06
- **Trigger:** season=autumn
- **Spread:** 400
- **Motion:** Downward with wide lateral sway
- **Speed:** 5-12 px/s
- **Gravity:** 4
- **Rotation:** 1.5 rad/s (tumbling)
- **Rate:** 4/s, maxAlive: 30, lifetime: 4-8s
- **Fade:** fadeIn 0.3s, fadeOut 1.0s
- **Alpha:** 0.6

#### 12. `spring_petals` (new)
- **Shape:** circle (Kenney soft glow, small)
- **Colors:** `[0xf9a8d4, 0xfbcfe8, 0xf472b6, 0xfda4af]` (pink spectrum)
- **Scale:** 0.02-0.04
- **Trigger:** season=spring
- **Spread:** 400
- **Motion:** Gentle downward drift with wide sway
- **Speed:** 3-8 px/s
- **Gravity:** 2
- **Rotation:** 1 rad/s
- **Rate:** 3/s, maxAlive: 20, lifetime: 5-9s
- **Fade:** fadeIn 0.5s, fadeOut 1.5s
- **Alpha:** 0.45

#### 13. `night_fireflies` (reworked)
- **Shape:** circle (Kenney soft glow)
- **Colors:** `[0xfde047, 0xa3e635]` (yellow-green)
- **Scale:** 0.015-0.03
- **Trigger:** time=night
- **Spread:** 350
- **Motion:** Very slow random drift (direction: [-π, π])
- **Speed:** 2-5 px/s
- **Gravity:** 0
- **Rotation:** 0
- **Rate:** 3/s, maxAlive: 25, lifetime: 3-7s
- **Fade:** fadeIn 1.0s, fadeOut 1.5s (slow pulse appearance)
- **Alpha:** 0.5

#### 14. `dawn_motes` (reworked)
- **Shape:** circle (Kenney soft glow)
- **Colors:** `[0xfde68a, 0xfbbf24, 0xfda4af]` (warm golden-pink)
- **Scale:** 0.01-0.025
- **Trigger:** time=dawn
- **Spread:** 300
- **Motion:** Gentle upward
- **Speed:** 2-4 px/s
- **Gravity:** -1
- **Rotation:** 0
- **Rate:** 4/s, maxAlive: 20, lifetime: 3-6s
- **Fade:** fadeIn 0.8s, fadeOut 1.0s
- **Alpha:** 0.35

---

## Engine Changes

### 1. Pool Size: 500 → 1000
In `ParticlePool.ts`, change `DEFAULT_MAX_PARTICLES` from 500 to 1000. Also update `GameCanvas.tsx` where the `ParticleEngine` constructor is called with a hardcoded `500` argument — change it to `1000` (or remove the argument to use the default).

### 2. Layer Ordering Fix
In `GameCanvas.tsx`, move particle container BEFORE the bubble system container so particles render below speech/thought bubbles:
```
Order: tilemap → buildings → sprites → particles → bubbles → UI
```

### 3. Burst Spawn Support
The `ParticleProfile` type already has a `burst` field. The engine already handles it in `spawnParticle`. Just set burst > 0 in profiles that need it.

### 4. Acquire Optimization
`ParticlePool.acquire()` currently does O(N) scan. Add a free-list index:
```typescript
private freeHead = 0;
acquire(): number {
  for (let i = this.freeHead; i < this.capacity; i++) {
    if (!this.particles[i].alive) {
      this.freeHead = i + 1;
      return i;
    }
  }
  // Wrap around
  for (let i = 0; i < this.freeHead; i++) {
    if (!this.particles[i].alive) {
      this.freeHead = i + 1;
      return i;
    }
  }
  return -1;
}
```
In `kill(index)`, set `this.freeHead = Math.min(this.freeHead, index)` so the freed slot becomes the new starting point without losing scan progress.

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/components/canvas/particles/profileRegistry.ts` | **Rewrite** — all 14 profiles with new values |
| `src/components/canvas/particles/ParticlePool.ts` | Pool size 500 → 1000, acquire optimization |
| `src/components/canvas/GameCanvas.tsx` | Reorder particle container before bubbles |
| `src/components/canvas/particles/types.ts` | No changes needed — `appearance.alpha` already exists |

No new files. No architecture changes. Pure data + tuning rework.
