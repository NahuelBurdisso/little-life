/**
 * Body language for an agent's active states, on top of the state ring under the feet.
 * Pure — no PixiJS — so the mapping and the motion curves can be unit tested; AgentSprite
 * just adds `poseOffsets` to the transforms it already applies to the rig.
 */

export type PoseKind = 'none' | 'sway' | 'shiver' | 'slump' | 'stomp' | 'bounce' | 'fidget' | 'hunch';

export const POSE_KINDS: readonly PoseKind[] = [
  'none', 'sway', 'shiver', 'slump', 'stomp', 'bounce', 'fidget', 'hunch',
];

/** Multiplying this into the mood tint gives the sickly green of `shiver`. */
export const SHIVER_TINT = 0xd8f0c8;
const NO_TINT = 0xffffff;

export interface StatePose {
  kind: PoseKind;
  /** Multiplied into the sprite's mood tint; 0xffffff leaves it alone. */
  tint: number;
}

/** One shared descriptor per kind: `statePoseFor` runs per agent on every data refresh. */
const POSES: Record<PoseKind, StatePose> = {
  none: { kind: 'none', tint: NO_TINT },
  sway: { kind: 'sway', tint: NO_TINT },
  shiver: { kind: 'shiver', tint: SHIVER_TINT },
  slump: { kind: 'slump', tint: NO_TINT },
  stomp: { kind: 'stomp', tint: NO_TINT },
  bounce: { kind: 'bounce', tint: NO_TINT },
  fidget: { kind: 'fidget', tint: NO_TINT },
  hunch: { kind: 'hunch', tint: NO_TINT },
};

const SLUMP_MOOD_BELOW = 20;
const BOUNCE_MOOD_ABOVE = 85;

const SAD_STATES = new Set(['heartbroken', 'depressed', 'grieving']);
const SICK_STATES = new Set(['sick', 'hungover']);

interface PoseInput {
  activeStates?: Array<{ type: string }>;
  needs?: { mood?: number } | null;
}

/**
 * Which pose an agent's states and mood call for. Priority, highest first:
 *
 *   arrested   -> hunch   (a hard situation trumps every mood)
 *   drunk      -> sway    (a physical impairment: it shows even in a temper, and it is the one
 *                          pose that also plays while walking)
 *   sick/hungover -> shiver
 *   angry      -> stomp
 *   heartbroken/depressed/grieving or mood < 20 -> slump
 *   stressed   -> fidget
 *   euphoric or mood > 85 -> bounce (the weakest: any trouble outranks good cheer)
 *
 * Anything else stands normally. Independent of the order the states are listed in.
 */
export function statePoseFor(agent: PoseInput): StatePose {
  const states = agent.activeStates;
  let arrested = false, drunk = false, sick = false, angry = false;
  let sad = false, stressed = false, happy = false;
  if (states) {
    for (const s of states) {
      const t = s.type;
      if (t === 'arrested') arrested = true;
      else if (t === 'drunk') drunk = true;
      else if (SICK_STATES.has(t)) sick = true;
      else if (t === 'angry') angry = true;
      else if (SAD_STATES.has(t)) sad = true;
      else if (t === 'stressed') stressed = true;
      else if (t === 'euphoric') happy = true;
    }
  }
  const mood = agent.needs?.mood;
  if (mood != null) {
    if (mood < SLUMP_MOOD_BELOW) sad = true;
    else if (mood > BOUNCE_MOOD_ABOVE) happy = true;
  }
  if (arrested) return POSES.hunch;
  if (drunk) return POSES.sway;
  if (sick) return POSES.shiver;
  if (angry) return POSES.stomp;
  if (sad) return POSES.slump;
  if (stressed) return POSES.fidget;
  if (happy) return POSES.bounce;
  return POSES.none;
}

/** What a pose adds to the rig transform. `dx` is world-space (not mirrored with facing). */
export interface PoseOffsets {
  dx: number;
  dy: number;
  /** Radians, positive = forward toward the facing direction (the caller applies `facing`). */
  rot: number;
  /** Multiplies the rig's scale.y. */
  scaleY: number;
  /** Multiplies the idle-breathing rate (0 = holds still). */
  breathRate: number;
}

