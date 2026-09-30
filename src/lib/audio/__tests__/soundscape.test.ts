import { describe, it, expect } from 'vitest';
import {
  birdCurve, chimeAllowed, CHIME_GAP_MS, computeSoundscape, createChimeGate, createLevels, cricketCurve,
  eventCueOf, godCueOf, panOf, proximity, storyCueOf, STORY_MAX_AGE_MS, takeNewRows, tollsBetween,
  type PlaceSound, type SoundscapeInput, type SoundView, type StoryWatch,
} from '../soundscape';

const view = (over: Partial<SoundView> = {}): SoundView => ({ x: 0, y: 0, w: 1000, h: 600, scale: 1, ...over });

const input = (over: Partial<SoundscapeInput> = {}): SoundscapeInput => ({
  weather: 'sunny', hour: 10, season: 'summer', events: [], places: [], view: view(), nightSkip: false, paused: false,
  ...over,
});

const at = (over: Partial<SoundscapeInput> = {}) => computeSoundscape(input(over));

describe('proximity', () => {
  it('is full at the screen centre and softer toward the edge', () => {
    const v = view();
    expect(proximity(v, 500, 300)).toBeCloseTo(1);
    expect(proximity(v, 1000, 300)).toBeCloseTo(0.55);
    expect(proximity(v, 750, 300)).toBeGreaterThan(proximity(v, 1000, 300));
  });

  it('fades to silence a screen and a half away', () => {
    const v = view();
    expect(proximity(v, 1500, 300)).toBeGreaterThan(0);
    expect(proximity(v, 2000, 300)).toBe(0);
    expect(proximity(v, -5000, -5000)).toBe(0);
  });

  it('is fuller zoomed in and a muted blend zoomed out', () => {
    expect(proximity(view({ scale: 2 }), 750, 300)).toBeGreaterThan(proximity(view(), 750, 300));
    expect(proximity(view({ scale: 0.5 }), 500, 300)).toBeCloseTo(0.6);
    expect(proximity(view({ scale: 3 }), 500, 300)).toBeLessThanOrEqual(1);
  });

  it('hears everything faintly without a camera yet', () => {
    expect(proximity(null, 123, 456)).toBe(0.3);
    expect(proximity(view({ w: 0 }), 0, 0)).toBe(0.3);
  });
});

describe('panOf', () => {
  it('follows the screen x and never pans hard', () => {
    const v = view();
    expect(panOf(v, 500)).toBeCloseTo(0);
    expect(panOf(v, 0)).toBeCloseTo(-0.7);
    expect(panOf(v, 1000)).toBeCloseTo(0.7);
    expect(panOf(v, 99999)).toBe(0.7);
    expect(panOf(null, 99999)).toBe(0);
  });
});

describe('day curves', () => {
  it('birds: dawn chorus loudest, silent at night', () => {
    expect(birdCurve(3)).toBe(0);
    expect(birdCurve(22)).toBe(0);
    expect(birdCurve(5.5)).toBeCloseTo(0.5);
    expect(birdCurve(7)).toBe(1);
    expect(birdCurve(12)).toBeLessThan(birdCurve(7));
    expect(birdCurve(18)).toBeGreaterThan(birdCurve(12));
    expect(birdCurve(19.5)).toBeLessThan(birdCurve(18));
  });

  it('crickets: through the night, not by day', () => {
    expect(cricketCurve(12)).toBe(0);
    expect(cricketCurve(23)).toBe(1);
    expect(cricketCurve(2)).toBe(1);
    expect(cricketCurve(20.25)).toBeCloseTo(0.5);
    expect(cricketCurve(4.5)).toBeCloseTo(0.5);
    expect(cricketCurve(6)).toBe(0);
  });

  it('wraps odd hours', () => {
    expect(birdCurve(31)).toBe(birdCurve(7));
    expect(cricketCurve(-1)).toBe(cricketCurve(23));
  });
});

