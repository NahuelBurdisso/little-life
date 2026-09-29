import { audio } from "../../../../lib/audio/engine";
import {
  computeSoundscape, createLevels, eventCueOf, panOf, proximity, storyCueOf, takeNewRows, tollsBetween, godCueOf,
  type SoundscapeInput, type SoundView, type StoryCue, type StoryWatch,
} from "../../../../lib/audio/soundscape";
import { getSynth, Pacer, type BedLevels } from "../../../../lib/audio/synth";
import { onCanvasEvent } from "../../../../lib/canvasBus";
import { UI_MAX_SPEED } from "../../playbackLabel";
import { computePlaceStates, readClimate } from "../placeLife/placeState";
import type { CanvasSystem, DataContext, FrameContext, SystemFactory } from "../types";
import { buildAudioPlaces } from "./audioPlaces";

/**
 * The town's soundscape: weather, time of day, busy places near the camera, story moments and
 * the player's own hand, turned into sound. Draws nothing.
 *
 * - `onData` (each poll) reads the world into a `SoundscapeInput`, works out which places are
 *   making noise (`audioPlaces`), and queues cues for what is *new*: activity rows by their
 *   drama beat or type (fights thump, dates pluck, weddings peal, a death tolls), world
 *   events as they start, the town-hall bell as the clock passes 7, 12 and 18.
 * - `update` runs every frame but works ten times a second: the pure `computeSoundscape`
 *   turns the input plus the current camera rect into levels, the synth glides its beds
 *   there, and pacers fire the sparse layers (birds, crickets, drips, forge, lute) at random
 *   intervals scaled by their level. Story cues drain from a short queue one at a time so a
 *   burst of rows is a sequence, not a pile-up.
 * - Canvas bus: lightning (LightingSystem) rolls thunder a random second or two later; the
 *   player's interventions get their sparkle / whoosh / coins.
 *
 * Silence is the default: before the first click, while muted, or in a hidden tab the synth
 * is null and every path returns early — nothing is queued up to play all at once later.
 */

const TICK_S = 0.1;
/** Seconds between two story cues, so a burst of rows plays as a sequence. */
const STORY_SPACING_S = 1.3;
const STORY_QUEUE_MAX = 4;
/** A cue far off screen is still heard (it is news), just from across town. */
const STORY_MIN_GAIN = 0.4;

interface QueuedCue { cue: StoryCue; gain: number; pan: number }

class AudioSystem implements CanvasSystem {
  private readonly input: SoundscapeInput = {
    weather: 'sunny', hour: 12, season: 'spring', events: [], places: [], view: null, nightSkip: false, paused: false,
  };
  private readonly eventTypes: string[] = [];
  private readonly view: SoundView = { x: 0, y: 0, w: 0, h: 0, scale: 1 };
  private readonly levels = createLevels();
  private readonly beds: BedLevels = { rain: 0, wind: 0, storm: 0, crowd: 0, crowdPan: 0, roomTone: 0 };
  private acc = 0;
  private hasData = false;

  private readonly birds = new Pacer(2.5, 7);
  private readonly crickets = new Pacer(1.2, 3.2);
  private readonly drips = new Pacer(0.35, 1.4);
  private readonly forge = new Pacer(2.5, 6.5);
  private readonly tavern = new Pacer(2.2, 5.5);

  private lastHour: number | null = null;
  private readonly watch: StoryWatch = { watermark: null };
  private seenEvents: Set<number> | null = null;
  private readonly queue: QueuedCue[] = [];
  private nextStoryAt = 0;
  private townHall: { x: number; y: number } | null = null;
  private readonly agentPos = new Map<number, { x: number; y: number }>();

  private lastMuffle = -1;
  private lastMaster = -1;
  private readonly offReady: () => void;
  private readonly offBus: () => void;

  constructor() {
    audio.install();
    // Build the synth (its rendered buffers) right when the context comes alive, inside the
    // unlocking click, instead of on some later frame.
    this.offReady = audio.onReady(() => { getSynth(); });
    // Dev probe (docs/scratch probes, the browser console): context state, voices, levels.
    if (import.meta.env?.DEV && typeof window !== 'undefined') {
      (window as unknown as Record<string, unknown>).__audio = { engine: audio, synth: getSynth, levels: this.levels, system: this };
    }
    this.offBus = onCanvasEvent((e) => {
      if (e.type === 'lightning') this.thunder(e.strength);
      else if (e.type === 'intervention') this.god(e.kind);
    });
  }

  // ── Data ──────────────────────────────────────────────────────────────────────────────────

