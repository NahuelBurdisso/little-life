/**
 * Shapes of the gatherings system (see ./engine.ts for the why).
 *
 * Pure: no DB, no Node. A kind's callbacks do their own DB work; the types only
 * say what the engine and the decision phase need from them.
 */

/** Free-form facts a kind pins on a gathering (the deceased's name, the fire's outcome). JSON-safe. */
export type GatheringPayload = Record<string, string | number | boolean | null | number[] | string[]>;

/**
 * How hard the gathering pulls one resident:
 *   - `must`:   it is their gathering (the widow at the funeral, the owner at the fire):
 *               above the day plan, off a work shift; out of bed only for a kind that wakes;
 *   - `should`: close ties: above the day plan, but a work shift keeps them (unless the kind says otherwise);
 *   - `may`:    anyone else: the ordinary crowd pull, with a chance per game minute.
 */
export type InviteLevel = 'must' | 'should' | 'may';

export interface Invite {
  level: InviteLevel;
  /** Not before this game minute (market-goers drift in over the morning). */
  notBeforeMin: number;
  /** First seen at the venue, or null. */
  arrivedAtMin: number | null;
  /** They have stayed their time and are free again (or the pull lapsed). */
  doneAtMin: number | null;
}

export type GatheringStatus = 'scheduled' | 'open' | 'closed';

export interface Gathering {
  id: number;
  /** A `GatheringKind.id` ('funeral', 'fire'...). */
  kind: string;
  venueLocationId: number;
  /** GAME MINUTES, like every stamp here. */
  startMin: number;
  endMin: number;
  /** Whose gathering it is (the couple, the leaver, the owner of the burning house). */
  hostIds: number[];
  /** Who it is about, when that is not a host (the deceased). */
  subjectId: number | null;
  status: GatheringStatus;
  invited: Map<number, Invite>;
  /** Everyone seen at the venue during the window, invited or not. */
  attended: Set<number>;
  /** The world event this gathering wraps (a funeral, a wedding, the fire), or null. */
  eventId: number | null;
  /** Moment offsets (game minutes after start) already run. */
  momentsDone: number[];
  /** Times the start was put off (a storm over a funeral). */
  postponed: number;
  payload: GatheringPayload;
}

/** A closed gathering, kept for "who came and who didn't" and the soak's table. */
export interface GatheringRecord {
  id: number;
  kind: string;
  venueLocationId: number;
  startMin: number;
  endMin: number;
  hostIds: number[];
  subjectId: number | null;
  invited: Array<[number, InviteLevel]>;
  attended: number[];
  payload: GatheringPayload;
}

/** Who was asked and who came (live or closed). */
export interface Attendance {
  invited: Map<number, InviteLevel>;
  attended: Set<number>;
  /** Invited `must`/`should` who never came. */
  absent: number[];
}

/**
 * One kind of gathering. The registry (`GATHERING_KINDS`, kinds/) is the whole
 * policy: the engine and the decision phase know nothing of funerals or fires.
 */
export interface GatheringKind {
  id: string;
  /** Invitations go out (and `onOpen` runs) this many game minutes before the start. Default 45. */
  leadMin?: number;
  /** May pull an invitee out of bed (a fire): the one kind allowed to wake people. */
  wakes?: boolean;
  /** Levels that leave a work shift for it. Default: `must` only. */
  leavesShift?: readonly InviteLevel[];
  /**
   * Game minutes an invitee of each level stays once there (default: the whole window).
   * A market-goer browses an hour, a mourner stays to the end.
   */
  stayMin?: Partial<Record<InviteLevel, number>>;
  /** Chance per game minute a free `may` invitee sets off (rolled per tick through chancePerTick). */
  mayChancePerMin?: number;
  /** Chance per game minute that two free people at the venue strike up a gathering chat. Default 0.06. */
  encounterPerMin?: number;
  /** Game minutes after the start at which `moment` runs (the eulogy, the toast, the fire put out). */
  momentsAt?: readonly number[];
  /** Put the start off while a storm is on (game minutes per delay, at most twice). */
  stormDelayMin?: number;
  /** Still worth holding? (The leaver died, the couple's event is gone.) Checked each pass; false cancels it. */
  stillRelevant?(g: Gathering): boolean;
  /** Who is asked, and how hard: filled into `g.invited` when the invitations go out. */
  invite(g: Gathering, nowMin: number): void;
  /** Invitations are out: start the wrapped event, wake the sleepers... */
  onOpen?(g: Gathering, nowMin: number): void;
  /** What the cast bar says on the way and once there ("At James's funeral"). */
  label(g: Gathering, venueName: string): { walking: string; there: string };
  /** The gathering chat's topic (LLM intent and the template scripts' trigger key off it). */
  topic(g: Gathering): string;
  /** One shared moment for everyone present. `index` is the position in `momentsAt`. */
  moment?(g: Gathering, presentIds: number[], nowMin: number, index: number): void;
  /**
   * Something this person does at the venue instead of just being there (a
   * pickpocket working the market crowd), as a decision source the existing
   * paths resolve (crime.ts `executeCrime`). Asked only of someone already there.
   */
  errandFor?(g: Gathering, agentId: number, nowMin: number): { source: string; targetAgentId?: number } | null;
  /** The window is over: judge the attendance, apply the effects, write the ONE summary row. */
  onClose(g: Gathering, attendance: Attendance, nowMin: number): void;
}