describe('computeSoundscape — weather', () => {
  it('a sunny morning: birds, a breath of wind, no rain', () => {
    const l = at({ hour: 7 });
    expect(l.birds).toBeGreaterThan(0.5);
    expect(l.rain).toBe(0);
    expect(l.drips).toBe(0);
    expect(l.storm).toBe(0);
    expect(l.wind).toBeGreaterThan(0);
    expect(l.wind).toBeLessThan(0.15);
    expect(l.crickets).toBe(0);
  });

  it('rain silences the birds and brings drips', () => {
    const l = at({ weather: 'rainy', hour: 7 });
    expect(l.rain).toBeGreaterThan(0.4);
    expect(l.drips).toBeGreaterThan(0);
    expect(l.birds).toBe(0);
    expect(l.storm).toBe(0);
  });

  it('a storm: heavier rain, wind, rumble, no small life', () => {
    const storm = at({ weather: 'stormy', hour: 22 });
    const rain = at({ weather: 'rainy', hour: 22 });
    expect(storm.rain).toBeGreaterThan(rain.rain);
    expect(storm.wind).toBeGreaterThan(rain.wind);
    expect(storm.storm).toBeGreaterThan(0);
    expect(storm.crickets).toBe(0);
  });

  it('a storm event counts as a storm under any sky', () => {
    const l = at({ weather: 'cloudy', events: ['storm'] });
    expect(l.storm).toBeGreaterThan(0);
    expect(l.rain).toBeGreaterThan(0);
  });

  it('wind is the point of a windy day, and winter adds a chill', () => {
    expect(at({ weather: 'windy' }).wind).toBeGreaterThan(at({ weather: 'cloudy' }).wind);
    expect(at({ season: 'winter' }).wind).toBeGreaterThan(at({ season: 'summer' }).wind);
  });

  it('snow: quiet, few birds, no rain', () => {
    const l = at({ weather: 'snowy', season: 'winter', hour: 7 });
    expect(l.rain).toBe(0);
    expect(l.birds).toBeLessThan(0.1);
    expect(l.wind).toBeGreaterThan(0.2);
  });

  it('an unknown weather string falls back to a calm day', () => {
    const l = at({ weather: 'volcanic' });
    expect(l.rain).toBe(0);
    expect(l.wind).toBeGreaterThan(0);
    expect(Number.isFinite(l.birds)).toBe(true);
  });
});

describe('computeSoundscape — seasons and nights', () => {
  it('crickets sing on summer nights, not in winter', () => {
    expect(at({ hour: 23, season: 'summer' }).crickets).toBeGreaterThan(0.8);
    expect(at({ hour: 23, season: 'winter' }).crickets).toBe(0);
    expect(at({ hour: 23, season: 'spring' }).crickets).toBeLessThan(at({ hour: 23, season: 'summer' }).crickets);
  });

  it('rain thins the crickets', () => {
    expect(at({ hour: 23, weather: 'rainy' }).crickets).toBeLessThan(at({ hour: 23 }).crickets * 0.3);
  });

  it('a starry night is fuller (capped at 1)', () => {
    const l = at({ hour: 23, events: ['starry_night'] });
    expect(l.crickets).toBe(1);
  });

  it('spring mornings have more birds than winter ones', () => {
    expect(at({ hour: 7, season: 'spring' }).birds).toBeGreaterThan(at({ hour: 7, season: 'winter' }).birds * 2);
  });

  it('a hot afternoon quiets the birds', () => {
    expect(at({ hour: 14, weather: 'hot' }).birds).toBeLessThan(at({ hour: 11, weather: 'hot' }).birds);
    expect(at({ hour: 14, events: ['heatwave'] }).birds).toBeLessThan(at({ hour: 14 }).birds);
  });

  it('survives a missing hour', () => {
    const l = at({ hour: Number.NaN });
    expect(Number.isFinite(l.birds)).toBe(true);
  });
});

