import * as PIXI from 'pixi.js';
import type { Particle } from './types';

const DEFAULT_MAX_PARTICLES = 1000;

/**
 * Fixed-size object pool for particles.
 * Pre-allocates all PIXI.Sprites at construction — zero allocations during gameplay.
 * Each particle is a lightweight Sprite reusing pre-rendered shape textures.
 */
export class ParticlePool {
  private particles: Particle[];
  private sprites: PIXI.Sprite[];
  readonly container: PIXI.Container;
  private readonly maxParticles: number;
  private freeHead = 0;

  constructor(maxParticles = DEFAULT_MAX_PARTICLES) {
    this.maxParticles = maxParticles;
    this.container = new PIXI.Container();
    this.container.eventMode = 'none';

    // Pre-allocate all particles and sprites
    this.particles = new Array(maxParticles);
    this.sprites = new Array(maxParticles);

    for (let i = 0; i < maxParticles; i++) {
      const sprite = new PIXI.Sprite();
      sprite.anchor.set(0.5);
      sprite.visible = false;
      sprite.blendMode = 'add';
      this.container.addChild(sprite);
      this.sprites[i] = sprite;

      this.particles[i] = {
        alive: false,
        emitterKey: '',
        x: 0, y: 0,
        vx: 0, vy: 0,
        gravity: 0,
        life: 0, maxLife: 0,
        alpha: 0, targetAlpha: 1,
        scale: 1,
        rotation: 0, rotationSpeed: 0,
        fadeIn: 0, fadeOut: 0,
      };
    }
  }

  /**
   * Acquire a dead particle from the pool.
   * Returns the index, or -1 if pool is exhausted.
   */
  acquire(): number {
    for (let i = this.freeHead; i < this.maxParticles; i++) {
      if (!this.particles[i].alive) {
        this.freeHead = i + 1;
        return i;
      }
    }
    for (let i = 0; i < this.freeHead; i++) {
      if (!this.particles[i].alive) {
        this.freeHead = i + 1;
        return i;
      }
    }
    return -1; // pool exhausted
  }

  /** Get particle data by index. */
  get(index: number): Particle {
    return this.particles[index];
  }

  /** Get sprite by index. */
  getSprite(index: number): PIXI.Sprite {
    return this.sprites[index];
  }

  /** Activate a particle with initial values. */
  activate(
    index: number,
    emitterKey: string,
    x: number, y: number,
    vx: number, vy: number,
    gravity: number,
    life: number,
    alpha: number,
    scale: number,
    rotationSpeed: number,
    fadeIn: number,
    fadeOut: number,
    texture: PIXI.Texture,
    tint: number,
  ): void {
    const p = this.particles[index];
    p.alive = true;
    p.emitterKey = emitterKey;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.gravity = gravity;
    p.life = life;
    p.maxLife = life;
    p.alpha = fadeIn > 0 ? 0 : alpha;
    p.targetAlpha = alpha;
    p.scale = scale;
    p.rotation = Math.random() * Math.PI * 2;
    p.rotationSpeed = rotationSpeed;
    p.fadeIn = fadeIn;
    p.fadeOut = fadeOut;

    const s = this.sprites[index];
    s.texture = texture;
    s.tint = tint;
    s.visible = true;
    s.x = x;
    s.y = y;
    s.alpha = p.alpha;
    s.scale.set(scale);
    s.rotation = p.rotation;
  }

  /** Kill a particle, returning it to the pool. */
  kill(index: number): void {
    this.particles[index].alive = false;
    this.sprites[index].visible = false;
    this.freeHead = Math.min(this.freeHead, index);
  }

  /**
   * Update all alive particles. Single flat loop — O(N) where N = maxParticles.
   * @param dt Delta time in seconds.
   * @param aliveCounts Map refilled with emitterKey → alive count (for emitter tracking). Callers
   *   pass one they keep between frames, so this hot path never allocates it.
   * @returns `aliveCounts`.
   */
  updateAll(dt: number, aliveCounts: Map<string, number> = new Map()): Map<string, number> {
    aliveCounts.clear();

    for (let i = 0; i < this.maxParticles; i++) {
      const p = this.particles[i];
      if (!p.alive) continue;

      // Physics
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.rotation += p.rotationSpeed * dt;
      p.life -= dt;

      // Lifecycle
      if (p.life <= 0) {
        this.kill(i);
        continue;
      }

      // Fade in
      const age = p.maxLife - p.life;
      if (p.fadeIn > 0 && age < p.fadeIn) {
        p.alpha = p.targetAlpha * (age / p.fadeIn);
      }
      // Fade out
      else if (p.fadeOut > 0 && p.life < p.fadeOut) {
        p.alpha = p.targetAlpha * (p.life / p.fadeOut);
      }
      else {
        p.alpha = p.targetAlpha;
      }

      // Sync to sprite
      const s = this.sprites[i];
      s.x = p.x;
      s.y = p.y;
      s.alpha = p.alpha;
      s.rotation = p.rotation;

      // Track alive count per emitter
      const count = aliveCounts.get(p.emitterKey) ?? 0;
      aliveCounts.set(p.emitterKey, count + 1);
    }

    return aliveCounts;
  }

  /** Kill all particles. */
  killAll(): void {
    for (let i = 0; i < this.maxParticles; i++) {
      if (this.particles[i].alive) this.kill(i);
    }
  }

  /** Number of currently alive particles. */
  get aliveCount(): number {
    let count = 0;
    for (let i = 0; i < this.maxParticles; i++) {
      if (this.particles[i].alive) count++;
    }
    return count;
  }

  destroy(): void {
    this.killAll();
    this.container.destroy({ children: true });
  }
}
