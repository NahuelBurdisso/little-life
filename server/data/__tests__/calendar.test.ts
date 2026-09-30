import { describe, it, expect } from 'vitest';
import {
  DAYS_PER_YEAR, ELECTION, FESTIVALS, FESTIVAL_IDS, MARKET, SEASON_LENGTH_DAYS,
  calendarOn, campaignStartDay, electionDayFor, nextElectionDay, nextHighlight, seasonDayOf, seasonOf,
  seasonStartDay, upcoming, whenPhrase, yearOf,
} from '../calendar';
import { CONFIG } from '../../lib/constants';
import { WORLD_EVENTS, eventFamily } from '../worldEventCatalog';

describe('the calendar year', () => {
  it('mirrors the clock: 28-day seasons, 112-day year, seasons in advanceClock order', () => {
    expect(SEASON_LENGTH_DAYS).toBe(CONFIG.TIME.SEASON_LENGTH_DAYS);
    expect(DAYS_PER_YEAR).toBe(112);
    expect(seasonOf(0)).toBe('spring');
    expect(seasonOf(27)).toBe('spring');
    expect(seasonOf(28)).toBe('summer');
    expect(seasonOf(111)).toBe('winter');
    expect(seasonOf(112)).toBe('spring');
    expect(seasonDayOf(30)).toBe(2);
    expect(yearOf(111)).toBe(0);
    expect(yearOf(112)).toBe(1);
    expect(seasonStartDay(1, 'autumn')).toBe(112 + 56);
  });

  it('holds each festival on its season day, every year', () => {
    for (const year of [0, 1, 3]) {
      for (const id of FESTIVAL_IDS) {
        const f = FESTIVALS[id];
        const day = seasonStartDay(year, f.season) + f.seasonDay;
        const entries = calendarOn(day).filter((e) => e.kind === 'festival');
        expect(entries.map((e) => e.festivalId), `${id} y${year}`).toEqual([id]);
        expect(entries[0].key).toBe(`festival:${id}:${day}`);
      }
    }
    // Exactly four festivals a year.
    const all = Array.from({ length: DAYS_PER_YEAR }, (_, d) => calendarOn(d + DAYS_PER_YEAR))
      .flat().filter((e) => e.kind === 'festival');
    expect(all).toHaveLength(4);
  });

  it('never puts a festival on a market day or on election day', () => {
    for (let d = 0; d < DAYS_PER_YEAR * 2; d++) {
      const kinds = calendarOn(d).map((e) => e.kind);
      if (kinds.includes('festival')) {
        expect(kinds.includes('market'), `day ${d}`).toBe(false);
        expect(kinds.includes('election'), `day ${d}`).toBe(false);
      }
      expect(kinds.includes('market')).toBe(d % 7 === MARKET.weekday);
    }
  });

  it('holds one election a season with a three-day campaign before it', () => {
    const elections = Array.from({ length: DAYS_PER_YEAR }, (_, d) => calendarOn(d)).flat().filter((e) => e.kind === 'election');
    expect(elections.map((e) => e.day)).toEqual([24, 52, 80, 108]);
    expect(electionDayFor(21)).toBe(24);
    expect(electionDayFor(23)).toBe(24);
    expect(electionDayFor(24)).toBe(24);
    expect(electionDayFor(20)).toBeNull();
    expect(electionDayFor(25)).toBeNull();
    expect(calendarOn(22).map((e) => e.kind)).toContain('campaign');
    expect(campaignStartDay(24)).toBe(24 - ELECTION.campaignDays);
    expect(nextElectionDay(1)).toBe(24);
    expect(nextElectionDay(24)).toBe(24);
    expect(nextElectionDay(25)).toBe(52);
    expect(nextElectionDay(110)).toBe(136);
  });

  it('gives a fresh town (day 1) a rhythm in its first month', () => {
    const month = upcoming(1, 29).map((e) => `${e.day}:${e.kind}`);
    expect(month).toContain('5:market');
    expect(month).toContain('9:festival');
    expect(month).toContain('24:election');
  });

  it('every calendar event type is in the catalog, festivals in the festival family', () => {
    for (const id of FESTIVAL_IDS) {
      expect(WORLD_EVENTS[FESTIVALS[id].eventType]).toBeDefined();
      expect(eventFamily(FESTIVALS[id].eventType)).toBe('festival');
    }
    expect(eventFamily(ELECTION.eventType)).toBe('town_meeting');
    expect(eventFamily('storm')).toBe('storm');
  });

  it('picks the next highlight, preferring a festival over the weekly market', () => {
    expect(nextHighlight(7)).toMatchObject({ entry: { festivalId: 'spring_fair' }, inDays: 2 });
    expect(nextHighlight(3)).toMatchObject({ entry: { kind: 'market' }, inDays: 2 });
    expect(nextHighlight(13)).toBeNull();
    expect(whenPhrase(0)).toBe('today');
    expect(whenPhrase(1)).toBe('tomorrow');
    expect(whenPhrase(2)).toBe('in 2 days');
  });
});
