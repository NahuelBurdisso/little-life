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
 *   stressed/envious -> fidget
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
      else if (t === 'stressed' || t === 'envious') stressed = true; // envy chafes: the same restless shifting
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

// ── Activity body language ────────────────────────────────────────────────────────────────
// What the agent is *doing* rather than feeling: a jogger paces on the spot, a pickpocket
// crouches and glances round. Layered on top of the state pose by AgentSprite, so a drunk
// jogger sways *and* jogs. Same shape as the state poses (pure, caller-owned output).

export type ActivityPoseKind =
  | 'none' | 'jog' | 'crouch' | 'shifty' | 'look' | 'nibble' | 'clap' | 'orate' | 'lean';

export const ACTIVITY_POSE_KINDS: readonly ActivityPoseKind[] = [
  'none', 'jog', 'crouch', 'shifty', 'look', 'nibble', 'clap', 'orate', 'lean',
];

export interface ActivityOffsets extends PoseOffsets {
  /**
   * 0 = leave the facing alone, 1 / -1 = face right / left. Glancing poses flip it every
   * couple of seconds; the caller only applies it once the pose has eased in.
   */
  face: -1 | 0 | 1;
  /** Run the walk-cycle frames while standing on the spot. */
  legs: boolean;
}

export function newActivityOffsets(): ActivityOffsets {
  return { dx: 0, dy: 0, rot: 0, scaleY: 1, breathRate: 1, face: 0, legs: false };
}

const JOG_STEP_HZ = 2.6;      // footfalls per second (the bob is one hop per foot)
const JOG_LAP_HZ = 0.32;      // back-and-forth laps per second
const JOG_LAP_PX = 5;
const JOG_HOP = 1.8;
const JOG_LEAN = 0.09;
const CROUCH_SQUASH = 0.84;
const CROUCH_DROP = 2.5;
const CROUCH_LEAN = 0.14;
const GLANCE_CROUCH_S = 1.4;
const GLANCE_SHIFTY_S = 2.3;
const GLANCE_LOOK_S = 2.8;
const NIBBLE_PERIOD = 2.6;
const NIBBLE_FRACTION = 0.45;
const CLAP_PERIOD = 1.7;
const CLAP_FRACTION = 0.4;
const ORATE_PERIOD = 2.1;
const ORATE_FRACTION = 0.3;
const LEAN_ROT = 0.15;

/** Alternating facing: right for one `period`, left for the next. */
function glance(t: number, period: number): 1 | -1 {
  return Math.floor(t / period) % 2 === 0 ? 1 : -1;
}

export function activityPoseOffsets(kind: ActivityPoseKind, t: number, out: ActivityOffsets): ActivityOffsets {
  out.dx = 0;
  out.dy = 0;
  out.rot = 0;
  out.scaleY = 1;
  out.breathRate = 1;
  out.face = 0;
  out.legs = false;
  switch (kind) {
    case 'jog': {
      // Feet drum on the spot while the body paces a short lap, turning at each end.
      out.legs = true;
      out.dy = -JOG_HOP * Math.abs(Math.sin(Math.PI * JOG_STEP_HZ * t));
      const lap = TAU * JOG_LAP_HZ * t;
      out.dx = JOG_LAP_PX * Math.sin(lap);
      out.face = Math.cos(lap) >= 0 ? 1 : -1;
      out.rot = JOG_LEAN;
      out.breathRate = 3;
      break;
    }
    case 'crouch':
      out.scaleY = CROUCH_SQUASH;
      out.dy = CROUCH_DROP;
      out.rot = CROUCH_LEAN;
      out.face = glance(t, GLANCE_CROUCH_S);
      out.breathRate = 2;
      break;
    case 'shifty':
      out.scaleY = 0.96;
      out.rot = 0.05;
      out.face = glance(t, GLANCE_SHIFTY_S);
      break;
    case 'look':
      // Window shopping: a slow head-turn to the next stall and a little step toward it.
      out.face = glance(t, GLANCE_LOOK_S);
      out.dx = 0.8 * Math.sin((TAU * t) / (GLANCE_LOOK_S * 2));
      break;
    case 'nibble': {
      const p = (t % NIBBLE_PERIOD) / NIBBLE_PERIOD;
      // Two chews per bite.
      if (p < NIBBLE_FRACTION) out.dy = 0.9 * Math.abs(Math.sin((TAU * p) / NIBBLE_FRACTION));
      out.rot = 0.04;
      break;
    }
    case 'clap': {
      const p = (t % CLAP_PERIOD) / CLAP_PERIOD;
      // Three quick claps, then a pause.
      if (p < CLAP_FRACTION) out.dy = -1.3 * Math.abs(Math.sin((3 * Math.PI * p) / CLAP_FRACTION));
      break;
    }
    case 'orate': {
      const p = (t % ORATE_PERIOD) / ORATE_PERIOD;
      if (p < ORATE_FRACTION) {
        const s = Math.sin((Math.PI * p) / ORATE_FRACTION);
        out.dy = -1.4 * s;
        out.rot = 0.12 * s;
      }
      break;
    }
    case 'lean':
      out.rot = LEAN_ROT;
      out.dx = 0.6 * Math.sin(TAU * 0.25 * t);
      break;
    case 'none':
      break;
  }
  return out;
}
