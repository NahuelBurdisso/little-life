/**
 * How brightly a house shows at night, from what its occupants are doing. Pure -- no PixiJS --
 * so LightingSystem only applies the answer.
 *
 * A house glows because someone is up in it: a lamp burns for the awake, not for the asleep, so a
 * sleeper's house goes dark instead of shining all night (it used to light for any occupant). The
 * private evening is the exception: the lamp is turned down, a dim warm glow that is neither the
 * full window light nor darkness -- the town can see somebody is in, and not much else. That is
 * all the canvas ever says about it (curtains and a heart or two are the rest); the act itself is
 * off-stage.
 */

/** `current_action` arrives as either a bare string or an object; both shapes are handled. */
export type ActionLike = { type?: string; zoneActivity?: string } | string | null | undefined;

/** Level of a house whose lamp is turned down. Full light is 1, dark 0. */
export const LAMP_TURNED_DOWN_LEVEL = 0.3;

/** Window and door light fades over this many 60 fps frames (about 1.5 s), whichever way it goes. */
export const HOME_LIGHT_FADE_FRAMES = 90;

function typeOf(a: ActionLike): string | undefined {
  return typeof a === 'string' ? a : a?.type;
}

function zoneOf(a: ActionLike): string | undefined {
  return typeof a === 'string' ? undefined : a?.zoneActivity;
}

/** Whether this action is the private evening (`zoneActivity: 'tryst'`). */
export function isPrivateEvening(a: ActionLike): boolean {
  return zoneOf(a) === 'tryst';
}

/** Whether any occupant is in the private evening. */
export function homeHostsTryst(occupantActions: Iterable<ActionLike>): boolean {
  for (const a of occupantActions) if (isPrivateEvening(a)) return true;
  return false;
}

/**
 * Target light level of a house, 0..1, for the actions of the agents inside it.
 * Nobody in, or everyone asleep: 0. Anyone in the private evening: {@link LAMP_TURNED_DOWN_LEVEL}.
 * Otherwise (some occupant awake): 1.
 */
export function homeLightLevel(occupantActions: Iterable<ActionLike>): number {
  let awake = false;
  for (const a of occupantActions) {
    if (isPrivateEvening(a)) return LAMP_TURNED_DOWN_LEVEL;
    if (typeOf(a) !== 'sleeping') awake = true;
  }
  return awake ? 1 : 0;
}

/** One frame of the fade: `current` moves toward `target` at a constant rate, never overshooting. */
export function stepHomeLight(current: number, target: number, deltaFrames: number): number {
  const step = deltaFrames / HOME_LIGHT_FADE_FRAMES;
  if (current < target) return Math.min(target, current + step);
  if (current > target) return Math.max(target, current - step);
  return current;
}
