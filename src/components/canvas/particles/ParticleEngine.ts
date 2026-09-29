import * as PIXI from 'pixi.js';
import type { ParticleProfile, ParticleContext, ActiveEmitter, ParticleShape } from './types';
import { ParticlePool } from './ParticlePool';
import { createShapeTextures } from './ShapeTextures';
import { PARTICLE_PROFILES } from './profileRegistry';
import { EmitterKeyCache, ProfileIndex } from './emitterLookup';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}


// ─── Engine ───────────────────────────────────────────────────────────────────

/**
 * Data-driven particle engine.
 *
 * Call `update(dt, context)` every frame with the current simulation state.
 * The engine diffs state against registered profiles, creates/destroys emitters,
 * spawns particles, and updates the pool.
 *
 * New visual effects = new entries in profileRegistry.ts. Zero code changes.
 */
export class ParticleEngine {
  private pool: ParticlePool;
  private emitters: Map<string, ActiveEmitter> = new Map();
  private profiles: Map<string, ParticleProfile> = new Map();
  private textures: Map<ParticleShape, PIXI.Texture> = new Map();
  /** Subset of `textures` this engine created and must free. The rest are owned
   *  by the global `Assets` cache. */
  private ownedTextures: PIXI.Texture[] = [];
  private initialized = false;
  private destroyed = false;

  // Index: trigger type + value → profiles that match
  private triggerIndex = new ProfileIndex();

  // Per-frame scratch, kept between frames so `update` allocates nothing in steady state.
  private readonly desiredEmitters = new Set<string>();
  private readonly aliveCounts = new Map<string, number>();
  private readonly anchor = { x: 0, y: 0 };
  private readonly agentKeys = new EmitterKeyCache('agent');
  private readonly locationKeys = new EmitterKeyCache('location');
  private readonly worldKeys = new EmitterKeyCache('world');

  constructor(parentContainer: PIXI.Container, maxParticles = 500) {
    this.pool = new ParticlePool(maxParticles);
    parentContainer.addChild(this.pool.container);

    // Build profile map and trigger index
    for (const profile of PARTICLE_PROFILES) {
      this.profiles.set(profile.id, profile);
      this.triggerIndex.add(profile);
    }
  }

  /** Call once after PixiJS renderer is ready to load/render shape textures. */
  async initTextures(renderer: PIXI.Renderer): Promise<void> {
    if (this.initialized || this.destroyed) return;
    const { textures, owned } = await createShapeTextures(renderer);
    // The canvas can unmount while the Kenney PNGs are still loading. Without
    // this the RenderTextures created above would be attached to a destroyed
    // engine and leaked for the lifetime of the tab.
    if (this.destroyed) {
      for (const tex of owned) tex.destroy(true);
      return;
    }
    this.textures = textures;
    this.ownedTextures = owned;
    this.initialized = true;
    console.log(`[ParticleEngine] Loaded ${this.textures.size} shape textures`);
  }

