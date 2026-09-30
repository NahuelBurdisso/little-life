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
 * Widened after playtest #3 (L2): sleep/shift/home-meal only took 23% of the
 * traced blocks and the call count fell ~10%. What the model was still asked
 * about was mostly just as mechanical — "Walk slowly to Town Hall" on Main
 * Street, "Buy supplies at Rosa's" in the store, "Eat lunch alone" wherever
 * the agent is, "Read by oil lamp" or "Wake up and dress quietly" at home. The
 * LLM's own answer for those is the same phrase with the same action type
 * (`inferActionType`), so nothing is lost by writing it directly. Anything
 * that could be a scene still goes to the model: a named person (first names
 * too), company, errands of the heart (apologise, confront, deliver, flirt),
 * snooping, drinking, and any place that does not fit the kind.
 *
 * Pure (no DB, no clock): the caller supplies the agent's facts, which keeps
 * this testable without a database and free of any ordering concern with the
 * tick's transactions.
 */

export interface DeterministicContext {
  homeId: number | null;
  workplaceId: number | null;
  /**
   * id + name (+ type when known) of every location; used to name the target
   * of each action. Without a type, the kinds that depend on the kind of place
   * (errands, walks, meals out) are left to the LLM.
   */
  locations: ReadonlyArray<{ id: number; name: string; type?: string }>;
  /** Every other townsperson's name: a block that names one is a meeting, not a routine. */
  otherAgentNames: ReadonlyArray<string>;
  /** Shift window in whole hours; a workplace block outside it may be a visit, not work. */
  workStart?: number;
  workEnd?: number;
}

export type DeterministicKind =
  | 'sleep' | 'work' | 'meal'
  /** Home routine: morning routine, reading, writing, resting, chores, a meal plus one of those. */
  | 'home'
  /** A meal somewhere other than home (tavern, bakery, a packed lunch at work or in the park). */
  | 'meal_out'
  /** Buying things at a shop, bakery, market or tavern. */
  | 'errand'
  /** Walking somewhere along a street, square or park — the commute and the stroll. */
  | 'walk'
  /** Sitting, resting or reading alone in a park, square or by the river. */
  | 'outdoors'
  /** Church, prayer, a service. */
  | 'worship';

/** The parser caps one action at 240 minutes (schema + `parseDecomposedActions`); stay inside it. */
const MAX_ACTION_MINUTES = 240;

/** A home-cooked meal block longer than this is more than a meal (cook, eat, host, tidy...): ask the LLM. */
const MAX_MEAL_HOURS = 2;

/** Longest block the widened kinds take: a four-hour "walk" or "errand" is a plan in disguise. */
const MAX_ROUTINE_HOURS = 3;

const SLEEP_RE = /\b(sleep|sleeping|asleep|slumber|bed|bedtime|nap|napping|turn\s+in)\b/i;
/** "Wind down for bed", "read in bed", "get ready for bed" are routines with steps of their own, not sleep. */
const NOT_SLEEP_RE = /\b(wind\s*down|winding\s*down|prepare|preparing|get(?:ting)?\s+ready|routine|read|reading|write|writing|journal|talk|chat|with|dream\s+of)\b/i;

const MEAL_RE = /\b(breakfast|brunch|lunch|dinner|supper|meal|eat|eating|snack)\b/i;

/** Words that turn a meal or a shift into something social or leisurely: company, hosting, errands, play. */
const COMPANY_RE = /\b(with|together|guest|guests|invite|inviting|host|hosting|friend|friends|neighbou?rs?|family|date|party|celebrat\w*|visit\w*|chat\w*|talk\w*|meet\w*|gossip\w*|confront\w*|argu\w*|browse|browsing|shop(?:ping)?\s+for|buy|buying|relax\w*|rest|resting|read\w*|play\w*|fish\w*|garden\w*|walk\w*|stroll\w*|jog\w*|paint\w*|sing\w*|drink\w*|cook\w*)\b/i;

/**
 * Anything that makes a routine a scene, for the widened kinds: other people
 * (company, a favour, a quarrel), purpose beyond the routine (snooping,
 * research, meetings), drink, romance and performance. Deliberately broad —
 * one of these words sends the block to the LLM.
 */
