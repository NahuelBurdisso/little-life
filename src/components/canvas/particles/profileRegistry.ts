import type { ParticleProfile } from './types';

/**
 * Data-driven particle effect registry.
 * Adding a new visual effect = adding an entry here. No code changes needed.
 *
 * Trigger types:
 *   agent_state  — fires while agent has this state active
 *   agent_action — fires while agent is performing this action
 *   weather      — fires for the current weather
 *   time         — fires for the current day phase (dawn, morning, afternoon, evening, night)
 *   season       — fires for the current season
 */
export const PARTICLE_PROFILES: ParticleProfile[] = [
  // ── Agent States ──────────────────────────────────────────────────────────

  {
    id: 'sparkle',
    trigger: { type: 'agent_state', state: 'drunk' },
    appearance: {
      shape: 'circle',
      colors: [0xe8d5a3, 0xc4a35a],
      sizeRange: [0.05, 0.10],
      alpha: 0.6,
    },
    motion: {
      speedRange: [8, 18],
      directionRange: [-Math.PI * 0.8, -Math.PI * 0.2],
      gravity: -3,
      spread: 8,
      rotationSpeed: 1.5,
    },
    emission: { rate: 2, burst: 3, maxAlive: 8 },
    lifecycle: { lifetimeRange: [1.5, 3], fadeIn: 0.3, fadeOut: 0.5 },
    offset: { x: 0, y: -10 },
  },

  {
    id: 'conflict',
    trigger: { type: 'agent_state', state: 'angry' },
    appearance: {
      shape: 'spark',
      colors: [0xa03028, 0xc84828],
      sizeRange: [0.04, 0.08],
      alpha: 0.7,
    },
    motion: {
      speedRange: [20, 45],
      directionRange: [-Math.PI, Math.PI],
      gravity: 0,
      spread: 6,
      rotationSpeed: 4,
    },
    emission: { rate: 4, burst: 8, maxAlive: 14 },
    lifecycle: { lifetimeRange: [0.4, 1.0], fadeIn: 0, fadeOut: 0.3 },
    offset: { x: 0, y: -8 },
  },

  // ── Locations ─────────────────────────────────────────────────────────────

  {
    // Chimney smoke — anchors are synthetic 'chimney' locations built in
    // GameCanvas from building positions, phase-gated per building type.
    id: 'chimney_smoke',
    trigger: { type: 'location_type', locType: 'chimney' },
    appearance: {
      shape: 'square', // maps to Kenney large soft glow — reads as puff, not ring
      colors: [0x8a8a88, 0x6f6f6d, 0x9a9a96],
      sizeRange: [0.03, 0.07],
      alpha: 0.3,
    },
    motion: {
      speedRange: [5, 11],
      directionRange: [-Math.PI * 0.62, -Math.PI * 0.38], // upward with slight drift
      gravity: -4, // accelerate up as smoke warms/thins
      spread: 2,
      rotationSpeed: 0.3,
    },
    emission: { rate: 1.4, burst: 0, maxAlive: 6 },
    lifecycle: { lifetimeRange: [2.5, 4.5], fadeIn: 0.4, fadeOut: 1.2 },
    offset: { x: 0, y: -2 },
  },

  // ── Season ────────────────────────────────────────────────────────────────

  {
    id: 'weather_snow',
    trigger: { type: 'season', season: 'winter' },
    appearance: {
      shape: 'circle',
      colors: [0xc8d0d8],
      sizeRange: [0.03, 0.06],
      alpha: 0.6,
    },
    motion: {
      speedRange: [5, 15],
      directionRange: [Math.PI * 0.35, Math.PI * 0.65],
      gravity: 8,
      spread: 400,
      rotationSpeed: 1,
    },
    emission: { rate: 8, burst: 0, maxAlive: 80 },
    lifecycle: { lifetimeRange: [4, 8], fadeIn: 0.5, fadeOut: 1 },
    offset: { x: 0, y: -200 },
  },

  {
    id: 'autumn_leaves',
    trigger: { type: 'season', season: 'autumn' },
    appearance: {
      shape: 'leaf',
      colors: [0x4a5028, 0x6a5828],
      sizeRange: [0.04, 0.08],
      alpha: 0.5,
    },
    motion: {
      speedRange: [8, 20],
      directionRange: [Math.PI * 0.2, Math.PI * 0.8],
      gravity: 6,
      spread: 350,
      rotationSpeed: 2,
    },
    emission: { rate: 5, burst: 0, maxAlive: 50 },
    lifecycle: { lifetimeRange: [4, 7], fadeIn: 0.3, fadeOut: 1 },
    offset: { x: 0, y: -180 },
  },

  {
    id: 'weather_rain',
    // `WeatherType` spells it "rainy" — "rain" never matched the trigger index,
    // so this profile had never spawned a particle.
    trigger: { type: 'weather', weather: 'rainy' },
    appearance: {
      shape: 'raindrop',
      colors: [0x1a2830, 0x1e3040],
      sizeRange: [0.03, 0.06],
      alpha: 0.5,
    },
    motion: {
      speedRange: [30, 60],
      directionRange: [Math.PI * 0.45, Math.PI * 0.55],
      gravity: 20,
      spread: 400,
      rotationSpeed: 0,
    },
    emission: { rate: 12, burst: 0, maxAlive: 100 },
    lifecycle: { lifetimeRange: [0.6, 1.2], fadeIn: 0, fadeOut: 0.2 },
    offset: { x: 0, y: -200 },
  },
];
