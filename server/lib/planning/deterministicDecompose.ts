import type { DecomposedAction, PlanBlock } from './types';

/**
 * Blocks whose breakdown is not a creative act, decomposed without the LLM.
 *
 * `plan.decompose` was the largest call count in the game (~90 per game day)
 * and a good share of those calls asked the model to "break an hour of sleep
 * into 2-4 concrete things", or an eight-hour shift at the agent's own shop
 * into steps that all mean "work". The answer is known before asking: the
 * agent sleeps in their own bed, works at their own workplace, eats a meal in
 * their own kitchen. Only blocks that are unambiguous are handled here; on any
 * doubt (a person is named, a word hints at company or leisure, the place is
 * not the one the kind requires) the function returns null and the caller
 * falls back to the LLM, so a wrongly-skipped call costs a little colour and
 * a wrongly-taken shortcut would cost a plan that ignores what was planned.
 *
 * Pure (no DB, no clock): the caller supplies the agent's facts, which keeps
 * this testable without a database and free of any ordering concern with the
 * tick's transactions.
 */

export interface DeterministicContext {
  homeId: number | null;
  workplaceId: number | null;
  /** id + name of every location; used to name the target of each action. */
  locations: ReadonlyArray<{ id: number; name: string }>;
  /** Every other townsperson's name: a block that names one is a meeting, not a routine. */
  otherAgentNames: ReadonlyArray<string>;
  /** Shift window in whole hours; a workplace block outside it may be a visit, not work. */
  workStart?: number;
  workEnd?: number;
}

export type DeterministicKind = 'sleep' | 'work' | 'meal';

/** The parser caps one action at 240 minutes (schema + `parseDecomposedActions`); stay inside it. */
const MAX_ACTION_MINUTES = 240;

/** A home-cooked meal block longer than this is more than a meal (cook, eat, host, tidy...): ask the LLM. */
const MAX_MEAL_HOURS = 2;

const SLEEP_RE = /\b(sleep|sleeping|asleep|slumber|bed|bedtime|nap|napping|turn\s+in)\b/i;
/** "Wind down for bed", "read in bed", "get ready for bed" are routines with steps of their own, not sleep. */
const NOT_SLEEP_RE = /\b(wind\s*down|winding\s*down|prepare|preparing|get(?:ting)?\s+ready|routine|read|reading|write|writing|journal|talk|chat|with|dream\s+of)\b/i;

const MEAL_RE = /\b(breakfast|brunch|lunch|dinner|supper|meal|eat|eating|snack)\b/i;

/** Words that turn a meal or a shift into something social or leisurely: company, hosting, errands, play. */
const COMPANY_RE = /\b(with|together|guest|guests|invite|inviting|host|hosting|friend|friends|neighbou?rs?|family|date|party|celebrat\w*|visit\w*|chat\w*|talk\w*|meet\w*|gossip\w*|confront\w*|argu\w*|browse|browsing|shop(?:ping)?\s+for|buy|buying|relax\w*|rest|resting|read\w*|play\w*|fish\w*|garden\w*|walk\w*|stroll\w*|jog\w*|paint\w*|sing\w*|drink\w*|cook\w*)\b/i;

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

/** Whether the block's place is exactly this location ("Home" also names the agent's own). */
function isPlace(block: PlanBlock, locationId: number | null, ctx: DeterministicContext, allowHomeWord: boolean): boolean {
  if (locationId == null) return false;
  const hint = normalize(block.location_hint);
  if (allowHomeWord && hint === 'home') return true;
  const loc = ctx.locations.find((l) => l.id === locationId);
  return loc != null && normalize(loc.name) === hint;
}

function namesSomeone(text: string, ctx: DeterministicContext): boolean {
  const lower = text.toLowerCase();
  return ctx.otherAgentNames.some((n) => n.length > 0 && lower.includes(n.toLowerCase()));
}

/**
 * Which deterministic kind (if any) this block is. Order matters when home and
 * workplace are the same place (a farmer's farm): the specific kinds win over "work".
 */
export function classifyBlock(block: PlanBlock, ctx: DeterministicContext): DeterministicKind | null {
  const text = block.broad_action;
  if (!text.trim() || namesSomeone(text, ctx)) return null;
  const hours = block.end_hour - block.start_hour;
  if (hours <= 0) return null;

  if (isPlace(block, ctx.homeId, ctx, true)) {
    if (SLEEP_RE.test(text) && !NOT_SLEEP_RE.test(text) && !MEAL_RE.test(text)) return 'sleep';
    if (MEAL_RE.test(text) && !COMPANY_RE.test(text) && hours <= MAX_MEAL_HOURS) return 'meal';
  }

  // Work: at the agent's own workplace, inside their shift, and nothing in the
  // wording that says it is a break, a visit or a leisure hour. Positive
  // wording ("work", "shift") is not required: the model writes "Open the shop
  // and restock shelves", which names no work verb but is the shift.
  if (
    isPlace(block, ctx.workplaceId, ctx, false) &&
    ctx.workStart != null && ctx.workEnd != null &&
    block.start_hour >= ctx.workStart && block.end_hour <= ctx.workEnd &&
    !MEAL_RE.test(text) && !COMPANY_RE.test(text) && !SLEEP_RE.test(text)
  ) {
    return 'work';
  }
  return null;
}

/** `total` minutes as actions of at most MAX_ACTION_MINUTES, as even as whole minutes allow. */
function chunkMinutes(total: number): number[] {
  const parts = Math.ceil(total / MAX_ACTION_MINUTES);
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/**
 * The actions for `block`, in exactly the shape `parseDecomposedActions` +
 * PlanDecomposer's resolution step produce (description, action_type,
 * target_location, resolved_location_id, duration_minutes), or null when the
 * block needs the LLM. Durations add up to the whole block, since there is no
 * model "about N minutes" fuzz to absorb.
 */
export function decomposeDeterministically(
  block: PlanBlock,
  ctx: DeterministicContext,
): DecomposedAction[] | null {
  const kind = classifyBlock(block, ctx);
  if (!kind) return null;

  const placeId = kind === 'work' ? ctx.workplaceId : ctx.homeId;
  const place = ctx.locations.find((l) => l.id === placeId);
  if (!place) return null;

  const actionType = kind === 'sleep' ? 'sleeping' : kind === 'work' ? 'working' : 'eating';
  // The block's own wording is already a short concrete phrase (the plan
  // prompt asks for 3-8 words) and reads better in the feed than "Sleep".
  const description = block.broad_action.trim();
  const total = (block.end_hour - block.start_hour) * 60;

  return chunkMinutes(total).map((minutes) => ({
    description,
    action_type: actionType,
    target_location: place.name,
    resolved_location_id: place.id,
    duration_minutes: minutes,
  }));
}