const SCENE_RE = /\b(with|together|for\s+(?:him|her|them)|friend\w*|neighbou?r\w*|family|guest\w*|invite\w*|host\w*|date|party|celebrat\w*|visit\w*|meet\w*|meeting|chat\w*|talk\w*|speak\w*|ask\w*|question\w*|gossip\w*|rumou?r\w*|news|listen\w*|eavesdrop\w*|overhear\w*|spy\w*|watch\w*|observ\w*|linger\w*|seek\w*|search\w*|find\w*|look\w*\s+for|hunt\w*|investigat\w*|research\w*|inspect\w*|archive\w*|confront\w*|argu\w*|apolog\w*|forgive\w*|flirt\w*|kiss\w*|whisper\w*|romance|court\w*|chase\w*|steal\w*|secret\w*|scheme\w*|plot\w*|deliver\w*|bring\w*|give\w*|gift\w*|help\w*|comfort\w*|hug\w*|hold\w*|share\w*|serve\w*|sell\w*|trade\w*|haggl\w*|dance\w*|sing\w*|play\w*|perform\w*|music|song\w*|melod\w*|drunk|ale|beer|wine|brandy|whiskey|flask|booze|drinks?\b(?!\s+(?:coffee|tea|water))|drinking|report\w*|notes?\s+for|prepare\s+(?:notes|thoughts|for)|plan\w*|reputation)\b/i;

/** Morning routine, rest, reading, writing, chores and the like — at home. */
const HOME_ROUTINE_RE = /\b(wake\w*|get(?:ting)?\s+up|dress\w*|wash\w*|bath\w*|shave\w*|groom\w*|stretch\w*|morning\s+routine|tidy\w*|clean\w*|sweep\w*|scrub\w*|dust\w*|laundry|chores?|mend\w*|sew\w*|knit\w*|darn\w*|chop\w*\s+wood|fetch\w*\s+water|light\w*\s+(?:the\s+)?(?:lamps?|fire|stove)|read\w*|write\w*|journal\w*|letters?|diary|scrapbook|ledger|rest\w*|relax\w*|sit\w*|lie|lay|lying|lounge\w*|stare\w*|daydream\w*|reflect\w*|think\w*|recover\w*|nurse\w*|sip\w*|tea|coffee|water|smoke\w*|pipe|fireplace|fire|lamp|porch)\b/i;

/** Outdoors on one's own: sit, rest, read, sketch. */
const OUTDOOR_REST_RE = /\b(sit\w*|rest\w*|relax\w*|read\w*|sketch\w*|lie|lay|lying|breathe\w*|feed\w*\s+(?:the\s+)?(?:ducks|birds|pigeons)|bench|sunshine|fresh\s+air)\b/i;

const WALK_RE = /^(?:(?:take\s+an?\s+)?(?:slow|gentle|quick|brisk|long|short|quiet|lazy|slowly|quietly|briskly)\s+)?(walk\w*|stroll\w*|wander\w*|amble\w*|head\w*|go|goes|going|return\w*|hurry\w*|trudge\w*|stumble\w*|stagger\w*|limp\w*|make\s+(?:my|the)\s+way)\b/i;

const BUY_RE = /\b(buy\w*|purchas\w*|pick\w*\s+up|restock\w*\s+(?:my|the)?\s*(?:pantry|larder)|groceries|errands?|provisions)\b/i;

/** What rides along with a meal without making it a second activity. */
const MEAL_SIDE_RE = /\b(tea|coffee|water|bread|pastr\w*|cake|soup|pie|stew|alone|quiet\w*|quick\w*)\b/i;

const WORSHIP_RE = /\b(church|chapel|pray\w*|mass|service|worship\w*|sermon|vespers|hymns?)\b/i;

