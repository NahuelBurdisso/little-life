/**
 * What the town should sound like right now, as plain numbers.
 *
 * Pure: world state in, target levels out — no Web Audio, no clock, no randomness. The canvas
 * AudioSystem feeds it ~10 times a second and hands the result to the synth, which glides its
 * beds toward these levels and paces its one-shot voices by them. Everything the ear notices
 * about the rules (birds only by day, crickets only on warm nights, the forge only while
 * someone works it, the tavern louder the closer the camera is) is decided and tested here.
 *
 * Levels are 0..1 "how present", not gains: the synth maps them onto its own mix, so the rules
 * can be read without knowing how loud a bird chirp is. Taste rules baked in:
 * - Sparse. A layer at 1 is "as much as it ever gets", and most sit well below.
 * - Weather drowns the small life: rain silences birds and thins the crickets.
 * - Places are heard where the camera is. A forge across the map is a faint tick; zoom in on
 *   it and it rings. Far zoom blends the whole town into a low bed.
 * - The player is watching, so their pauses are respected: a paused world goes quiet (room
 *   tone only), a night skip is heard through a closed window.
 */

import { DRAMA_BEAT_KIND, isDramaBeat } from '../../../server/data/dramaBeats';

// ── Inputs ───────────────────────────────────────────────────────────────────────────────────

export type PlaceSoundKind = 'forge' | 'tavern' | 'crowd';

/** One audible place: where it is (world px) and how busy (0..1). */
export interface PlaceSound {
  kind: PlaceSoundKind;
  x: number;
  y: number;
  busy: number;
}

/** The camera's visible world rect (same shape as the canvas `ViewRect`). */
export interface SoundView {
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
}

export interface SoundscapeInput {
  /** `world.weather`: sunny, cloudy, rainy, stormy, foggy, snowy, windy, hot. */
  weather: string;
  /** Fractional game hour, 0..24 (hour + minute / 60). */
  hour: number;
  season: string;
  /** Types of the active world events (festival, market_day, storm, funeral...). */
  events: readonly string[];
  places: readonly PlaceSound[];
  /** Null before the first frame: places are then heard as if from afar. */
  view: SoundView | null;
  /** The "skip to morning" fast-forward is running. */
  nightSkip: boolean;
  paused: boolean;
}

export interface SoundscapeLevels {
  rain: number;
  /** Drops pattering on eaves: part of the rain, paced separately so the bed never loops audibly. */
  drips: number;
  wind: number;
  /** Low storm rumble bed (thunder cracks follow the lightning, not this level). */
  storm: number;
  birds: number;
  crickets: number;
  crowd: number;
  /** -1 (left) .. 1 (right): where the loudest crowd is on screen. */
  crowdPan: number;
  forge: number;
  forgePan: number;
  /** Lute plucks from a lively tavern (or a festival on the square). */
  tavern: number;
  tavernPan: number;
  /** A barely-there hush that keeps a paused game from sounding broken. */
  roomTone: number;
  /** Whole-mix scale (0..1) on top of the player's volume. */
  master: number;
  /** 0 = open, 1 = heard through a wall (engine.setMuffle). */
  muffle: number;
  /** Scale for story and event cues (fights, bells, peals). */
  story: number;
}

