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
    id: 'drunk_bubbles',
    trigger: { type: 'agent_state', state: 'drunk' },
    appearance: {
      shape: 'circle',
      colors: [0xfbbf24, 0xf59e0b, 0xfcd34d],
      sizeRange: [0.02, 0.05],
      alpha: 0.6,
    },
    motion: {
      speedRange: [5, 12],
      directionRange: [-Math.PI * 0.8, -Math.PI * 0.2], // upward-ish
      gravity: -3, // float up
      spread: 6,
      rotationSpeed: 0,
    },
    emission: { rate: 2, burst: 0, maxAlive: 6 },
    lifecycle: { lifetimeRange: [1.5, 3], fadeIn: 0.3, fadeOut: 0.5 },
    offset: { x: 0, y: -8 },
  },

  {
    id: 'infatuated_hearts',
    trigger: { type: 'agent_state', state: 'infatuated' },
    appearance: {
      shape: 'heart',
      colors: [0xec4899, 0xf472b6, 0xfb7185],
      sizeRange: [0.03, 0.06],
      alpha: 0.7,
    },
    motion: {
      speedRange: [8, 15],
      directionRange: [-Math.PI * 0.8, -Math.PI * 0.2],
      gravity: -5,
      spread: 8,
      rotationSpeed: 0.5,
    },
    emission: { rate: 1.5, burst: 0, maxAlive: 5 },
    lifecycle: { lifetimeRange: [2, 3.5], fadeIn: 0.4, fadeOut: 0.8 },
    offset: { x: 0, y: -10 },
  },

  {
    id: 'angry_sparks',
    trigger: { type: 'agent_state', state: 'angry' },
    appearance: {
      shape: 'spark',
      colors: [0xef4444, 0xf97316, 0xfbbf24],
      sizeRange: [0.02, 0.04],
      alpha: 0.8,
    },
    motion: {
      speedRange: [15, 30],
      directionRange: [-Math.PI, Math.PI], // all directions
      gravity: 0,
      spread: 5,
      rotationSpeed: 3,
    },
    emission: { rate: 3, burst: 0, maxAlive: 8 },
    lifecycle: { lifetimeRange: [0.5, 1.2], fadeIn: 0, fadeOut: 0.3 },
    offset: { x: 0, y: -6 },
  },

  {
    id: 'grieving_tears',
    trigger: { type: 'agent_state', state: 'grieving' },
    appearance: {
      shape: 'raindrop',
      colors: [0x60a5fa, 0x93c5fd, 0x3b82f6],
      sizeRange: [0.02, 0.04],
      alpha: 0.5,
    },
    motion: {
      speedRange: [3, 8],
      directionRange: [Math.PI * 0.3, Math.PI * 0.7], // downward
      gravity: 15,
      spread: 4,
      rotationSpeed: 0,
    },
    emission: { rate: 1, burst: 0, maxAlive: 4 },
    lifecycle: { lifetimeRange: [1, 2], fadeIn: 0.2, fadeOut: 0.3 },
    offset: { x: 0, y: -2 },
  },

  {
    id: 'depressed_cloud',
    trigger: { type: 'agent_state', state: 'depressed' },
    appearance: {
      shape: 'circle',
      colors: [0x6366f1, 0x818cf8, 0x4f46e5],
      sizeRange: [0.03, 0.06],
      alpha: 0.3,
    },
    motion: {
      speedRange: [2, 5],
      directionRange: [-Math.PI, Math.PI],
      gravity: -1,
      spread: 10,
      rotationSpeed: 0,
    },
    emission: { rate: 1, burst: 0, maxAlive: 5 },
    lifecycle: { lifetimeRange: [2, 4], fadeIn: 0.5, fadeOut: 1 },
    offset: { x: 0, y: -12 },
  },

  {
    id: 'confident_sparkle',
    trigger: { type: 'agent_state', state: 'confident' },
    appearance: {
      shape: 'star',
      colors: [0xfbbf24, 0xfde68a, 0xfef3c7],
      sizeRange: [0.02, 0.05],
      alpha: 0.7,
    },
    motion: {
      speedRange: [5, 12],
      directionRange: [-Math.PI, Math.PI],
      gravity: -2,
      spread: 8,
      rotationSpeed: 2,
    },
    emission: { rate: 1.5, burst: 0, maxAlive: 5 },
    lifecycle: { lifetimeRange: [1, 2], fadeIn: 0.2, fadeOut: 0.5 },
    offset: { x: 0, y: -8 },
  },

  {
    id: 'sick_miasma',
    trigger: { type: 'agent_state', state: 'sick' },
    appearance: {
      shape: 'circle',
      colors: [0xa3e635, 0x84cc16, 0x65a30d],
      sizeRange: [0.015, 0.035],
      alpha: 0.35,
    },
    motion: {
      speedRange: [2, 6],
      directionRange: [-Math.PI, Math.PI],
      gravity: -1,
      spread: 7,
      rotationSpeed: 0,
    },
    emission: { rate: 1.5, burst: 0, maxAlive: 5 },
    lifecycle: { lifetimeRange: [1.5, 3], fadeIn: 0.4, fadeOut: 0.6 },
    offset: { x: 0, y: -4 },
  },

  // ── Agent Actions ─────────────────────────────────────────────────────────

  {
    id: 'sleeping_zzz',
    trigger: { type: 'agent_action', action: 'sleeping' },
    appearance: {
      shape: 'circle',
      colors: [0xa78bfa, 0xc4b5fd, 0x8b5cf6],
      sizeRange: [0.015, 0.03],
      alpha: 0.4,
    },
    motion: {
      speedRange: [3, 6],
      directionRange: [-Math.PI * 0.7, -Math.PI * 0.3],
      gravity: -2,
      spread: 4,
      rotationSpeed: 0,
    },
    emission: { rate: 0.8, burst: 0, maxAlive: 3 },
    lifecycle: { lifetimeRange: [2, 3.5], fadeIn: 0.5, fadeOut: 0.8 },
    offset: { x: 4, y: -8 },
  },

  // ── Weather ───────────────────────────────────────────────────────────────

  {
    id: 'weather_snow',
    trigger: { type: 'season', season: 'winter' },
    appearance: {
      shape: 'circle',
      colors: [0xffffff, 0xe2e8f0, 0xf1f5f9],
      sizeRange: [0.015, 0.035],
      alpha: 0.6,
    },
    motion: {
      speedRange: [5, 15],
      directionRange: [Math.PI * 0.35, Math.PI * 0.65],
      gravity: 8,
      spread: 400, // wide spread — covers the viewport
      rotationSpeed: 1,
    },
    emission: { rate: 8, burst: 0, maxAlive: 60 },
    lifecycle: { lifetimeRange: [4, 8], fadeIn: 0.5, fadeOut: 1 },
    offset: { x: 0, y: -200 }, // spawn above viewport
  },

  // ── Time of Day ───────────────────────────────────────────────────────────

  {
    id: 'night_fireflies',
    trigger: { type: 'time', phase: 'night' },
    appearance: {
      shape: 'circle',
      colors: [0xfde68a, 0xfbbf24, 0xa3e635],
      sizeRange: [0.015, 0.03],
      alpha: 0.6,
    },
    motion: {
      speedRange: [3, 8],
      directionRange: [-Math.PI, Math.PI],
      gravity: -1,
      spread: 300,
      rotationSpeed: 0,
    },
    emission: { rate: 3, burst: 0, maxAlive: 25 },
    lifecycle: { lifetimeRange: [3, 6], fadeIn: 1, fadeOut: 1.5 },
    offset: { x: 0, y: 0 },
  },

  {
    id: 'dawn_motes',
    trigger: { type: 'time', phase: 'dawn' },
    appearance: {
      shape: 'circle',
      colors: [0xfbbf24, 0xfca5a5, 0xfde68a],
      sizeRange: [0.015, 0.035],
      alpha: 0.35,
    },
    motion: {
      speedRange: [2, 5],
      directionRange: [-Math.PI * 0.8, -Math.PI * 0.2],
      gravity: -1,
      spread: 250,
      rotationSpeed: 0,
    },
    emission: { rate: 4, burst: 0, maxAlive: 20 },
    lifecycle: { lifetimeRange: [3, 5], fadeIn: 1, fadeOut: 1 },
    offset: { x: 0, y: 0 },
  },
];