/** Places a walk happens in or a person rests outdoors. */
const OUTDOOR_TYPES = new Set(['mainstreet', 'street', 'town_square', 'market_square', 'market', 'park', 'alley', 'farmyard', 'river', 'plaza']);
/** Places that sell things. */
const SHOP_TYPES = new Set(['shop', 'bakery', 'pawnshop', 'market', 'market_square', 'tavern', 'divebar', 'farm', 'general_store', 'store']);
/** Someone's house: a meal there is a visit unless it is the agent's own. */
const RESIDENTIAL_TYPES = new Set(['home', 'house', 'cottage', 'residence']);
const WORSHIP_TYPES = new Set(['church', 'chapel', 'temple']);

function normalize(name: string): string {
  return name.trim().toLowerCase();
}

function locationOf(block: PlanBlock, ctx: DeterministicContext) {
  const hint = normalize(block.location_hint);
  return ctx.locations.find((l) => normalize(l.name) === hint);
}

/** Whether the block's place is exactly this location ("Home" also names the agent's own). */
function isPlace(block: PlanBlock, locationId: number | null, ctx: DeterministicContext, allowHomeWord: boolean): boolean {
  if (locationId == null) return false;
  const hint = normalize(block.location_hint);
  if (allowHomeWord && hint === 'home') return true;
  const loc = ctx.locations.find((l) => l.id === locationId);
  return loc != null && normalize(loc.name) === hint;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether the text names another townsperson — by full name, or by first name
 * when that is not a possessive ("Rosa's" is the store, "Rosa" is Rosa). Place
 * names are removed first: "Priya's Bakery" names a bakery, not Priya.
 */
function namesSomeone(text: string, ctx: DeterministicContext): boolean {
  let lower = text.toLowerCase();
  for (const l of ctx.locations) {
    const n = l.name.toLowerCase();
    if (n.length > 0) lower = lower.split(n).join(' ');
  }
  return ctx.otherAgentNames.some((full) => {
    const n = full.toLowerCase().trim();
    if (n.length === 0) return false;
    if (lower.includes(n)) return true;
    const first = n.replace(/^(dr|mr|mrs|ms)\.?\s+/, '').split(/\s+/)[0];
    return first.length >= 3 && new RegExp(`\\b${escapeRe(first)}\\b(?!['’]s)`).test(lower);
  });
}

/** One clause of a home block: what it is, or null when it is not a plain routine. */
function homeClauseKind(clause: string): 'meal' | 'sleep' | 'routine' | null {
  if (!clause.trim()) return null;
  if (SCENE_RE.test(clause)) return null;
  if (/\bcook\w*|bak\w*|prepare\s+(?!tea|coffee|breakfast)/i.test(clause)) return null;
  // "Read in bed" is reading; "wind down for bed" has steps of its own (null below).
  if (SLEEP_RE.test(clause) && !NOT_SLEEP_RE.test(clause)) return 'sleep';
  if (MEAL_RE.test(clause)) return 'meal';
  if (HOME_ROUTINE_RE.test(clause)) return 'routine';
  return null;
}

/** "Eat supper and rest", "Wake up, wash and dress": the clauses of a home block. */
function splitClauses(text: string): string[] {
  return text.split(/\s*(?:,|;|\band\b|\bthen\b)\s*/i).map((c) => c.trim()).filter(Boolean);
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

  const atHome = isPlace(block, ctx.homeId, ctx, true);
  if (atHome) {
    // Every clause must be sleep ("Go to bed and sleep"): "Nap and then cook"
    // is a home block with a sleep in the wrong place, not an afternoon asleep.
    const clauses = splitClauses(text);
    if (clauses.every((c) => SLEEP_RE.test(c)) && !NOT_SLEEP_RE.test(text) && !MEAL_RE.test(text)) return 'sleep';
    // One clause only: "Eat quietly and go to bed" is a meal AND bedtime, which
    // the home kind below splits into both.
    if (MEAL_RE.test(text) && clauses.length === 1 && !COMPANY_RE.test(text) && hours <= MAX_MEAL_HOURS) return 'meal';
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

  // ── Widened kinds (L2) ──
  if (hours > MAX_ROUTINE_HOURS) return null;

  if (atHome) {
    const clauses = splitClauses(text);
    if (clauses.length === 0 || clauses.length > 3) return null;
    const kinds = clauses.map(homeClauseKind);
    if (kinds.some((k) => k == null)) return null;
    // Sleep only as the last thing ("Eat quietly and go to bed"), never "nap and cook".
    if (kinds.slice(0, -1).includes('sleep')) return null;
    return 'home';
  }

  const loc = locationOf(block, ctx);
  const type = loc?.type;
  if (!loc || !type) return null;
  if (SCENE_RE.test(text)) return null;
  if (WORSHIP_RE.test(text)) return WORSHIP_TYPES.has(type) && !/\bconfess\w*/i.test(text) ? 'worship' : null;

  if (MEAL_RE.test(text) && hours <= MAX_MEAL_HOURS) {
    // Anywhere but someone else's house: a tavern supper, a packed lunch at
    // work, bread by the river. The economy serves whatever the place sells or
    // what the eater carries (economy.ts serveMeal), same as for an LLM action.
    if (RESIDENTIAL_TYPES.has(type)) return null;
    // "Eat pastries and people watch": a second activity is for the model;
    // "Eat breakfast and drink coffee" is still one meal.
    if (!splitClauses(text).every((c) => MEAL_RE.test(c) || MEAL_SIDE_RE.test(c))) return null;
    return 'meal_out';
  }
  if (BUY_RE.test(text) && SHOP_TYPES.has(type) && hours <= 2) return 'errand';
  if (WALK_RE.test(text) && OUTDOOR_TYPES.has(type) && hours <= 2 && !/\band\b/i.test(text)) return 'walk';
  if (OUTDOOR_REST_RE.test(text) && OUTDOOR_TYPES.has(type) && !/\band\b/i.test(text)) return 'outdoors';
  return null;
}

/** `total` minutes as actions of at most MAX_ACTION_MINUTES, as even as whole minutes allow. */
function chunkMinutes(total: number): number[] {
  const parts = Math.ceil(total / MAX_ACTION_MINUTES);
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/** `total` minutes shared by `n` clauses in whole 5-minute steps; the last one takes the rest. */
function shareMinutes(total: number, n: number): number[] {
  const each = Math.max(5, Math.floor(total / n / 5) * 5);
  const out = Array.from({ length: n }, () => each);
  out[n - 1] = total - each * (n - 1);
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const ACTION_TYPE: Record<Exclude<DeterministicKind, 'home'>, string> = {
  sleep: 'sleeping',
  work: 'working',
  meal: 'eating',
  meal_out: 'eating',
  errand: 'shopping',
  walk: 'walking',
  // What `inferActionType` makes of "Read by the river" / "Sit in the square":
  // an idle at the place, which the needs table counts as rest.
  outdoors: 'idle',
  worship: 'contemplate',
};

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

  const placeId = kind === 'work'
    ? ctx.workplaceId
    : kind === 'sleep' || kind === 'meal' || kind === 'home'
      ? ctx.homeId
      : locationOf(block, ctx)?.id ?? null;
  const place = ctx.locations.find((l) => l.id === placeId);
  if (!place) return null;

  const total = (block.end_hour - block.start_hour) * 60;
  const action = (description: string, action_type: string, minutes: number): DecomposedAction => ({
    description,
    action_type,
    target_location: place.name,
    resolved_location_id: place.id,
    duration_minutes: minutes,
  });

  if (kind === 'home') {
    // One action per clause, so "Eat supper and rest" eats first and then
    // rests, as the model would have split it. A routine clause is an idle at
    // home (what `inferActionType` gives "Read by oil lamp"), not 'sleeping'
    // — "rest by the fire" at 20:00 must not put anyone to bed.
    const clauses = splitClauses(block.broad_action);
    const minutes = shareMinutes(total, clauses.length);
    return clauses.flatMap((clause, i) => {
      const k = homeClauseKind(clause);
      const type = k === 'sleep' ? 'sleeping' : k === 'meal' ? 'eating' : 'idle';
      return chunkMinutes(minutes[i]).map((m) => action(capitalize(clause), type, m));
    });
  }

  // The block's own wording is already a short concrete phrase (the plan
  // prompt asks for 3-8 words) and reads better in the feed than "Sleep".
  const description = block.broad_action.trim();
  return chunkMinutes(total).map((minutes) => action(description, ACTION_TYPE[kind], minutes));
}