export function createLevels(): SoundscapeLevels {
  return {
    rain: 0, drips: 0, wind: 0, storm: 0, birds: 0, crickets: 0,
    crowd: 0, crowdPan: 0, forge: 0, forgePan: 0, tavern: 0, tavernPan: 0,
    roomTone: 0, master: 1, muffle: 0, story: 1,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────────────────────

const clamp01 = (v: number): number => (v <= 0 ? 0 : v >= 1 ? 1 : v);

/** Linear ramp from 0 at `a` to 1 at `b` (either direction). */
function ramp(x: number, a: number, b: number): number {
  return clamp01((x - a) / (b - a));
}

/**
 * How present a sound at world (x, y) is for this camera: 1 at the centre of the screen,
 * about 0.55 at its edge, fading to 0 a screen-and-a-half away. Zooming in on a place makes
 * it fuller; at far zoom everything is a muted blend (0.45 cap) — you are over the town, not
 * in it. With no view yet, a flat distant 0.3.
 */
export function proximity(view: SoundView | null, x: number, y: number): number {
  if (!view || !(view.w > 0) || !(view.h > 0)) return 0.3;
  const cx = view.x + view.w / 2;
  const cy = view.y + view.h / 2;
  // Distance in "half-screens" (1 = the nearer screen edge along that axis).
  const dx = (x - cx) / (view.w / 2);
  const dy = (y - cy) / (view.h / 2);
  const d = Math.sqrt(dx * dx + dy * dy);
  let g: number;
  if (d <= 1) g = 1 - 0.45 * d;                 // on screen: 1 → 0.55
  else g = 0.55 * clamp01(1 - (d - 1) / 2);    // off screen: 0.55 → 0 over two more half-screens
  const s = view.scale;
  const zoom = s >= 1.6 ? 1.15 : s <= 0.6 ? 0.6 : 1;
  return clamp01(g * zoom);
}

/** Stereo position of world x for this camera: screen edges are ±0.7 (never hard-panned). */
export function panOf(view: SoundView | null, x: number): number {
  if (!view || !(view.w > 0)) return 0;
  const rel = (x - (view.x + view.w / 2)) / (view.w / 2);
  return Math.max(-0.7, Math.min(0.7, rel * 0.7));
}

// ── Weather tables ───────────────────────────────────────────────────────────────────────────

const RAIN: Readonly<Record<string, number>> = { rainy: 0.55, stormy: 0.85 };
const WIND: Readonly<Record<string, number>> = {
  sunny: 0.05, hot: 0.03, cloudy: 0.12, rainy: 0.2, stormy: 0.6, foggy: 0.04, snowy: 0.3, windy: 0.6,
};
/** How much of the day's birdsong each sky leaves. */
const BIRD_SKY: Readonly<Record<string, number>> = {
  sunny: 1, hot: 0.8, cloudy: 0.7, windy: 0.45, foggy: 0.4, snowy: 0.15, rainy: 0, stormy: 0,
};
const BIRD_SEASON: Readonly<Record<string, number>> = { spring: 1, summer: 0.85, autumn: 0.55, winter: 0.25 };
const CRICKET_SKY: Readonly<Record<string, number>> = {
  sunny: 1, hot: 1, cloudy: 0.8, windy: 0.5, foggy: 0.6, rainy: 0.15, snowy: 0, stormy: 0,
};
const CRICKET_SEASON: Readonly<Record<string, number>> = { summer: 1, spring: 0.55, autumn: 0.65, winter: 0 };

/** Events that fill the square with people, and how much. */
const CROWD_EVENTS: Readonly<Record<string, number>> = {
  festival: 0.4, market_day: 0.35, wedding: 0.3, competition: 0.3, fire_outbreak: 0.35, town_meeting: 0.15,
  traveling_merchant: 0.15, christening: 0.2,
  // The town calendar's days (server/data/calendar.ts). Listed by name rather
  // than read through the catalog's families: each has its own loudness — the
  // count is a murmur, Midsummer a full square.
  spring_fair: 0.4, midsummer: 0.45, harvest_festival: 0.4, winter_lights: 0.35, election_day: 0.3,
};
/** Events with music in the streets (the square gets plucks even with no tavern in view). */
const MUSIC_EVENTS: Readonly<Record<string, number>> = {
  festival: 0.5, wedding: 0.35, harvest: 0.2,
  spring_fair: 0.45, midsummer: 0.6, harvest_festival: 0.5, winter_lights: 0.4,
};

/**
 * Birds through the day: a dawn chorus (5–8h), quieter through the working day, a smaller
 * evening round, silent after dusk. The heat of a summer afternoon quietens them too.
 */
export function birdCurve(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h < 5 || h >= 20) return 0;
  if (h < 6) return ramp(h, 5, 6);
  if (h < 8) return 1;
  if (h < 9) return 1 - 0.45 * ramp(h, 8, 9);
  if (h < 17) return 0.55;
  if (h < 19) return 0.7;
  return 0.7 * (1 - ramp(h, 19, 20));
}

/** Crickets: rise through dusk (19:30–21h), full at night, gone by first light. */
export function cricketCurve(hour: number): number {
  const h = ((hour % 24) + 24) % 24;
  if (h >= 21 || h < 4) return 1;
  if (h >= 19.5) return ramp(h, 19.5, 21);
  if (h < 5) return 1 - ramp(h, 4, 5);
  return 0;
}

// ── The mapping ──────────────────────────────────────────────────────────────────────────────

/**
 * Target levels for `input`, written into `out` (reused by the caller ~10×/s so the steady
 * state allocates nothing).
 */
export function computeSoundscape(input: SoundscapeInput, out: SoundscapeLevels = createLevels()): SoundscapeLevels {
  const { weather, season, view } = input;
  const hour = Number.isFinite(input.hour) ? input.hour : 12;

  let stormEvent = false, heat = false, starry = false;
  let crowdBoost = 0, musicBoost = 0;
  for (const e of input.events) {
    if (e === 'storm') stormEvent = true;
    else if (e === 'heatwave') heat = true;
    else if (e === 'starry_night' || e === 'full_moon') starry = true;
    crowdBoost = Math.max(crowdBoost, CROWD_EVENTS[e] ?? 0);
    musicBoost = Math.max(musicBoost, MUSIC_EVENTS[e] ?? 0);
  }
  const stormy = weather === 'stormy' || stormEvent;

  // Weather beds.
  out.rain = stormy ? Math.max(RAIN.stormy, RAIN[weather] ?? 0) : RAIN[weather] ?? 0;
  out.drips = out.rain > 0 ? clamp01(0.3 + out.rain * 0.6) : 0;
  const winterChill = season === 'winter' ? 0.08 : 0;
  out.wind = clamp01((stormy ? Math.max(WIND.stormy, WIND[weather] ?? 0) : WIND[weather] ?? WIND.sunny) + winterChill);
  out.storm = stormy ? 0.6 : 0;

  // Small life.
  const afternoonHeat = (weather === 'hot' || heat) && hour >= 13 && hour < 16 ? 0.5 : 1;
  out.birds = stormy ? 0 : clamp01(birdCurve(hour) * (BIRD_SKY[weather] ?? 0.7) * (BIRD_SEASON[season] ?? 0.8) * afternoonHeat);
  const starBoost = starry ? 1.2 : 1;
  out.crickets = stormy ? 0 : clamp01(cricketCurve(hour) * (CRICKET_SKY[weather] ?? 0.6) * (CRICKET_SEASON[season] ?? 0.5) * starBoost);

  // Places, by what the camera is near. Several busy places of a kind combine like
  // independent sources (1 - Π(1 - p)) so two taverns are fuller than one but never over 1;
  // the pan follows the loudest one.
  let crowdQuiet = 1, forgeQuiet = 1, tavernQuiet = 1;
  let crowdBest = 0, forgeBest = 0, tavernBest = 0;
  let crowdPan = 0, forgePan = 0, tavernPan = 0;
  for (const p of input.places) {
    const busy = clamp01(p.busy);
    if (busy <= 0) continue;
    const near = proximity(view, p.x, p.y);
    const v = busy * near;
    if (v <= 0) continue;
    if (p.kind === 'crowd') {
      crowdQuiet *= 1 - v;
      if (v > crowdBest) { crowdBest = v; crowdPan = panOf(view, p.x); }
    } else if (p.kind === 'forge') {
      forgeQuiet *= 1 - v;
      if (v > forgeBest) { forgeBest = v; forgePan = panOf(view, p.x); }
    } else if (p.kind === 'tavern') {
      tavernQuiet *= 1 - v;
      if (v > tavernBest) { tavernBest = v; tavernPan = panOf(view, p.x); }
    }
  }
  // Rain drives people indoors and drowns the street; it doesn't stop the forge.
  const wet = out.rain > 0 ? 0.6 : 1;
  out.crowd = clamp01((1 - crowdQuiet) * 0.8 * wet + crowdBoost * wet);
  out.crowdPan = crowdPan;
  out.forge = clamp01(1 - forgeQuiet);
  out.forgePan = forgePan;
  out.tavern = clamp01((1 - tavernQuiet) + musicBoost * wet);
  out.tavernPan = tavernBest > 0 ? tavernPan : 0;

  out.roomTone = 0;
  out.master = 1;
  out.muffle = 0;
  out.story = 1;

  if (input.nightSkip) {
    // Hours fly by at 30x: the town is heard through the bedroom window, softly, and the
    // one-shot layers thin out so the fast clock doesn't turn them into a barrage.
    out.master = 0.55;
    out.muffle = 0.8;
    out.story = 0.5;
  }

  if (input.paused) {
    // A paused world is a held breath: every layer out, only the room.
    out.rain = out.drips = out.wind = out.storm = out.birds = out.crickets = 0;
    out.crowd = out.forge = out.tavern = 0;
    out.roomTone = 0.35;
    out.muffle = 0.3;
    out.story = 0;
  }
  return out;
}

// ── Bells on the hour ───────────────────────────────────────────────────────────────────────

/**
 * The town-hall bell tolls three times a day: morning (7), noon (12) and evening (18). Tolls
 * are capped at a handful — "twelve bongs at noon" is charming once and grating by day three.
 */
export const BELL_HOURS: Readonly<Record<number, number>> = { 7: 2, 12: 3, 18: 2 };

/**
 * How many tolls to ring when the clock moves from `prev` to `next` (fractional hours): the
 * count of the bell hour crossed, 0 if none. A jump of more than two hours (page load, world
 * replace, a night skip's leap) crosses nothing — it didn't *pass*, it arrived.
 */
export function tollsBetween(prev: number | null, next: number): number {
  if (prev == null || !Number.isFinite(prev) || !Number.isFinite(next)) return 0;
  let delta = next - prev;
  if (delta < 0) delta += 24;           // past midnight
  if (delta <= 0 || delta > 2) return 0;
  const start = Math.floor(prev) + 1;
  const end = Math.floor(prev + delta);
  for (let h = start; h <= end; h++) {
    const count = BELL_HOURS[h % 24];
    if (count) return count;
  }
  return 0;
}

// ── Story cues ──────────────────────────────────────────────────────────────────────────────

/**
 * The little musical/foley phrases a story moment gets:
 * - scuffle: two dull thumps (fight, insult, snap)
 * - romance: rising lute arpeggio (date, flirt, reconciliation)
 * - engaged: romance + a small hand-bell
 * - peal: wedding bells, a descending round
 * - sad: slow falling minor plucks (breakup, estrangement)
 * - whisper: a soft breathy swish (confession)
 * - sneak: three quiet low plucks stepping down (theft)
 * - clang: a cell door (arrest)
 * - knell: a slow, low, distant bell (death, funeral)
 * - cheer: a quick bright arpeggio (birthday)
 * - lullaby: a soft high chime, rocking between two notes (a birth, a christening)
 * - alarm: fast bell (fire)
 * - tolls: a few plain town-hall tolls (town meeting)
 */
export type StoryCue =
  | 'scuffle' | 'romance' | 'engaged' | 'peal' | 'sad' | 'whisper' | 'sneak'
  | 'clang' | 'knell' | 'cheer' | 'alarm' | 'tolls' | 'lullaby';

/** Beat subtype → cue. Gossip is left silent on purpose: it is the most common row by far. */
const BEAT_CUE: Readonly<Record<string, StoryCue | null>> = {
  fight: 'scuffle', insult: 'scuffle', snap: 'scuffle',
  date: 'romance', flirt: 'romance', reconciliation: 'romance',
  confession: 'whisper', gossip: null,
  breakup: 'sad', estrangement: 'sad',
  arrest: 'clang', death: 'knell', birthday: 'cheer',
  theft: 'sneak',
  // Family (server/lib/family.ts): a newborn gets its own soft chime, not the
  // birthday's bright arpeggio; a father learning it isn't his is heartbreak.
  birth: 'lullaby', paternity: 'sad',
  contest_win: 'cheer',
};

/** Row types that carry their own cue regardless of `metadata.beat`. */
const TYPE_CUE: Readonly<Record<string, StoryCue>> = {
  wedding: 'peal', engagement: 'engaged',
  // The mayor's name read out on the square: the town-hall bell.
  election_result: 'tolls',
};

export interface StoryRow {
  id: number;
  type?: string;
  metadata?: { beat?: unknown } | null;
  agent_ids?: number[] | null;
  initiator_id?: number | null;
  target_id?: number | null;
  real_timestamp?: number;
}

/** The cue an activity row plays, or null for the (vast) majority that play nothing. */
export function storyCueOf(row: StoryRow): StoryCue | null {
  const t = row.type ? TYPE_CUE[row.type] : undefined;
  if (t) return t;
  const beat = row.metadata?.beat;
  if (isDramaBeat(beat)) {
    // Every tagged subtype is in BEAT_CUE; the kind table is the fallback for a future one.
    if (beat in BEAT_CUE) return BEAT_CUE[beat];
    const kind = DRAMA_BEAT_KIND[beat];
    return kind === 'fight' ? 'scuffle' : kind === 'romance' ? 'romance' : null;
  }
  return null;
}

/** World events that announce themselves when they start. */
const EVENT_CUE: Readonly<Record<string, StoryCue>> = {
  funeral: 'knell', town_meeting: 'tolls', fire_outbreak: 'alarm', festival: 'cheer', christening: 'lullaby',
  spring_fair: 'cheer', midsummer: 'cheer', harvest_festival: 'cheer', winter_lights: 'cheer', election_day: 'tolls',
};

export function eventCueOf(type: string | undefined): StoryCue | null {
  return (type && EVENT_CUE[type]) || null;
}

/** Rows older than this (wall clock) are history: a tab coming back must not replay them. */
export const STORY_MAX_AGE_MS = 60_000;

export interface StoryWatch {
  /** Newest activity id already heard; null until the first non-empty poll. */
  watermark: number | null;
}

/**
 * New rows since the last call, oldest first, that are fresh enough to play. The first
 * non-empty poll only sets the watermark (a page load must not replay the backlog). A newest
 * id *below* the watermark means the world was replaced and ids restarted: re-arm silently.
 */
export function takeNewRows<T extends StoryRow>(watch: StoryWatch, rows: readonly T[], nowMs: number): T[] {
  if (rows.length === 0) return [];
  let newest = -Infinity;
  for (const r of rows) if (r.id > newest) newest = r.id;
  if (watch.watermark == null || newest < watch.watermark) {
    watch.watermark = newest;
    return [];
  }
  const fresh: T[] = [];
  for (const r of rows) {
    if (r.id <= watch.watermark) continue;
    if (typeof r.real_timestamp === 'number' && nowMs - r.real_timestamp > STORY_MAX_AGE_MS) continue;
    fresh.push(r);
  }
  watch.watermark = newest;
  fresh.sort((a, b) => a.id - b.id);
  return fresh;
}

// ── God powers ──────────────────────────────────────────────────────────────────────────────

/**
 * - sparkle: a rising glitter of tiny bells (planting a thought, a feeling, a secret)
 * - whoosh: air moving (sending someone somewhere, weather, removing someone)
 * - coins: a purse's clink (give_money)
 * - nudge: one soft pluck (a plain suggestion, introductions, events)
 * - fanfare: a rising arpeggio capped by a bell (a challenge completed, an achievement) —
 *   not tied to an intervention kind, played for the canvas bus's `celebrate`
 */
export type GodCue = 'sparkle' | 'whoosh' | 'coins' | 'nudge' | 'fanfare';

const GOD_CUE: Readonly<Record<string, GodCue>> = {
  whisper_thought: 'sparkle', stir_feeling: 'sparkle', tell_secret: 'sparkle', start_rumor: 'sparkle',
  suggest_go_to: 'whoosh', remove_agent: 'whoosh', weather: 'whoosh',
  give_money: 'coins',
  suggest_talk: 'nudge', force_confront: 'nudge', introduce_agent: 'nudge', event: 'nudge',
};

/** Cue for a canvas-bus intervention kind; an unknown kind gets the plain nudge. */
export function godCueOf(kind: string): GodCue {
  return GOD_CUE[kind] ?? 'nudge';
}

// ── Alert chimes ─────────────────────────────────────────────────────────────────────────────

export type ChimeTier = 'player' | 'major' | 'minor';

/** Minimum gap between two chimes; within it only a higher tier gets through. */
export const CHIME_GAP_MS = 1500;
const TIER_RANK: Readonly<Record<ChimeTier, number>> = { minor: 0, major: 1, player: 2 };

export interface ChimeGate { lastAt: number; lastRank: number }

export function createChimeGate(): ChimeGate {
  return { lastAt: -Infinity, lastRank: -1 };
}

/**
 * Whether a chime of `tier` may ring at `nowMs`. A cascade can land a dozen alerts in one
 * poll; the player should hear one chime (the most important), not a xylophone run.
 */
export function chimeAllowed(gate: ChimeGate, tier: ChimeTier, nowMs: number): boolean {
  const rank = TIER_RANK[tier] ?? 0;
  if (nowMs - gate.lastAt < CHIME_GAP_MS && rank <= gate.lastRank) return false;
  gate.lastAt = nowMs;
  gate.lastRank = rank;
  return true;
}