  /**
   * Main per-frame update. Call from the game ticker.
   * @param dt Delta time in seconds.
   * @param context Current simulation state.
   * @param cameraX Camera world offset X (for world-space emitters).
   * @param cameraY Camera world offset Y.
   */
  update(dt: number, context: ParticleContext, cameraX = 0, cameraY = 0): void {
    if (!this.initialized) return;

    // 1. Determine which emitters SHOULD be active based on current context
    const desiredEmitters = this.desiredEmitters;
    desiredEmitters.clear();
    this.matchContext(context, desiredEmitters);

    // 2. Remove emitters that are no longer desired
    for (const key of this.emitters.keys()) {
      if (!desiredEmitters.has(key)) {
        this.emitters.delete(key);
        // Particles from this emitter will die naturally (lifecycle)
      }
    }

    // 3. Create new emitters for newly-matched triggers
    for (const key of desiredEmitters) {
      if (!this.emitters.has(key)) {
        const parts = key.split('-');
        const profileId = parts[parts.length - 1]; // last segment
        // Reconstruct profileId — may contain hyphens, so find the profile
        const profile = this.profiles.get(profileId);
        if (!profile) continue;

        const anchorId = parts.slice(1, -1).join('-'); // middle segments
        this.emitters.set(key, {
          key,
          profileId: profile.id,
          anchorType: parts[0] as 'agent' | 'location' | 'world',
          anchorId,
          anchorNum: Number(anchorId),
          spawnAccumulator: 0,
          aliveCount: 0,
          burstDone: false,
        });
      }
    }

    // 4. Update pool (physics + lifecycle) — returns alive counts per emitter
    const aliveCounts = this.pool.updateAll(dt, this.aliveCounts);

    // 5. Spawn new particles from active emitters
    for (const emt of this.emitters.values()) {
      const key = emt.key;
      const profile = this.profiles.get(emt.profileId);
      if (!profile) continue;

      // Update alive count from pool
      emt.aliveCount = aliveCounts.get(key) ?? 0;

      // Resolve anchor position (into the shared scratch point)
      const anchor = this.resolveAnchor(emt, context, cameraX, cameraY);
      if (!anchor) continue;

      // Burst on first frame
      if (!emt.burstDone && profile.emission.burst > 0) {
        emt.burstDone = true;
        const count = Math.min(profile.emission.burst, profile.emission.maxAlive - emt.aliveCount);
        for (let i = 0; i < count; i++) {
          this.spawnParticle(key, profile, anchor.x, anchor.y);
        }
      }

      // Continuous emission
      if (profile.emission.rate > 0) {
        emt.spawnAccumulator += profile.emission.rate * dt;
        while (emt.spawnAccumulator >= 1 && emt.aliveCount < profile.emission.maxAlive) {
          emt.spawnAccumulator -= 1;
          this.spawnParticle(key, profile, anchor.x, anchor.y);
          emt.aliveCount++;
        }
        // Cap accumulator to prevent burst after pause
        if (emt.spawnAccumulator > 3) emt.spawnAccumulator = 0;
      }
    }
  }

  /** Register an additional profile at runtime. */
  addProfile(profile: ParticleProfile): void {
    this.profiles.set(profile.id, profile);
    this.triggerIndex.add(profile);
  }

  destroy(): void {
    this.destroyed = true;
    this.pool.destroy();
    this.emitters.clear();
    this.desiredEmitters.clear();
    this.aliveCounts.clear();
    this.agentKeys.clear();
    this.locationKeys.clear();
    this.worldKeys.clear();
    // Only the RenderTextures we made — the Kenney glows belong to the `Assets`
    // cache and destroying them hands dead textures to the next mount.
    for (const tex of this.ownedTextures) tex.destroy(true);
    this.ownedTextures = [];
    this.textures.clear();
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  /**
   * Fills `desiredEmitters` from the context. Index lookups and emitter keys come from the
   * memoising helpers in `emitterLookup`, so a steady-state frame builds no strings.
   */
  private matchContext(ctx: ParticleContext, desiredEmitters: Set<string>): void {
    // Agent-based triggers
    const agents = ctx.agents;
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      // Agent states
      const states = agent.states;
      for (let s = 0; s < states.length; s++) {
        const profiles = this.triggerIndex.get('agent_state', states[s]);
        if (profiles) {
          for (let k = 0; k < profiles.length; k++) {
            desiredEmitters.add(this.agentKeys.get(agent.id, profiles[k].id));
          }
        }
      }

      // Agent action
      const actionProfiles = this.triggerIndex.get('agent_action', agent.action);
      if (actionProfiles) {
        for (let k = 0; k < actionProfiles.length; k++) {
          desiredEmitters.add(this.agentKeys.get(agent.id, actionProfiles[k].id));
        }
      }
    }

    // Weather triggers
    const weatherProfiles = this.triggerIndex.get('weather', ctx.weather);
    if (weatherProfiles) {
      for (let k = 0; k < weatherProfiles.length; k++) {
        desiredEmitters.add(this.worldKeys.get('weather', weatherProfiles[k].id));
      }
    }

    // Time-of-day triggers
    const timeProfiles = this.triggerIndex.get('time', ctx.dayPhase);
    if (timeProfiles) {
      for (let k = 0; k < timeProfiles.length; k++) {
        desiredEmitters.add(this.worldKeys.get('time', timeProfiles[k].id));
      }
    }

    // Season triggers
    const seasonProfiles = this.triggerIndex.get('season', ctx.season);
    if (seasonProfiles) {
      for (let k = 0; k < seasonProfiles.length; k++) {
        desiredEmitters.add(this.worldKeys.get('season', seasonProfiles[k].id));
      }
    }

    // Location-type triggers
    const locations = ctx.locations;
    for (let i = 0; i < locations.length; i++) {
      const loc = locations[i];
      const locProfiles = this.triggerIndex.get('location_type', loc.type);
      if (locProfiles) {
        for (let k = 0; k < locProfiles.length; k++) {
          desiredEmitters.add(this.locationKeys.get(loc.id, locProfiles[k].id));
        }
      }
    }
  }

