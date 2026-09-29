/**
 * What an agent is visibly *doing*, folded from the server's action (`current_action.type` plus
 * the `zoneActivity` verb) and where they are. Pure — no PixiJS — so every branch is unit
 * tested; ActivityFxSystem gathers the inputs and only renders the answer.
 *
 * Several server verbs share one look (speech and announce, plant and harvest...), so the
 * result is a small set of activities, each of which owns a pose, emotes and particles in
 * `activitySpecs.ts`.
 */
export type ActivityId =
  | 'none'
  | 'jog' | 'comfort' | 'browse' | 'shoplift' | 'pickpocket'
  | 'eating' | 'shopping' | 'mingle'
  | 'fish' | 'garden' | 'forage' | 'tend' | 'feed'
  | 'perform' | 'watch' | 'speech' | 'protest'
  | 'cook' | 'scheme' | 'confide' | 'contemplate'
  | 'work_bakery' | 'work_workshop' | 'work_shop' | 'work_pawnshop'
  | 'work_town_hall' | 'work_clinic' | 'work_tavern' | 'work_farm';

export interface ActivityContext {
  /** `current_action.type`. */
  actionType: string;
  /** `current_action.zoneActivity` (fish, garden, scheme...). */
  zoneActivity: string | null;
  /** Whether the agent is inside their own workplace. */
  atWorkplace: boolean;
  /** `type` of the agent's workplace. */
  workplaceType: string | null;
  /** Another awake agent stands close enough to be part of the chat. */
  nearOthers: boolean;
}

/** Zone verbs (server) -> activity. Verbs missing here look like plain idling. */
const ZONE_ACTIVITY: Record<string, ActivityId> = {
  jog: 'jog',
  comfort: 'comfort',
  browse: 'browse',
  shoplifting: 'shoplift',
  pickpocket: 'pickpocket',
  fish: 'fish',
  garden: 'garden',
  pick_flowers: 'tend',
  plant: 'tend',
  harvest: 'tend',
  collect_eggs: 'feed',
  feed_animals: 'feed',
  forage: 'forage',
  perform: 'perform',
  watch: 'watch',
  people_watch: 'watch',
  speech: 'speech',
  announce: 'speech',
  protest: 'protest',
  cook: 'cook',
  scheme: 'scheme',
  secret_meeting: 'scheme',
  smuggle: 'scheme',
  escape_attempt: 'scheme',
  lock_out: 'scheme',
  confide: 'confide',
  contemplate: 'contemplate',
};

const WORK_ACTIVITY: Record<string, ActivityId> = {
  bakery: 'work_bakery',
  workshop: 'work_workshop',
  shop: 'work_shop',
  pawnshop: 'work_pawnshop',
  town_hall: 'work_town_hall',
  clinic: 'work_clinic',
  tavern: 'work_tavern',
  divebar: 'work_tavern',
  farm: 'work_farm',
};

export function activityFor(c: ActivityContext): ActivityId {
  switch (c.actionType) {
    case 'working':
      // The bench is where the work shows; commuting to it is just walking.
      return c.atWorkplace && c.workplaceType ? WORK_ACTIVITY[c.workplaceType] ?? 'none' : 'none';
    case 'eating':
      return 'eating';
    case 'shopping':
      return 'shopping';
    case 'socializing':
      // Talking is a conversation (speech bubbles); this is the milling about before and after.
      return c.nearOthers ? 'mingle' : 'none';
    case 'idle':
    case 'comfort':
      if (c.zoneActivity && ZONE_ACTIVITY[c.zoneActivity]) return ZONE_ACTIVITY[c.zoneActivity];
      // A comfort visit to the park bench is a cup of tea whatever the zone tag says.
      return c.actionType === 'comfort' && !c.zoneActivity ? 'comfort' : 'none';
    default:
      return 'none';
  }
}

/** Activities where an agent looks at the person performing (watch) — see {@link isPerformerActivity}. */
export function isAudienceActivity(a: ActivityId): boolean {
  return a === 'watch';
}

/** Activities that draw an audience: a busker, a speaker, a protester. */
export function isPerformerActivity(a: ActivityId): boolean {
  return a === 'perform' || a === 'speech' || a === 'protest';
}

/**
 * Whether the trip that ended just now leaves the agent carrying a bag: shopping, or a browse
 * round the market stalls. Edge-detected by the caller (previous vs current).
 */
export function isShoppingTrip(actionType: string, zoneActivity: string | null): boolean {
  return actionType === 'shopping' || (actionType === 'idle' && zoneActivity === 'browse');
}