describe('computeSoundscape — places near the camera', () => {
  const forge = (x: number, busy = 1): PlaceSound => ({ kind: 'forge', x, y: 300, busy });

  it('nothing busy, nothing heard', () => {
    const l = at();
    expect(l.forge).toBe(0);
    expect(l.crowd).toBe(0);
    expect(l.tavern).toBe(0);
  });

  it('a forge on screen rings, one across the map barely', () => {
    const near = at({ places: [forge(500)] });
    const far = at({ places: [forge(1800)] });
    const gone = at({ places: [forge(9000)] });
    expect(near.forge).toBeGreaterThan(0.9);
    expect(far.forge).toBeGreaterThan(0);
    expect(far.forge).toBeLessThan(0.3);
    expect(gone.forge).toBe(0);
  });

  it('pans toward the loudest source', () => {
    expect(at({ places: [forge(900)] }).forgePan).toBeGreaterThan(0.4);
    expect(at({ places: [forge(100)] }).forgePan).toBeLessThan(-0.4);
    expect(at({ places: [forge(100, 0.3), forge(900, 1)] }).forgePan).toBeGreaterThan(0);
  });

  it('two busy taverns are fuller than one but never over 1', () => {
    const one = at({ places: [{ kind: 'crowd', x: 400, y: 300, busy: 0.5 }] });
    const two = at({ places: [{ kind: 'crowd', x: 400, y: 300, busy: 0.5 }, { kind: 'crowd', x: 600, y: 300, busy: 0.5 }] });
    expect(two.crowd).toBeGreaterThan(one.crowd);
    const many = at({ places: Array.from({ length: 10 }, (_, i) => ({ kind: 'crowd' as const, x: 500, y: 300 + i, busy: 1 })) });
    expect(many.crowd).toBeLessThanOrEqual(1);
  });

  it('busier is louder', () => {
    const quiet = at({ places: [{ kind: 'crowd', x: 500, y: 300, busy: 0.3 }] });
    const loud = at({ places: [{ kind: 'crowd', x: 500, y: 300, busy: 1 }] });
    expect(loud.crowd).toBeGreaterThan(quiet.crowd);
  });

  it('tavern music is its own layer', () => {
    const l = at({ places: [{ kind: 'tavern', x: 500, y: 300, busy: 1 }] });
    expect(l.tavern).toBeGreaterThan(0.9);
    expect(l.crowd).toBe(0);
  });

  it('rain drives the street crowd indoors but not the forge', () => {
    const places: PlaceSound[] = [{ kind: 'crowd', x: 500, y: 300, busy: 1 }, forge(500)];
    expect(at({ places, weather: 'rainy' }).crowd).toBeLessThan(at({ places }).crowd);
    expect(at({ places, weather: 'rainy' }).forge).toBe(at({ places }).forge);
  });

  it('festivals and markets fill the town with voices and music', () => {
    const fest = at({ events: ['festival'] });
    expect(fest.crowd).toBeGreaterThan(0.3);
    expect(fest.tavern).toBeGreaterThan(0.3);
    expect(at({ events: ['market_day'] }).crowd).toBeGreaterThan(0.3);
    expect(at({ events: ['market_day'] }).tavern).toBe(0);
  });
});

