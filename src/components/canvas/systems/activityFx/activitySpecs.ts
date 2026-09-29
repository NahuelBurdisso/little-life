import type { ActivityPoseKind } from '../../statePose';
import type { ActivityId } from './activity';
import type { EmitterSpec } from './emitters';

/**
 * How each activity shows on the agent: body pose, emotes and the particles at its hands and
 * feet. Data only — ActivityFxSystem interprets it. The held item lives in held/heldItem.ts and
 * the emote at the *start* of a zone verb in BubbleSystem's ACTIVITY_EMOTES; this table adds the
 * rest (emotes that repeat, one on leaving, particles).
 *
 * Effects fire for ~13 agents at once, so each stays small and slow: a puff every second or two,
 * never a stream. Cadences are seconds on the agent's own clock.
 */
export interface LoopEmote {
  /** Names from the emote atlas, played in turn. */
  names: readonly string[];
  every: number;
  offset?: number;
}

export interface BobberSpec {
  /** px in front of the feet, mirrored by facing; the float sits on the water there. */
  dx: number;
  dy: number;
  /** A bite every `cycle` seconds pulls it under during [dipFrom, dipTo). */
  cycle: number;
  dipFrom: number;
  dipTo: number;
}

export interface ActivitySpec {
  pose: ActivityPoseKind;
  /** Multiplied into the body colour while it lasts (a thief's dim cloak). */
  tint?: number;
  /** Emote when the activity begins — only for activities BubbleSystem's zone table cannot see. */
  startEmote?: string;
  /** Emote when it ends after a while (the loot, after the theft). */
  endEmote?: string;
  loopEmotes?: readonly LoopEmote[];
  emitters?: readonly EmitterSpec[];
  bobber?: BobberSpec;
}

/** Below this many seconds an activity is a re-decision blip, not worth a farewell emote. */
export const END_EMOTE_MIN_S = 2;

const SHADY = 0x9aa0b8;