  onData(data: DataContext): void {
    const w = data.world;
    if (!w) return;
    const inp = this.input;
    inp.weather = w.weather ?? 'sunny';
    const hour = typeof w.time?.hour === 'number' ? w.time.hour + (w.time.minute ?? 0) / 60 : 12;
    inp.hour = hour;
    inp.season = w.time?.season ?? 'spring';
    inp.paused = Boolean(w.is_paused);
    // Above the fastest speed button the sim is skipping the night (playbackLabel.ts).
    inp.nightSkip = (w.tick_speed ?? 1) > UI_MAX_SPEED;
    this.eventTypes.length = 0;
    for (const e of data.events ?? []) if (e?.type) this.eventTypes.push(e.type);
    inp.events = this.eventTypes;

    const climate = readClimate(w, data.events);
    const states = computePlaceStates(data.locations ?? [], data.agents ?? [], climate);
    inp.places = buildAudioPlaces(data.locations ?? [], states, climate.dayPhase === 'night');
    this.townHall = null;
    for (const l of data.locations ?? []) {
      if (l?.type === 'town_hall' && l.position?.width) {
        this.townHall = { x: l.position.x + l.position.width / 2, y: l.position.y };
        break;
      }
    }
    this.agentPos.clear();
    for (const a of data.agents ?? []) if (a?.position) this.agentPos.set(a.id, a.position);
    this.hasData = true;

    // What is new since the last poll. Watermarks advance even when nothing can be heard,
    // so un-muting doesn't replay the backlog.
    const tolls = tollsBetween(this.lastHour, hour);
    this.lastHour = hour;
    if (tolls > 0 && !inp.paused) this.tolls(tolls);

    this.newEvents(data.events ?? []);
    for (const row of takeNewRows(this.watch, data.activity ?? [], Date.now())) {
      const cue = storyCueOf(row);
      if (!cue) continue;
      const id = row.agent_ids?.[0] ?? row.initiator_id ?? row.target_id;
      const at = id != null ? this.agentPos.get(id) : undefined;
      this.enqueue(cue, at);
    }
  }

  private newEvents(events: any[]): void {
    if (this.seenEvents === null) {
      // First poll: events already running are not news.
      this.seenEvents = new Set(events.map((e) => e.id));
      return;
    }
    for (const e of events) {
      if (e?.id == null || this.seenEvents.has(e.id)) continue;
      this.seenEvents.add(e.id);
      const cue = eventCueOf(e.type);
      if (cue) this.enqueue(cue, this.townHall ?? undefined);
    }
    if (this.seenEvents.size > 200) this.seenEvents = new Set(events.map((e) => e.id));
  }

  private enqueue(cue: StoryCue, at: { x: number; y: number } | undefined): void {
    const view = this.view.w > 0 ? this.view : null;
    const gain = at ? Math.max(STORY_MIN_GAIN, proximity(view, at.x, at.y)) : 0.7;
    const pan = at ? panOf(view, at.x) : 0;
    if (this.queue.length >= STORY_QUEUE_MAX) this.queue.shift();
    this.queue.push({ cue, gain, pan });
  }

  // ── Frame ─────────────────────────────────────────────────────────────────────────────────

  update(frame: FrameContext): void {
    // Keep the camera rect current for cues queued between ticks.
    const v = frame.view;
    this.view.x = v.x; this.view.y = v.y; this.view.w = v.w; this.view.h = v.h; this.view.scale = v.scale;
    this.acc += frame.seconds;
    if (this.acc < TICK_S) return;
    this.acc = 0;
    const s = getSynth();
    if (!s || !this.hasData) return;

    this.input.view = this.view.w > 0 ? this.view : null;
    const L = computeSoundscape(this.input, this.levels);
    const b = this.beds;
    b.rain = L.rain; b.wind = L.wind; b.storm = L.storm; b.crowd = L.crowd; b.crowdPan = L.crowdPan; b.roomTone = L.roomTone;
    s.setBeds(b);
    s.service();
    if (L.muffle !== this.lastMuffle) { audio.setMuffle(L.muffle); this.lastMuffle = L.muffle; }
    if (L.master !== this.lastMaster) {
      audio.setBusLevel('ambience', L.master, 1.5);
      audio.setBusLevel('music', L.master, 1.5);
      this.lastMaster = L.master;
    }

    const now = s.now;
    if (this.birds.due(now, L.birds)) s.bird(L.birds, Math.random() * 1.2 - 0.6);
    if (this.crickets.due(now, L.crickets)) s.cricket(L.crickets, Math.random() * 1.4 - 0.7);
    if (this.drips.due(now, L.drips)) s.drip(L.drips);
    if (this.forge.due(now, L.forge)) s.forge(L.forge, L.forgePan);
    if (this.tavern.due(now, L.tavern)) s.tavernPhrase(L.tavern, L.tavernPan);

    if (this.queue.length > 0 && now >= this.nextStoryAt) {
      const q = this.queue.shift()!;
      if (L.story > 0) s.story(q.cue, q.gain * L.story, q.pan);
      this.nextStoryAt = now + STORY_SPACING_S;
    }
  }

  // ── Cues ──────────────────────────────────────────────────────────────────────────────────

  private tolls(count: number): void {
    const s = getSynth();
    if (!s) return;
    const view = this.view.w > 0 ? this.view : null;
    const hall = this.townHall;
    // The bell carries across the whole town: never below half, fuller when you're by it.
    const gain = 0.12 * (hall ? Math.max(0.5, proximity(view, hall.x, hall.y)) : 0.6) * this.levels.master;
    s.tolls(count, gain, hall ? panOf(view, hall.x) : 0);
  }

  private thunder(strength: number): void {
    const s = getSynth();
    if (!s || this.input.paused) return;
    // Light arrives at once, sound later: a random distance per strike.
    s.thunder(0.3 + Math.random() * 2.2, Math.min(1, Math.max(0.3, strength)) * this.levels.master);
  }

  private god(kind: string): void {
    // The player's own action always answers, paused or not: it is feedback, not ambience.
    getSynth()?.god(godCueOf(kind));
  }

  destroy(): void {
    this.offReady();
    this.offBus();
    // The synth outlives the canvas (alert chimes use it): only quiet what this system drove.
    getSynth()?.hush();
    audio.setMuffle(0);
    audio.setBusLevel('ambience', 1);
    audio.setBusLevel('music', 1);
  }
}

export const createAudioSystem: SystemFactory = () => new AudioSystem();