describe('computeSoundscape — playback', () => {
  const busy: PlaceSound[] = [{ kind: 'crowd', x: 500, y: 300, busy: 1 }, { kind: 'forge', x: 500, y: 300, busy: 1 }];

  it('a running game is open and at full scale', () => {
    const l = at({ places: busy });
    expect(l.master).toBe(1);
    expect(l.muffle).toBe(0);
    expect(l.story).toBe(1);
    expect(l.roomTone).toBe(0);
  });

  it('paused: every layer out, only a low room tone', () => {
    const l = at({ paused: true, weather: 'stormy', hour: 23, places: busy, events: ['festival'] });
    for (const k of ['rain', 'drips', 'wind', 'storm', 'birds', 'crickets', 'crowd', 'forge', 'tavern'] as const) {
      expect(l[k], k).toBe(0);
    }
    expect(l.roomTone).toBeGreaterThan(0);
    expect(l.roomTone).toBeLessThan(0.5);
    expect(l.story).toBe(0);
  });

  it('night skip: quieter and muffled, layers kept', () => {
    const l = at({ nightSkip: true, hour: 23, places: busy });
    expect(l.master).toBeLessThan(0.7);
    expect(l.muffle).toBeGreaterThan(0.5);
    expect(l.story).toBeLessThan(1);
    expect(l.crickets).toBeGreaterThan(0);
    expect(l.crowd).toBeGreaterThan(0);
  });

  it('resets per call: an out object reused after a pause comes back open', () => {
    const out = createLevels();
    computeSoundscape(input({ paused: true }), out);
    computeSoundscape(input({ nightSkip: true }), out);
    computeSoundscape(input({ hour: 7 }), out);
    expect(out.roomTone).toBe(0);
    expect(out.muffle).toBe(0);
    expect(out.master).toBe(1);
    expect(out.birds).toBeGreaterThan(0);
  });

  it('every level stays within 0..1 (pans within -1..1) across the whole matrix', () => {
    const weathers = ['sunny', 'cloudy', 'rainy', 'stormy', 'foggy', 'snowy', 'windy', 'hot', '???'];
    const seasons = ['spring', 'summer', 'autumn', 'winter'];
    const places: PlaceSound[] = [
      { kind: 'crowd', x: 0, y: 0, busy: 5 }, { kind: 'forge', x: 1200, y: 0, busy: 1 }, { kind: 'tavern', x: -300, y: 900, busy: 1 },
    ];
    for (const weather of weathers) for (const season of seasons) for (let hour = 0; hour < 24; hour += 1.5) {
      const l = at({ weather, season, hour, places, events: ['festival', 'storm', 'starry_night'] });
      for (const [k, v] of Object.entries(l)) {
        const lo = k.endsWith('Pan') ? -1 : 0;
        expect(v, `${weather}/${season}/${hour}/${k}`).toBeGreaterThanOrEqual(lo);
        expect(v, `${weather}/${season}/${hour}/${k}`).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('tollsBetween', () => {
  it('rings when the clock passes a bell hour', () => {
    expect(tollsBetween(11.9, 12.05)).toBe(3);
    expect(tollsBetween(6.95, 7)).toBe(2);
    expect(tollsBetween(17.5, 18.5)).toBe(2);
  });

  it('stays quiet between bell hours and on the first reading', () => {
    expect(tollsBetween(12.05, 12.2)).toBe(0);
    expect(tollsBetween(9, 10)).toBe(0);
    expect(tollsBetween(null, 12)).toBe(0);
    expect(tollsBetween(12, 12)).toBe(0);
  });

  it('a leap (load, world replace, going backwards) is arriving, not passing', () => {
    expect(tollsBetween(3, 12)).toBe(0);
    expect(tollsBetween(12.5, 11.5)).toBe(0);
  });

  it('handles midnight', () => {
    expect(tollsBetween(23.5, 0.5)).toBe(0);
    expect(tollsBetween(Number.NaN, 12)).toBe(0);
  });
});

describe('storyCueOf', () => {
  const row = (over: object) => ({ id: 1, type: 'drama', ...over });

  it('maps drama beats', () => {
    expect(storyCueOf(row({ metadata: { beat: 'fight' } }))).toBe('scuffle');
    expect(storyCueOf(row({ metadata: { beat: 'snap' } }))).toBe('scuffle');
    expect(storyCueOf(row({ metadata: { beat: 'date' } }))).toBe('romance');
    expect(storyCueOf(row({ metadata: { beat: 'reconciliation' } }))).toBe('romance');
    expect(storyCueOf(row({ metadata: { beat: 'breakup' } }))).toBe('sad');
    expect(storyCueOf(row({ metadata: { beat: 'theft' } }))).toBe('sneak');
    expect(storyCueOf(row({ metadata: { beat: 'arrest' } }))).toBe('clang');
    expect(storyCueOf(row({ metadata: { beat: 'death' } }))).toBe('knell');
    expect(storyCueOf(row({ metadata: { beat: 'birthday' } }))).toBe('cheer');
    expect(storyCueOf(row({ metadata: { beat: 'confession' } }))).toBe('whisper');
    expect(storyCueOf(row({ metadata: { beat: 'birth' } }))).toBe('lullaby');
    expect(storyCueOf(row({ metadata: { beat: 'paternity' } }))).toBe('sad');
  });

  it('leaves gossip, untagged and unknown rows silent', () => {
    expect(storyCueOf(row({ metadata: { beat: 'gossip' } }))).toBeNull();
    expect(storyCueOf(row({}))).toBeNull();
    expect(storyCueOf(row({ metadata: { beat: 'dance-off' } }))).toBeNull();
    expect(storyCueOf(row({ metadata: null }))).toBeNull();
    expect(storyCueOf({ id: 2 })).toBeNull();
  });

  it('weddings and engagements go by row type', () => {
    expect(storyCueOf({ id: 3, type: 'wedding' })).toBe('peal');
    expect(storyCueOf({ id: 4, type: 'engagement' })).toBe('engaged');
  });
});

describe('eventCueOf / godCueOf', () => {
  it('announces some events as they start', () => {
    expect(eventCueOf('funeral')).toBe('knell');
    expect(eventCueOf('christening')).toBe('lullaby');
    expect(eventCueOf('fire_outbreak')).toBe('alarm');
    expect(eventCueOf('town_meeting')).toBe('tolls');
    expect(eventCueOf('sickness')).toBeNull();
    expect(eventCueOf(undefined)).toBeNull();
  });

  it('gives every intervention kind a sound, unknown ones the plain nudge', () => {
    expect(godCueOf('whisper_thought')).toBe('sparkle');
    expect(godCueOf('stir_feeling')).toBe('sparkle');
    expect(godCueOf('suggest_go_to')).toBe('whoosh');
    expect(godCueOf('weather')).toBe('whoosh');
    expect(godCueOf('give_money')).toBe('coins');
    expect(godCueOf('suggest_talk')).toBe('nudge');
    expect(godCueOf('something_new')).toBe('nudge');
  });
});

describe('takeNewRows', () => {
  const now = 1_000_000;
  const r = (id: number, ageMs = 0) => ({ id, real_timestamp: now - ageMs });

  it('the first poll only sets the watermark', () => {
    const w: StoryWatch = { watermark: null };
    expect(takeNewRows(w, [r(5), r(4)], now)).toEqual([]);
    expect(w.watermark).toBe(5);
  });

  it('an empty poll changes nothing', () => {
    const w: StoryWatch = { watermark: null };
    expect(takeNewRows(w, [], now)).toEqual([]);
    expect(w.watermark).toBeNull();
  });

  it('returns only newer rows, oldest first', () => {
    const w: StoryWatch = { watermark: 5 };
    expect(takeNewRows(w, [r(8), r(7), r(5), r(4)], now).map((x) => x.id)).toEqual([7, 8]);
    expect(w.watermark).toBe(8);
    expect(takeNewRows(w, [r(8), r(7)], now)).toEqual([]);
  });

  it('skips stale rows (a tab coming back) but still advances', () => {
    const w: StoryWatch = { watermark: 1 };
    expect(takeNewRows(w, [r(3, STORY_MAX_AGE_MS + 1), r(2)], now).map((x) => x.id)).toEqual([2]);
    expect(w.watermark).toBe(3);
  });

  it('re-arms silently when ids restart (world replaced)', () => {
    const w: StoryWatch = { watermark: 900 };
    expect(takeNewRows(w, [r(3), r(2)], now)).toEqual([]);
    expect(w.watermark).toBe(3);
    expect(takeNewRows(w, [r(4), r(3)], now).map((x) => x.id)).toEqual([4]);
  });
});

describe('chime gate', () => {
  it('one chime per burst, unless a more important one follows', () => {
    const g = createChimeGate();
    expect(chimeAllowed(g, 'minor', 0)).toBe(true);
    expect(chimeAllowed(g, 'minor', 100)).toBe(false);
    expect(chimeAllowed(g, 'major', 200)).toBe(true);
    expect(chimeAllowed(g, 'major', 300)).toBe(false);
    expect(chimeAllowed(g, 'player', 400)).toBe(true);
    expect(chimeAllowed(g, 'minor', 500)).toBe(false);
  });

  it('opens again after the gap', () => {
    const g = createChimeGate();
    expect(chimeAllowed(g, 'player', 0)).toBe(true);
    expect(chimeAllowed(g, 'minor', CHIME_GAP_MS + 1)).toBe(true);
  });
});