export function newPoseOffsets(): PoseOffsets {
  return { dx: 0, dy: 0, rot: 0, scaleY: 1, breathRate: 1 };
}

const TAU = Math.PI * 2;

const SWAY_HZ = 0.4;
const SWAY_LEAN = 0.12;
const SWAY_DRIFT = 1.5;
const SHIVER_HZ = 12;
const SHIVER_AMP = 0.5;
const SLUMP_LEAN = 0.08;
const SLUMP_SQUASH = 0.94;
const SLUMP_BREATH = 0.6;
const HUNCH_LEAN = 0.1;
const HUNCH_SQUASH = 0.92;
const STOMP_PERIOD = 1.2;
const STOMP_HOP = 1;
const STOMP_HOP_FRACTION = 0.25;   // of the period spent in the air
const STOMP_SHAKE_FRACTION = 0.15; // of the period spent shaking after the landing
const STOMP_SHAKE = 0.4;
const BOUNCE_PERIOD = 2;
const BOUNCE_HOP = 1.6;
const BOUNCE_HOP_FRACTION = 0.3;
const FIDGET_PERIOD = 0.8;
const FIDGET_AMP = 0.5;
const FIDGET_FRACTION = 0.15;

/**
 * Fill `out` with the offsets `kind` contributes `t` seconds into its clock. Writes into a
 * caller-owned object because AgentSprite calls this for every agent on every frame.
 */
export function poseOffsets(kind: PoseKind, t: number, out: PoseOffsets): PoseOffsets {
  out.dx = 0;
  out.dy = 0;
  out.rot = 0;
  out.scaleY = 1;
  out.breathRate = 1;
  switch (kind) {
    case 'sway': {
      const a = TAU * SWAY_HZ * t;
      out.rot = SWAY_LEAN * Math.sin(a);
      out.dx = SWAY_DRIFT * Math.cos(a);
      break;
    }
    case 'shiver':
      out.dx = SHIVER_AMP * Math.sin(TAU * SHIVER_HZ * t);
      break;
    case 'slump':
      out.rot = SLUMP_LEAN;
      out.scaleY = SLUMP_SQUASH;
      out.breathRate = SLUMP_BREATH;
      break;
    case 'hunch':
      out.rot = HUNCH_LEAN;
      out.scaleY = HUNCH_SQUASH;
      out.breathRate = 0;
      break;
    case 'stomp': {
      const p = (t % STOMP_PERIOD) / STOMP_PERIOD;
      if (p < STOMP_HOP_FRACTION) {
        out.dy = -STOMP_HOP * Math.sin(Math.PI * (p / STOMP_HOP_FRACTION));
      } else if (p < STOMP_HOP_FRACTION + STOMP_SHAKE_FRACTION) {
        // Landing shake: a damped wobble.
        const q = (p - STOMP_HOP_FRACTION) / STOMP_SHAKE_FRACTION;
        out.dx = STOMP_SHAKE * (1 - q) * Math.sin(q * 3 * Math.PI + 0.5);
      }
      break;
    }
    case 'bounce': {
      const p = (t % BOUNCE_PERIOD) / BOUNCE_PERIOD;
      if (p < BOUNCE_HOP_FRACTION) out.dy = -BOUNCE_HOP * Math.sin(Math.PI * (p / BOUNCE_HOP_FRACTION));
      break;
    }
    case 'fidget': {
      const cycle = Math.floor(t / FIDGET_PERIOD);
      const p = (t % FIDGET_PERIOD) / FIDGET_PERIOD;
      if (p < FIDGET_FRACTION) {
        out.dx = FIDGET_AMP * Math.sin(Math.PI * (p / FIDGET_FRACTION)) * (cycle % 2 === 0 ? 1 : -1);
      }
      break;
    }
    case 'none':
      break;
  }
  return out;
}
