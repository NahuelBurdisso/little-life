// ─── Particle Engine Types ─────────────────────────────────────────────────────
// Data-driven particle system. New visual effects = new profile entries, not code.

/** What triggers this particle effect. */
export type ParticleTrigger =
  | { type: 'agent_state'; state: string }
  | { type: 'agent_action'; action: string }
  | { type: 'weather'; weather: string }
  | { type: 'time'; phase: string }
  | { type: 'season'; season: string }
  | { type: 'location_type'; locType: string }
  | { type: 'social'; event: string };

/** Visual shape of a particle. Pre-rendered as textures at startup. */
export type ParticleShape = 'circle' | 'heart' | 'star' | 'leaf' | 'spark' | 'note' | 'square';

/** Complete definition of a particle effect. Pure data — no logic. */
export interface ParticleProfile {
  id: string;
  trigger: ParticleTrigger;

  appearance: {
    shape: ParticleShape;
    colors: number[];         // random pick per particle
    sizeRange: [number, number]; // min-max scale multiplier
    alpha: number;            // base alpha (0-1)
  };

  motion: {
    speedRange: [number, number]; // pixels per second
    directionRange: [number, number]; // angle in radians (0 = right, PI/2 = down)
    gravity: number;          // pixels/s² downward force
    spread: number;           // spawn radius from anchor (pixels)
    rotationSpeed: number;    // radians per second
  };

  emission: {
    rate: number;             // particles per second (0 = burst-only)
    burst: number;            // one-shot count on emitter creation (0 = none)
    maxAlive: number;         // max concurrent from this emitter
  };

  lifecycle: {
    lifetimeRange: [number, number]; // seconds
    fadeIn: number;           // seconds to fade in (0 = instant)
    fadeOut: number;          // seconds to fade out before death
  };

  offset: { x: number; y: number }; // relative to anchor position
}

/** Runtime state of a single particle (pooled). */
export interface Particle {
  alive: boolean;
  emitterKey: string;       // which emitter owns this particle
  x: number;
  y: number;
  vx: number;
  vy: number;
  gravity: number;
  life: number;             // remaining life in seconds
  maxLife: number;
  alpha: number;
  targetAlpha: number;
  scale: number;
  rotation: number;
  rotationSpeed: number;
  fadeIn: number;
  fadeOut: number;
}

/** Active emitter tracking. */
export interface ActiveEmitter {
  key: string;              // "agent-123-drunk_bubbles"
  profileId: string;
  anchorType: 'agent' | 'location' | 'world';
  anchorId: string;
  spawnAccumulator: number; // fractional particles to spawn
  aliveCount: number;       // currently alive from this emitter
  burstDone: boolean;       // has initial burst fired?
}

/** Simulation state passed to the engine each frame. */
export interface ParticleContext {
  agents: Array<{
    id: string;
    x: number;
    y: number;
    states: string[];
    action: string;
  }>;
  weather: string;
  dayPhase: string;
  season: string;
  locations: Array<{
    id: number;
    type: string;
    x: number;
    y: number;
  }>;
}
