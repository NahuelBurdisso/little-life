/**
 * The town calendar: the fixed days of the year every resident knows are coming.
 *
 * Why this exists. Before it, days 5–30 of a town had no shape: every world
 * event was a random hourly roll ("Town Festival", "Market Day") that nobody saw
 * coming, gave everyone a mood/stat nudge and was forgotten. A small town of
 * ~1900 lives by its calendar — the weekly market, the spring fair, midsummer,
 * the harvest home, the winter lights, and an election each season — and the
 * anticipation IS half the story: people plan around a fair, practise for its
 * contest, campaign for weeks before a vote. So the dates are fixed, known two
 * days ahead (lib/townCalendar.ts announces them), written into residents' plan
 * prompts, and the day itself starts a real world event with a contest or a
 * count at the end of it.
 *
 * Year shape (engine/tick.ts `advanceClock`): 4 seasons of 28 days, a 112-day
 * year, day 0 = spring day 0. A new world starts on day 1 (setup wizard), so a
 * fresh town sees a market on day 5, the Spring Fair on day 9 and its first
 * election campaign on days 21–23 with the vote on day 24 — the first month has
 * a rhythm without waiting for the second season.
 *
 * Pure data + date arithmetic: the client imports it (TopBar chip, Journal
 * timeline headers). No Node or DB imports.
 */
import type { WorldEventType } from './worldEventCatalog';

/**
 * Mirrors CONFIG.TIME.SEASON_LENGTH_DAYS (server/lib/constants.ts), which the
 * client can't import (it pulls in the job table and worldgen config). A test
 * pins the two together.
 */
export const SEASON_LENGTH_DAYS = 28;
export const SEASONS = ['spring', 'summer', 'autumn', 'winter'] as const;
export type Season = (typeof SEASONS)[number];
export const DAYS_PER_YEAR = SEASON_LENGTH_DAYS * SEASONS.length;

/** Season of a game day, the way `advanceClock` derives it. */
export function seasonOf(day: number): Season {
  return SEASONS[Math.floor(Math.max(0, day) / SEASON_LENGTH_DAYS) % SEASONS.length];
}

/** Day within its season, 0..27. */
export function seasonDayOf(day: number): number {
  return Math.max(0, day) % SEASON_LENGTH_DAYS;
}

/** Which year a day falls in, from 0. */
export function yearOf(day: number): number {
  return Math.floor(Math.max(0, day) / DAYS_PER_YEAR);
}

/** First day of `season` in `year`. */
export function seasonStartDay(year: number, season: Season): number {
  return year * DAYS_PER_YEAR + SEASONS.indexOf(season) * SEASON_LENGTH_DAYS;
}

// ─── Contests ────────────────────────────────────────────────────────────────

/** Personality axes (lib/personality.ts PersonalityProfile). */
export type PersonalityAxis =
  | 'honesty' | 'aggression' | 'warmth' | 'impulsiveness' | 'vanity'
  | 'curiosity' | 'loyalty' | 'morality' | 'sensuality' | 'neuroticism';

/**
 * A festival's contest. Judged on the hobby skill the town has been practising
 * all along (lib/hobbyEngine.ts — `activity` is the zone activity its levels
 * are keyed on), a head start for people whose trade it is, a lean of
 * personality, and a little luck (lib/contest.ts).
 */
export interface ContestDef {
  /** "the ploughing match" — reads after "won". */
  name: string;
  /** Zone activity whose hobby level counts (hobbyEngine ACTIVITY_TO_HOBBY). */
  activity: 'garden' | 'cook' | 'perform' | 'jog' | 'fish' | 'forage';
  /** Trades that start ahead (data/jobs.ts keys). */
  jobs: readonly string[];
  /** Personality leanings, -1..1 per axis: vanity helps a singer, aggression a ploughman. */
  traits: Partial<Record<PersonalityAxis, number>>;
  /** What the winner is remembered for: "the best voice at Midsummer". */
  prize: string;
}

export type FestivalId = 'spring_fair' | 'midsummer' | 'harvest_festival' | 'winter_lights';

