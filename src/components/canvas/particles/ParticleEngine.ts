import * as PIXI from 'pixi.js';
import type { ParticleProfile, ParticleContext, ActiveEmitter, ParticleTrigger, ParticleShape } from './types';
import { ParticlePool } from './ParticlePool';
import { createShapeTextures } from './ShapeTextures';
import { PARTICLE_PROFILES } from './profileRegistry';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function randomRange(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function randomPick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function emitterKey(anchorType: string, anchorId: string, profileId: string): string {
  return `${anchorType}-${anchorId}-${profileId}`;
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
  private initialized = false;

  // Index: trigger type → profiles that match
  private triggerIndex: Map<string, ParticleProfile[]> = new Map();

  constructor(parentContainer: PIXI.Container, maxParticles = 500) {
    this.pool = new ParticlePool(maxParticles);
    parentContainer.addChild(this.pool.container);

    // Build profile map and trigger index
    for (const profile of PARTICLE_PROFILES) {
      this.profiles.set(profile.id, profile);
      const key = this.triggerKey(profile.trigger);
      const list = this.triggerIndex.get(key) ?? [];
      list.push(profile);
      this.triggerIndex.set(key, list);
    }
  }

  /** Call once after PixiJS renderer is ready to load/render shape textures. */
  async initTextures(renderer: PIXI.Renderer): Promise<void> {
    if (this.initialized) return;
    this.textures = await createShapeTextures(renderer);
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
    const desiredEmitters = new Set<string>();
    this.matchContext(context, desiredEmitters, cameraX, cameraY);

    // 2. Remove emitters that are no longer desired
    for (const [key] of this.emitters) {
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

        this.emitters.set(key, {
          key,
          profileId: profile.id,
          anchorType: parts[0] as 'agent' | 'location' | 'world',
          anchorId: parts.slice(1, -1).join('-'), // middle segments
          spawnAccumulator: 0,
          aliveCount: 0,
          burstDone: false,
        });
      }
    }

    // 4. Update pool (physics + lifecycle) — returns alive counts per emitter
    const aliveCounts = this.pool.updateAll(dt);

    // 5. Spawn new particles from active emitters
    for (const [key, emt] of this.emitters) {
      const profile = this.profiles.get(emt.profileId);
      if (!profile) continue;

      // Update alive count from pool
      emt.aliveCount = aliveCounts.get(key) ?? 0;

      // Resolve anchor position
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
    const key = this.triggerKey(profile.trigger);
    const list = this.triggerIndex.get(key) ?? [];
    list.push(profile);
    this.triggerIndex.set(key, list);
  }

  destroy(): void {
    this.pool.destroy();
    this.emitters.clear();
    // RenderTextures
    for (const tex of this.textures.values()) tex.destroy(true);
    this.textures.clear();
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private triggerKey(trigger: ParticleTrigger): string {
    return `${trigger.type}:${(trigger as any).state ?? (trigger as any).action ?? (trigger as any).weather ?? (trigger as any).phase ?? (trigger as any).season ?? (trigger as any).locType ?? (trigger as any).event}`;
  }

  private matchContext(
    ctx: ParticleContext,
    desiredEmitters: Set<string>,
    _cameraX: number,
    _cameraY: number,
  ): void {
    // Agent-based triggers
    for (const agent of ctx.agents) {
      // Agent states
      for (const state of agent.states) {
        const profiles = this.triggerIndex.get(`agent_state:${state}`);
        if (profiles) {
          for (const p of profiles) {
            desiredEmitters.add(emitterKey('agent', agent.id, p.id));
          }
        }
      }

      // Agent action
      const actionProfiles = this.triggerIndex.get(`agent_action:${agent.action}`);
      if (actionProfiles) {
        for (const p of actionProfiles) {
          desiredEmitters.add(emitterKey('agent', agent.id, p.id));
        }
      }
    }

    // Weather triggers
    const weatherProfiles = this.triggerIndex.get(`weather:${ctx.weather}`);
    if (weatherProfiles) {
      for (const p of weatherProfiles) {
        desiredEmitters.add(emitterKey('world', 'weather', p.id));
      }
    }

    // Time-of-day triggers
    const timeProfiles = this.triggerIndex.get(`time:${ctx.dayPhase}`);
    if (timeProfiles) {
      for (const p of timeProfiles) {
        desiredEmitters.add(emitterKey('world', 'time', p.id));
      }
    }

    // Season triggers
    const seasonProfiles = this.triggerIndex.get(`season:${ctx.season}`);
    if (seasonProfiles) {
      for (const p of seasonProfiles) {
        desiredEmitters.add(emitterKey('world', 'season', p.id));
      }
    }

    // Location-type triggers
    for (const loc of ctx.locations) {
      const locProfiles = this.triggerIndex.get(`location_type:${loc.type}`);
      if (locProfiles) {
        for (const p of locProfiles) {
          desiredEmitters.add(emitterKey('location', String(loc.id), p.id));
        }
      }
    }
  }

  private resolveAnchor(
    emt: ActiveEmitter,
    ctx: ParticleContext,
    cameraX: number,
    cameraY: number,
  ): { x: number; y: number } | null {
    const profile = this.profiles.get(emt.profileId);
    if (!profile) return null;

    if (emt.anchorType === 'agent') {
      const agent = ctx.agents.find(a => a.id === emt.anchorId);
      if (!agent) return null;
      return { x: agent.x + profile.offset.x, y: agent.y + profile.offset.y };
    }

    if (emt.anchorType === 'location') {
      const loc = ctx.locations.find(l => String(l.id) === emt.anchorId);
      if (!loc) return null;
      return { x: loc.x + profile.offset.x, y: loc.y + profile.offset.y };
    }

    if (emt.anchorType === 'world') {
      // World emitters anchor to camera center
      return { x: cameraX + profile.offset.x, y: cameraY + profile.offset.y };
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