  /**
   * Writes the emitter's anchor into the shared `this.anchor` point and returns it, or null when
   * the anchor is gone. The point is reused: callers must read it before the next call.
   */
  private resolveAnchor(
    emt: ActiveEmitter,
    ctx: ParticleContext,
    cameraX: number,
    cameraY: number,
  ): { x: number; y: number } | null {
    const profile = this.profiles.get(emt.profileId);
    if (!profile) return null;
    const anchor = this.anchor;

    if (emt.anchorType === 'agent') {
      const agents = ctx.agents;
      for (let i = 0; i < agents.length; i++) {
        if (agents[i].id !== emt.anchorId) continue;
        anchor.x = agents[i].x + profile.offset.x;
        anchor.y = agents[i].y + profile.offset.y;
        return anchor;
      }
      return null;
    }

    if (emt.anchorType === 'location') {
      const locations = ctx.locations;
      for (let i = 0; i < locations.length; i++) {
        if (locations[i].id !== emt.anchorNum) continue;
        anchor.x = locations[i].x + profile.offset.x;
        anchor.y = locations[i].y + profile.offset.y;
        return anchor;
      }
      return null;
    }

    if (emt.anchorType === 'world') {
      // World emitters anchor to camera center
      anchor.x = cameraX + profile.offset.x;
      anchor.y = cameraY + profile.offset.y;
      return anchor;
    }

    return null;
  }

  private spawnParticle(emtKey: string, profile: ParticleProfile, anchorX: number, anchorY: number): void {
    const idx = this.pool.acquire();
    if (idx === -1) return; // pool exhausted

    const texture = this.textures.get(profile.appearance.shape);
    if (!texture) return;

    // Position with spread
    const angle = Math.random() * Math.PI * 2;
    const dist = Math.random() * profile.motion.spread;
    const x = anchorX + Math.cos(angle) * dist;
    const y = anchorY + Math.sin(angle) * dist;

    // Velocity from direction range
    const dir = randomRange(profile.motion.directionRange[0], profile.motion.directionRange[1]);
    const speed = randomRange(profile.motion.speedRange[0], profile.motion.speedRange[1]);
    const vx = Math.cos(dir) * speed;
    const vy = Math.sin(dir) * speed;

    // Appearance
    const color = randomPick(profile.appearance.colors);
    const scale = randomRange(profile.appearance.sizeRange[0], profile.appearance.sizeRange[1]);
    const life = randomRange(profile.lifecycle.lifetimeRange[0], profile.lifecycle.lifetimeRange[1]);

    this.pool.activate(
      idx,
      emtKey,
      x, y,
      vx, vy,
      profile.motion.gravity,
      life,
      profile.appearance.alpha,
      scale,
      profile.motion.rotationSpeed * (Math.random() > 0.5 ? 1 : -1),
      profile.lifecycle.fadeIn,
      profile.lifecycle.fadeOut,
      texture,
      color,
    );
  }
}