export interface FestivalDef {
  id: FestivalId;
  name: string;
  icon: string;
  season: Season;
  /** Day within the season. */
  seasonDay: number;
  /** Game hour the festival opens; it runs for the event's catalog duration. */
  startHour: number;
  /** World event started on the day (data/worldEventCatalog.ts). */
  eventType: WorldEventType;
  /** Where it is held, first match wins (location types). */
  locationTypes: readonly string[];
  /** What people do there — for plan prompts and the paper. */
  activities: string;
  contest: ContestDef;
  /** Hours after opening the contest is judged (before the festival closes). */
  contestAfterHours: number;
}

/**
 * The four festivals. Days picked so none falls on a market day (day % 7 === 5)
 * or on election day, and so a fresh town (day 1) reaches the Spring Fair in
 * its first fortnight. Midsummer sits mid-season, the harvest home late in
 * autumn, the winter lights just before the year turns.
 */
export const FESTIVALS: Readonly<Record<FestivalId, FestivalDef>> = {
  spring_fair: {
    id: 'spring_fair', name: 'Spring Fair', icon: '🌸', season: 'spring', seasonDay: 9, startHour: 10,
    eventType: 'spring_fair', locationTypes: ['town_square', 'park', 'farm'],
    activities: 'stalls, dancing round the maypole and a ploughing match',
    contest: {
      name: 'the ploughing match', activity: 'jog', jobs: ['farmer', 'farmhand', 'handyperson'],
      traits: { aggression: 0.6, impulsiveness: 0.3, neuroticism: -0.4 }, prize: 'the straightest furrow at the Spring Fair',
    },
    contestAfterHours: 4,
  },
  midsummer: {
    id: 'midsummer', name: 'Midsummer', icon: '🔥', season: 'summer', seasonDay: 14, startHour: 16,
    eventType: 'midsummer', locationTypes: ['park', 'town_square'],
    activities: 'a bonfire, music and dancing into the night, and a singing contest',
    contest: {
      name: 'the singing contest', activity: 'perform', jobs: ['musician', 'bartender'],
      traits: { vanity: 0.6, warmth: 0.4, neuroticism: -0.5 }, prize: 'the finest voice at Midsummer',
    },
    contestAfterHours: 4,
  },
  harvest_festival: {
    id: 'harvest_festival', name: 'Harvest Festival', icon: '🎃', season: 'autumn', seasonDay: 18, startHour: 11,
    eventType: 'harvest_festival', locationTypes: ['town_square', 'farm', 'park'],
    activities: 'a harvest supper, cider, and the pie contest',
    contest: {
      name: 'the pie contest', activity: 'cook', jobs: ['baker', 'farmer'],
      traits: { curiosity: 0.4, loyalty: 0.3, impulsiveness: -0.3 }, prize: 'the best pie at the Harvest Festival',
    },
    contestAfterHours: 4,
  },
  winter_lights: {
    id: 'winter_lights', name: 'Winter Lights', icon: '🕯', season: 'winter', seasonDay: 21, startHour: 16,
    eventType: 'winter_lights', locationTypes: ['town_square', 'park'],
    activities: 'lanterns on every door, carols, mulled wine and the baking contest',
    contest: {
      name: 'the baking contest', activity: 'cook', jobs: ['baker', 'shopkeeper'],
      traits: { warmth: 0.5, honesty: 0.2, neuroticism: -0.3 }, prize: 'the best Christmas loaf of Winter Lights',
    },
    contestAfterHours: 4,
  },
};

export const FESTIVAL_IDS = Object.keys(FESTIVALS) as FestivalId[];

/** The weekly market: every day with `day % 7 === weekday`. */
export const MARKET = {
  name: 'Market Day',
  icon: '🧺',
  weekday: 5,
  startHour: 8,
  eventType: 'market_day' as WorldEventType,
  locationTypes: ['market_square', 'town_square'] as readonly string[],
  activities: 'stalls of produce and wares, cheap prices',
};

/**
 * The mayoral election, once a season. Three game days of campaigning, then
 * the vote: residents vote through the day, the town gathers on the square at
 * `countHour` for the count, and the result is read out at `resultHour`.
 */
export const ELECTION = {
  name: 'Mayoral Election',
  icon: '🗳',
  seasonDay: 24,
  campaignDays: 3,
  countHour: 17,
  resultHour: 18,
  eventType: 'election_day' as WorldEventType,
  locationTypes: ['town_square', 'town_hall'] as readonly string[],
};