export const ACTIVITY_SPECS: Record<ActivityId, ActivitySpec> = {
  none: { pose: 'none' },

  jog: {
    pose: 'jog',
    emitters: [
      // Sweat flicked off backwards; dust scuffed by the feet.
      { sprite: 'sweat', every: 0.9, at: 'hand', x: 0, y: -25, spreadX: 3, vx: -12, velSpreadX: 5, vy: -16, gravity: 70, life: 0.6 },
      { sprite: 'dust', every: 0.34, at: 'ground', x: -3, y: -1, spreadX: 3, vx: -6, vy: -5, life: 0.5, layer: 'ground' },
    ],
  },

  comfort: {
    pose: 'none',
    emitters: [
      { sprite: 'steam', every: 1.4, at: 'hand', x: 8, y: -15, spreadX: 1, vy: -9, life: 1.1 },
    ],
  },

  browse: {
    pose: 'look',
    loopEmotes: [{ names: ['sparkle'], every: 8, offset: 4 }],
  },

  shoplift: { pose: 'crouch', tint: SHADY, endEmote: 'money' },
  pickpocket: { pose: 'shifty', tint: SHADY, endEmote: 'money' },

  eating: {
    pose: 'nibble',
    emitters: [
      { sprite: 'steam', every: 1.5, at: 'hand', x: 2, y: -15, spreadX: 2, vy: -8, life: 1 },
      { sprite: 'crumb', every: 2.2, offset: 0.7, at: 'hand', x: 3, y: -9, vx: 5, velSpreadX: 3, vy: -3, gravity: 45, life: 0.6 },
    ],
  },

  shopping: {
    pose: 'none',
    startEmote: 'money',
    emitters: [
      // A coin flipped up out of the hand while paying.
      { sprite: 'coin', every: 2.4, at: 'hand', x: 7, y: -14, vy: -22, gravity: 75, life: 0.75, anim: 'loop', fps: 10 },
    ],
  },

  mingle: {
    pose: 'none',
    // 'sparkle' becomes a heart between partners (ActivityFxSystem).
    loopEmotes: [{ names: ['laugh', 'music', 'sparkle'], every: 9, offset: 3 }],
  },

  fish: {
    pose: 'none',
    bobber: { dx: 16, dy: 1, cycle: 9, dipFrom: 5.7, dipTo: 6.5 },
    emitters: [
      { sprite: 'ripple', every: 1.7, at: 'bobber', x: 0, y: 0, life: 1.3, layer: 'ground' },
      // The catch: a splash, a fish leaping out of it.
      { sprite: 'splash', every: 9, offset: 6.05, at: 'bobber', x: 0, y: 0, life: 0.6, layer: 'ground' },
      { sprite: 'fish', every: 9, offset: 6.05, at: 'bobber', x: 0, y: -2, vx: 9, velSpreadX: 3, vy: -46, gravity: 120, life: 0.85, anim: 'loop', fps: 6, tilt: true },
    ],
    loopEmotes: [{ names: ['exclaim'], every: 9, offset: 6.3 }],
  },

  garden: {
    pose: 'none',
    emitters: [
      // Drops from the rose of the can, only while it is tipped (held 'sip': first 0.9 s of 9).
      {
        sprite: 'drop', every: 0.085, window: { period: 9, from: 0.12, to: 0.85 },
        at: 'hand', x: 17, y: -7, spreadY: 1, vx: 5, vy: 4, gravity: 130, life: 0.38,
      },
    ],
  },

  forage: {
    pose: 'lean',
    emitters: [{ sprite: 'glint', every: 2.8, at: 'hand', x: 8, y: -7, spreadX: 3, life: 0.5, minDetail: 1 }],
  },
  tend: {
    pose: 'lean',
    emitters: [{ sprite: 'glint', every: 3, at: 'hand', x: 8, y: -7, spreadX: 3, life: 0.5 }],
  },
  feed: {
    pose: 'lean',
    emitters: [{ sprite: 'crumb', every: 0.9, at: 'hand', x: 8, y: -10, vx: 9, velSpreadX: 4, vy: -8, gravity: 60, life: 0.7 }],
  },

  perform: {
    pose: 'none',
    emitters: [
      // Notes drifting up off the lute; each picks one of the three shapes.
      { sprite: 'note', every: 1.1, at: 'hand', x: 6, y: -26, spreadX: 4, vx: 3, velSpreadX: 5, vy: -14, life: 1.6, anim: 'pick' },
    ],
  },

  watch: {
    pose: 'clap',
    emitters: [
      { sprite: 'clap', every: 1.7, at: 'hand', x: 5, y: -15, life: 0.45, minDetail: 1 },
    ],
  },

  speech: {
    pose: 'orate',
    emitters: [
      // Sound rolling out of the megaphone while it is raised (held 'sip': first 0.9 s of 6).
      {
        sprite: 'wave', every: 0.32, window: { period: 6, from: 0.1, to: 0.8 },
        at: 'hand', x: 14, y: -17, vx: 10, life: 0.5, flip: true,
      },
    ],
  },

  protest: {
    pose: 'orate',
    loopEmotes: [{ names: ['anger'], every: 9, offset: 5 }],
  },

  cook: {
    pose: 'none',
    emitters: [
      { sprite: 'steam', every: 0.75, at: 'hand', x: 10, y: -14, spreadX: 3, vy: -10, life: 1 },
    ],
  },

  scheme: {
    pose: 'shifty',
    tint: SHADY,
    loopEmotes: [{ names: ['question'], every: 9, offset: 4 }],
  },

  confide: {
    pose: 'lean',
    loopEmotes: [{ names: ['whisper'], every: 7, offset: 2 }],
  },

  contemplate: { pose: 'none' },

  // ── Work: one small tell per workplace, at the tool ──────────────────────────────────────
  work_bakery: {
    pose: 'none',
    emitters: [{ sprite: 'flour', trigger: 'stroke', at: 'hand', x: 10, y: -8, spreadX: 2, vy: -6, life: 0.7 }],
  },
  work_workshop: {
    pose: 'none',
    emitters: [
      { sprite: 'spark', trigger: 'stroke', count: 2, at: 'hand', x: 10, y: -9, spreadX: 1, vx: 14, velSpreadX: 12, vy: -22, velSpreadY: 8, gravity: 95, life: 0.45 },
    ],
  },
  work_shop: {
    pose: 'none',
    emitters: [{ sprite: 'coin', every: 3.5, at: 'hand', x: 6, y: -12, vy: -16, gravity: 45, life: 0.8, anim: 'loop', fps: 10 }],
  },
  work_pawnshop: {
    pose: 'none',
    emitters: [
      { sprite: 'coin', every: 3.5, at: 'hand', x: 6, y: -12, vy: -16, gravity: 45, life: 0.8, anim: 'loop', fps: 10 },
      { sprite: 'glint', every: 5, offset: 2, at: 'hand', x: 10, y: -13, life: 0.5 },
    ],
  },
  work_town_hall: {
    pose: 'none',
    emitters: [{ sprite: 'ink', trigger: 'stroke', at: 'hand', x: 9, y: -9, spreadX: 1, vy: -4, life: 0.55 }],
  },
  work_clinic: {
    pose: 'none',
    emitters: [{ sprite: 'cross', every: 3.4, at: 'hand', x: 11, y: -20, vy: -7, life: 1.5 }],
  },
  work_tavern: {
    pose: 'none',
    emitters: [{ sprite: 'glint', every: 4.5, at: 'hand', x: 8, y: -13, life: 0.5 }],
  },
  work_farm: {
    pose: 'none',
    emitters: [{ sprite: 'dust', trigger: 'stroke', at: 'ground', x: 12, y: -2, spreadX: 2, vy: -5, life: 0.55, layer: 'ground' }],
  },
};

/** Loop emote for an agent who is drunk, whatever else they are doing. */
export const DRUNK_LOOP: LoopEmote = { names: ['dizzy'], every: 8, offset: 1 };