/** How many days ahead the town hears about what's coming. */
export const ANNOUNCE_DAYS_AHEAD = 2;

// ─── Entries ─────────────────────────────────────────────────────────────────

export type CalendarKind = 'festival' | 'market' | 'campaign' | 'election';

export interface CalendarEntry {
  /** Stable per occurrence: "festival:harvest_festival:74". */
  key: string;
  kind: CalendarKind;
  day: number;
  name: string;
  icon: string;
  /** The world event it starts (none for campaign days: the campaign has no event of its own). */
  eventType: WorldEventType | null;
  startHour: number;
  locationTypes: readonly string[];
  festivalId?: FestivalId;
}

function festivalEntry(f: FestivalDef, day: number): CalendarEntry {
  return {
    key: `festival:${f.id}:${day}`, kind: 'festival', day, name: f.name, icon: f.icon,
    eventType: f.eventType, startHour: f.startHour, locationTypes: f.locationTypes, festivalId: f.id,
  };
}

/** The election a day belongs to, if it is a campaign or election day. */
export function electionDayFor(day: number): number | null {
  const sd = seasonDayOf(day);
  if (sd === ELECTION.seasonDay) return day;
  const before = ELECTION.seasonDay - sd;
  return before > 0 && before <= ELECTION.campaignDays ? day + before : null;
}

/** Everything on one day, in the order it happens. */
export function calendarOn(day: number): CalendarEntry[] {
  if (day < 0) return [];
  const out: CalendarEntry[] = [];
  const season = seasonOf(day);
  const sd = seasonDayOf(day);
  if (day % 7 === MARKET.weekday) {
    out.push({
      key: `market:${day}`, kind: 'market', day, name: MARKET.name, icon: MARKET.icon,
      eventType: MARKET.eventType, startHour: MARKET.startHour, locationTypes: MARKET.locationTypes,
    });
  }
  for (const f of FESTIVAL_IDS.map((id) => FESTIVALS[id])) {
    if (f.season === season && f.seasonDay === sd) out.push(festivalEntry(f, day));
  }
  const electionDay = electionDayFor(day);
  if (electionDay === day) {
    out.push({
      key: `election:${day}`, kind: 'election', day, name: ELECTION.name, icon: ELECTION.icon,
      eventType: ELECTION.eventType, startHour: ELECTION.countHour, locationTypes: ELECTION.locationTypes,
    });
  } else if (electionDay != null) {
    out.push({
      key: `campaign:${electionDay}:${day}`, kind: 'campaign', day, name: 'Election campaign', icon: ELECTION.icon,
      eventType: null, startHour: 8, locationTypes: ELECTION.locationTypes,
    });
  }
  return out.sort((a, b) => a.startHour - b.startHour);
}

/**
 * Entries from `fromDay` through `fromDay + days` inclusive, soonest first.
 * Campaign days are left out: they are the run-up to an election, which is
 * listed itself.
 */
export function upcoming(fromDay: number, days: number): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  for (let d = Math.max(0, fromDay); d <= fromDay + days; d++) {
    out.push(...calendarOn(d).filter((e) => e.kind !== 'campaign'));
  }
  return out;
}

/** The next election day on or after `day`. */
export function nextElectionDay(day: number): number {
  const d = Math.max(0, day);
  const start = d - seasonDayOf(d);
  const thisSeason = start + ELECTION.seasonDay;
  return thisSeason >= d ? thisSeason : thisSeason + SEASON_LENGTH_DAYS;
}

/** First campaign day of the election held on `electionDay`. */
export function campaignStartDay(electionDay: number): number {
  return electionDay - ELECTION.campaignDays;
}

/** "today" / "tomorrow" / "in 2 days". */
export function whenPhrase(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

/**
 * The next notable entry within `withinDays` of `day` (markets only when
 * nothing bigger is coming, since one comes every week), with how far off it
 * is. Null when the calendar is empty that far out.
 */
export function nextHighlight(day: number, withinDays = ANNOUNCE_DAYS_AHEAD): { entry: CalendarEntry; inDays: number } | null {
  const entries = upcoming(day, withinDays);
  const big = entries.find((e) => e.kind !== 'market');
  const pick = big ?? entries[0];
  return pick ? { entry: pick, inDays: pick.day - day } : null;
}
