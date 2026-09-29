import { audio, type AudioGraph, type BusName } from './engine';
import { VoiceAllocator, type VoiceClass } from './voices';
import { chimeAllowed, createChimeGate, type ChimeTier, type GodCue, type StoryCue } from './soundscape';

/**
 * Every sound in the game, made from oscillators, noise and a few buffers rendered in JS once.
 * No audio files: nothing to download, nothing to license, and every voice can be varied a
 * little each time so nothing repeats exactly.
 *
 * CPU rules (the canvas already spends the frame budget):
 * - **Beds** (rain, wind, storm rumble, crowd murmur, room tone) are built once and only
 *   their looping noise source starts/stops: a bed silent for a few seconds stops its source,
 *   so a sunny day runs no rain graph at all.
 * - **Rendered buffers** stand in for oscillator stacks. A bell is eight decaying partials:
 *   rendered once into a buffer, each toll is one BufferSource with a playbackRate — the same
 *   buffer, pitched down, is the funeral knell; pitched up, the UI chime and the god-power
 *   glitter. Same for the forge clink (coins, the jail door), the fist thump and the drip.
 *   Karplus-Strong lute notes are rendered once per pitch and cached.
 * - **Voice cap** (`voices.ts`). Every one-shot reserves voices up front and gives them back on
 *   `ended`; past 32 new sounds are simply dropped (the ear never misses the 33rd bird). Bells and
 *   story/UI effects share only 24 of them, so the ambience layers can never be starved, and
 *   tower bells are counted by the time they ring (at most six at once), not from scheduling.
 * - **Nothing per frame.** The caller services beds and pacers ~10×/s; one-shots allocate
 *   their handful of nodes only when they actually sound.
 *
 * Taste: low-passed, soft attacks, random intervals and random detail, peaks kept within a
 * few dB of the ambience beds (the engine's limiter is a seatbelt, not the mix).
 */

/** D major pentatonic, D3..D5: every random lute phrase lands on a pleasant note. */
export const PENTA = [146.83, 164.81, 185.0, 220.0, 246.94, 293.66, 329.63, 369.99, 440.0, 493.88, 587.33];

/**
 * Bell rates from here up are hand-bells, not tower bells: they ring 2 s or less, so they are
 * ordinary counted voices instead of interval-counted ones.
 */
const HAND_BELL_RATE = 2.2;
/**
 * How long a peal strike is allowed to ring. The round runs 0.3 s apart, so 1.7 s keeps six in
 * the air at the most (the allocator's bell cap) instead of letting eight ring for 2.5–5 s.
 */
const PEAL_RING = 1.7;

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

/**
 * Random pacing for a sparse layer: `due` answers true at most once per interval, and the
 * interval (random between `min` and `max` seconds) stretches as the level drops, so a faint
 * layer is also a rare one. A silent layer re-arms, so it doesn't fire the instant it returns.
 */
export class Pacer {
  private next = -1;
  constructor(private readonly min: number, private readonly max: number) {}
  due(now: number, level: number): boolean {
    if (level <= 0.01) { this.next = -1; return false; }
    if (this.next < 0) { this.next = now + rand(this.min, this.max) * 0.5 / Math.max(level, 0.15); return false; }
    if (now < this.next) return false;
    this.next = now + rand(this.min, this.max) / Math.max(level, 0.15);
    return true;
  }
}

// ── Rendered buffers ─────────────────────────────────────────────────────────────────────────

/** A church bell: hum, prime, minor-third tierce, quint, nominal and a few high partials. */
function renderBell(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const secs = 5;
  const n = Math.floor(sr * secs);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const f = 220;
  // [ratio, amplitude, decay seconds]
  const partials: Array<[number, number, number]> = [
    [0.5, 0.32, 3.8], [1, 0.5, 2.6], [1.19, 0.34, 2.0], [1.5, 0.18, 1.6],
    [2, 0.3, 1.3], [2.52, 0.12, 0.8], [3.01, 0.08, 0.55], [4.07, 0.05, 0.3],
  ];
  // One partial at a time with a running decay factor: this runs inside the first click's
  // handler, so ~2M Math.exp calls would be a visible hitch; multiplications are not.
  for (const [r, a, dec] of partials) {
    const w = (2 * Math.PI * f * r) / sr;
    const k = Math.exp(-1 / (sr * dec));
    let amp = a;
    for (let i = 0; i < n; i++) {
      d[i] += amp * Math.sin(w * i + r);
      amp *= k;
    }
  }
  const attackN = Math.floor(sr * 0.004);
  for (let i = 0; i < attackN; i++) d[i] *= i / attackN;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const m = Math.abs(d[i]);
    if (m > peak) peak = m;
  }
  const k = peak > 0 ? 0.8 / peak : 1;
  for (let i = 0; i < n; i++) d[i] *= k;
  return buf;
}

/** Hammer on iron: three inharmonic partials plus a short noisy thud. */
function renderClink(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 0.9);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  const f = 1100;
  let lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let s = 0.5 * Math.exp(-t / 0.22) * Math.sin(2 * Math.PI * f * t)
      + 0.3 * Math.exp(-t / 0.11) * Math.sin(2 * Math.PI * f * 2.76 * t)
      + 0.15 * Math.exp(-t / 0.05) * Math.sin(2 * Math.PI * f * 5.4 * t);
    lp += 0.15 * ((Math.random() * 2 - 1) - lp);
    s += 0.6 * lp * Math.exp(-t / 0.012);
    d[i] = s * Math.min(1, t / 0.001) * 0.7;
  }
  return buf;
}

/** A dull blow: a sine dropping 110 → 45 Hz with a muffled noise burst. */
function renderThump(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 0.35);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let phase = 0, lp = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 45 + 65 * Math.exp(-t / 0.05);
    phase += (2 * Math.PI * f) / sr;
    lp += 0.08 * ((Math.random() * 2 - 1) - lp);
    d[i] = (0.8 * Math.sin(phase) * Math.exp(-t / 0.09) + 1.2 * lp * Math.exp(-t / 0.03)) * Math.min(1, t / 0.002);
  }
  return buf;
}

/** A water drop: a short sine falling in pitch. Pitched per drop for variety. */
function renderDrop(ctx: AudioContext): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.floor(sr * 0.08);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = 1300 + 1100 * Math.exp(-t / 0.012);
    phase += (2 * Math.PI * f) / sr;
    d[i] = Math.sin(phase) * Math.exp(-t / 0.018) * Math.min(1, t / 0.0015);
  }
  return buf;
}

/**
 * Karplus-Strong plucked string: a burst of (softened) noise circulating through a delay line
 * that averages neighbours — the averaging is the string losing its brightness. The delay is
 * a whole number of samples, so the true pitch is sr / (N + 0.5); `rate` corrects it.
 */
function renderPluck(ctx: AudioContext, freq: number): { buf: AudioBuffer; rate: number } {
  const sr = ctx.sampleRate;
  const period = Math.max(2, Math.round(sr / freq));
  const secs = 1.8;
  const n = Math.floor(sr * secs);
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  // A finger, not a pick: two smoothing passes over the excitation take the edge off.
  const init = new Float32Array(period);
  for (let i = 0; i < period; i++) init[i] = Math.random() * 2 - 1;
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < period; i++) init[i] = 0.5 * (init[i] + init[i - 1]);
  }
  const decay = 0.9965;
  for (let i = 0; i < n; i++) {
    if (i < period) d[i] = init[i];
    else d[i] = decay * 0.5 * (d[i - period] + d[i - period - 1 >= 0 ? i - period - 1 : 0]);
  }
  const fade = Math.floor(sr * 0.15);
  for (let i = 0; i < fade; i++) d[n - 1 - i] *= i / fade;
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(d[i]));
  const k = peak > 0 ? 0.7 / peak : 1;
  for (let i = 0; i < n; i++) d[i] *= k;
  return { buf, rate: (freq * (period + 0.5)) / sr };
}

// ── Beds ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A continuous layer: a looping noise source into a fixed filter chain into a level gain.
 * Only the source comes and goes; the chain is built once.
 */
class Bed {
  private src: AudioBufferSourceNode | null = null;
  private target = 0;
  private quietSince = -1;
  readonly level: GainNode;

  constructor(
    private readonly ctx: AudioContext,
    private readonly buffer: AudioBuffer,
    /** First node of the chain; its last node must connect into `level`. */
    private readonly input: AudioNode,
    /** Full-scale gain for level 1. */
    private readonly scale: number,
  ) {
    this.level = ctx.createGain();
    this.level.gain.value = 0;
  }

  /** Glide toward `level` (0..1) with time constant `tc` seconds. */
  set(level: number, now: number, tc = 0.9): void {
    const v = level * this.scale;
    if (Math.abs(v - this.target) > 0.0005) {
      this.level.gain.setTargetAtTime(v, now, tc);
      this.target = v;
    }
    if (v > 0.0005) {
      this.quietSince = -1;
      if (!this.src) {
        const s = this.ctx.createBufferSource();
        s.buffer = this.buffer;
        s.loop = true;
        s.connect(this.input);
        // A random way into the loop: two beds on the same buffer never phase against each other.
        s.start(now, Math.random() * this.buffer.duration);
        this.src = s;
      }
    } else if (this.src) {
      if (this.quietSince < 0) this.quietSince = now;
      else if (now - this.quietSince > tc * 6) {
        try { this.src.stop(); } catch { /* already stopped */ }
        this.src.disconnect();
        this.src = null;
        this.quietSince = -1;
      }
    }
  }

  get playing(): boolean {
    return this.src !== null;
  }

  /**
   * Fade out and stop now. `set(0)` only stops the source on a *later* call, and a bed whose
   * driver went away (canvas unmounted) would otherwise loop silence forever.
   */
  hush(now: number): void {
    this.level.gain.setTargetAtTime(0, now, 0.15);
    this.target = 0;
    this.quietSince = -1;
    if (this.src) {
      try { this.src.stop(now + 1); } catch { /* ignore */ }
      const s = this.src;
      s.onended = () => s.disconnect();
      this.src = null;
    }
  }

  dispose(): void {
    if (this.src) {
      try { this.src.stop(); } catch { /* ignore */ }
      this.src.disconnect();
      this.src = null;
    }
    this.level.disconnect();
  }
}

export interface BedLevels {
  rain: number;
  wind: number;
  storm: number;
  crowd: number;
  crowdPan: number;
  roomTone: number;
}

// ── The synth ────────────────────────────────────────────────────────────────────────────────

export class Synth {
  private readonly ctx: AudioContext;
  private readonly voices = new VoiceAllocator();
  private readonly bell: AudioBuffer;
  private readonly clink: AudioBuffer;
  private readonly thumpBuf: AudioBuffer;
  private readonly drop: AudioBuffer;
  private readonly plucks = new Map<number, { buf: AudioBuffer; rate: number }>();

  private readonly rain: Bed;
  private readonly wind: Bed;
  private readonly storm: Bed;
  private readonly crowd: Bed;
  private readonly room: Bed;
  private readonly windBand: BiquadFilterNode;
  private readonly windGust: GainNode;
  private readonly stormSwell: GainNode;
  private readonly crowdBand: BiquadFilterNode;
  private readonly crowdBabble: GainNode;
  private readonly crowdPanner: StereoPannerNode;
  /** Birds and crickets share one soft top so a 4 kHz chirp never whistles. */
  private readonly critters: BiquadFilterNode;
  private nextGust = 0;
  private nextBabble = 0;
  private nextSwell = 0;
  private windLevel = 0;
  private crowdLevel = 0;
  private stormLevel = 0;

  constructor(private readonly g: AudioGraph) {
    const ctx = g.ctx;
    this.ctx = ctx;
    this.bell = renderBell(ctx);
    this.clink = renderClink(ctx);
    this.thumpBuf = renderThump(ctx);
    this.drop = renderDrop(ctx);
    const amb = g.buses.ambience;

    // Rain: pink noise with the rumble and the hiss both trimmed — a steady hush on the roofs.
    {
      const hp = this.filter('highpass', 380, 0.5);
      const lp = this.filter('lowpass', 3200, 0.4);
      hp.connect(lp);
      this.rain = new Bed(ctx, g.pink, hp, 0.5);
      lp.connect(this.rain.level);
      this.rain.level.connect(amb);
    }
    // Wind: a wandering band of pink noise; `service` moves its centre and loudness in gusts.
    {
      this.windBand = this.filter('bandpass', 500, 0.8);
      const lp = this.filter('lowpass', 1400, 0.5);
      this.windGust = ctx.createGain();
      this.windGust.gain.value = 0.5;
      this.windBand.connect(lp);
      lp.connect(this.windGust);
      this.wind = new Bed(ctx, g.pink, this.windBand, 0.9);
      this.windGust.connect(this.wind.level);
      this.wind.level.connect(amb);
    }
    // Storm: brown noise under 150 Hz, the distant weight of the weather.
    {
      const lp = this.filter('lowpass', 150, 0.6);
      this.stormSwell = ctx.createGain();
      this.stormSwell.gain.value = 0.6;
      lp.connect(this.stormSwell);
      this.storm = new Bed(ctx, g.brown, lp, 0.9);
      this.stormSwell.connect(this.storm.level);
      this.storm.level.connect(amb);
    }
    // Crowd murmur: speech-band noise whose loudness and colour jitter at syllable rate —
    // many voices through a wall, no words.
    {
      this.crowdBand = this.filter('bandpass', 480, 1.1);
      const lp = this.filter('lowpass', 1300, 0.5);
      this.crowdBabble = ctx.createGain();
      this.crowdBabble.gain.value = 0.7;
      this.crowdPanner = ctx.createStereoPanner();
      this.crowdBand.connect(lp);
      lp.connect(this.crowdBabble);
      this.crowd = new Bed(ctx, g.pink, this.crowdBand, 0.9);
      this.crowdBabble.connect(this.crowd.level);
      this.crowd.level.connect(this.crowdPanner);
      this.crowdPanner.connect(amb);
    }
    // Room tone: the faintest low hush, so a paused game sounds held, not broken.
    {
      const lp = this.filter('lowpass', 260, 0.5);
      this.room = new Bed(ctx, g.brown, lp, 0.18);
      lp.connect(this.room.level);
      this.room.level.connect(amb);
    }
    this.critters = this.filter('lowpass', 6500, 0.5);
    this.critters.connect(amb);
  }

  private filter(type: BiquadFilterType, freq: number, q: number): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** Voices in flight (for probes and tests of the cap). */
  get activeVoices(): number {
    return this.voices.active(this.ctx.currentTime);
  }

  /** Beds with a running source. */
  get activeBeds(): number {
    return [this.rain, this.wind, this.storm, this.crowd, this.room].filter((b) => b.playing).length;
  }

  // ── Beds ───────────────────────────────────────────────────────────────────────────────────

  setBeds(l: BedLevels): void {
    const t = this.ctx.currentTime;
    this.rain.set(l.rain, t, 1.2);
    this.wind.set(l.wind, t, 1.5);
    this.storm.set(l.storm, t, 2);
    this.crowd.set(l.crowd, t, 1.2);
    this.room.set(l.roomTone, t, 0.8);
    this.crowdPanner.pan.setTargetAtTime(l.crowdPan, t, 1.5);
    this.windLevel = l.wind;
    this.crowdLevel = l.crowd;
    this.stormLevel = l.storm;
  }

  /**
   * Keep the beds alive: new gust, new babble syllable, new swell of the storm, each at a
   * random time with a random time constant. Irregular on purpose — an LFO would be a loop.
   */
  service(): void {
    const t = this.ctx.currentTime;
    if (this.windLevel > 0 && t >= this.nextGust) {
      const strong = Math.random() < 0.25;
      this.windGust.gain.setTargetAtTime(strong ? rand(0.8, 1) : rand(0.25, 0.65), t, rand(0.6, 2.2));
      this.windBand.frequency.setTargetAtTime(strong ? rand(650, 1000) : rand(280, 600), t, rand(0.8, 2.5));
      this.nextGust = t + rand(1.5, 5.5);
    }
    if (this.crowdLevel > 0 && t >= this.nextBabble) {
      this.crowdBabble.gain.setTargetAtTime(rand(0.45, 1), t, rand(0.05, 0.14));
      this.crowdBand.frequency.setTargetAtTime(rand(380, 650), t, 0.1);
      // A laugh now and then: a brief lift of the whole murmur.
      this.nextBabble = t + (Math.random() < 0.04 ? 0.6 : rand(0.12, 0.4));
    }
    if (this.stormLevel > 0 && t >= this.nextSwell) {
      this.stormSwell.gain.setTargetAtTime(rand(0.35, 1), t, rand(1, 3));
      this.nextSwell = t + rand(2, 6);
    }
  }

  /** Fade every bed out and stop its source (the soundscape's driver is going away). */
  hush(): void {
    const t = this.ctx.currentTime;
    for (const b of [this.rain, this.wind, this.storm, this.crowd, this.room]) b.hush(t);
    this.windLevel = this.crowdLevel = this.stormLevel = 0;
  }

  // ── Voice plumbing ─────────────────────────────────────────────────────────────────────────

  private reserve(n: number, cls: VoiceClass = 'fx'): boolean {
    return this.voices.reserve(cls, n, this.ctx.currentTime);
  }

  /** Gain (+ pan) into a destination; disconnected when `src` ends, which frees the voice. */
  private out(dest: AudioNode, gain: number, pan = 0): GainNode {
    const gn = this.ctx.createGain();
    gn.gain.value = gain;
    if (pan !== 0) {
      const p = this.ctx.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, pan));
      gn.connect(p);
      p.connect(dest);
    } else {
      gn.connect(dest);
    }
    return gn;
  }

  /** `cls` is the class the voice was reserved under; `null` for a tower bell (interval-counted). */
  private release(cls: VoiceClass | null, src: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
    src.onended = () => {
      if (cls) this.voices.release(cls);
      src.disconnect();
      for (const n of nodes) n.disconnect();
    };
  }

  /** One play of a rendered buffer at `when`, pitched by `rate`, into `dest` through `gain`. */
  private playBuf(
    buf: AudioBuffer, when: number, rate: number, dest: AudioNode, gain: number, pan = 0, lowpass = 0,
    cls: VoiceClass | null = 'fx',
    /** Cut the sound off after this many seconds with a short fade (tower bells in a peal). */
    ring = 0,
  ): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const o = this.out(dest, gain, pan);
    if (lowpass > 0) {
      const f = this.filter('lowpass', lowpass, 0.5);
      src.connect(f);
      f.connect(o);
      this.release(cls, src, f, o);
    } else {
      src.connect(o);
      this.release(cls, src, o);
    }
    src.start(when);
    // After start(): stop() on a source that hasn't been started throws InvalidStateError.
    if (ring > 0 && ring < buf.duration / rate) {
      const fade = Math.min(0.5, ring * 0.4);
      o.gain.setValueAtTime(gain, when + ring - fade);
      o.gain.linearRampToValueAtTime(0, when + ring);
      src.stop(when + ring + 0.02);
    }
  }

  private bus(name: BusName): GainNode {
    return this.g.buses[name];
  }

  // ── Nature ─────────────────────────────────────────────────────────────────────────────────

  /**
   * One bird's phrase: an FM chirp (sine carrier, a gentle sine modulator for the warble)
   * whose envelope plays a short pattern. Three song shapes, randomly pitched and paced.
   */
  bird(level: number, pan: number): void {
    if (!this.reserve(2, 'ambience')) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const f0 = rand(2300, 4000);
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modGain = ctx.createGain();
    const env = ctx.createGain();
    car.type = 'sine';
    mod.type = 'sine';
    mod.frequency.value = f0 * rand(0.18, 0.35);
    modGain.gain.value = f0 * rand(0.03, 0.09);
    mod.connect(modGain);
    modGain.connect(car.frequency);
    env.gain.value = 0;
    car.connect(env);
    const o = this.out(this.critters, 1, pan);
    env.connect(o);

    const peak = 0.06 * (0.5 + 0.5 * level) * rand(0.6, 1);
    const shape = Math.floor(Math.random() * 3);
    let at = t;
    const note = (from: number, to: number, dur: number) => {
      car.frequency.setValueAtTime(from, at);
      car.frequency.exponentialRampToValueAtTime(to, at + dur);
      env.gain.setValueAtTime(0, at);
      env.gain.linearRampToValueAtTime(peak, at + Math.min(0.015, dur * 0.3));
      env.gain.linearRampToValueAtTime(peak * 0.6, at + dur * 0.7);
      env.gain.linearRampToValueAtTime(0, at + dur);
    };
    if (shape === 0) {
      // A rising trill.
      const n = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) { note(f0, f0 * 1.25, 0.055); at += 0.055 + rand(0.02, 0.04); }
    } else if (shape === 1) {
      // A falling whistle, two or three times.
      const n = 2 + Math.floor(Math.random() * 2);
      for (let i = 0; i < n; i++) { note(f0 * 1.1, f0 * 0.78, 0.16); at += 0.16 + rand(0.08, 0.14); }
    } else {
      // "Tsee-too": high then low, sometimes repeated.
      const n = Math.random() < 0.5 ? 2 : 4;
      for (let i = 0; i < n; i++) {
        const hi = i % 2 === 0;
        note(hi ? f0 * 1.15 : f0 * 0.85, hi ? f0 * 1.2 : f0 * 0.8, 0.11);
        at += 0.11 + rand(0.06, 0.1);
      }
    }
    car.start(t);
    mod.start(t);
    car.stop(at + 0.05);
    mod.stop(at + 0.05);
    this.release('ambience', car, env, o);
    this.release('ambience', mod, modGain);
  }

  /**
   * One cricket for a few seconds: a sine near 4.5 kHz gated into chirps of three pulses. A
   * cricket keeps its own pitch and tempo for the whole train; the next one differs.
   */
  cricket(level: number, pan: number): void {
    if (!this.reserve(1, 'ambience')) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + 0.02;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = rand(4200, 4900);
    const env = ctx.createGain();
    env.gain.value = 0;
    osc.connect(env);
    const o = this.out(this.critters, 1, pan);
    env.connect(o);
    const peak = 0.02 * (0.5 + 0.5 * level) * rand(0.6, 1);
    const period = rand(0.38, 0.62);
    const pulses = Math.random() < 0.5 ? 3 : 4;
    const chirps = Math.floor(rand(3, 9));
    let at = t;
    for (let c = 0; c < chirps; c++) {
      for (let p = 0; p < pulses; p++) {
        const s = at + p * 0.026;
        env.gain.setValueAtTime(0, s);
        env.gain.linearRampToValueAtTime(peak, s + 0.004);
        env.gain.setValueAtTime(peak, s + 0.011);
        env.gain.linearRampToValueAtTime(0, s + 0.015);
      }
      at += period;
    }
    osc.start(t);
    osc.stop(at + 0.05);
    this.release('ambience', osc, env, o);
  }

  /** A drop off the eaves. */
  drip(level: number): void {
    if (!this.reserve(1, 'ambience')) return;
    this.playBuf(this.drop, this.ctx.currentTime + 0.01, rand(0.6, 1.5), this.bus('ambience'), 0.05 * level * rand(0.4, 1), rand(-0.7, 0.7), 3500, 'ambience');
  }

  /**
   * Thunder `delay` seconds after the flash (sound is slower than light: the farther the
   * strike, the later, softer and duller the roll). A close one opens with a crack.
   */
  thunder(delay: number, strength: number): void {
    if (!this.reserve(2, 'ambience')) return;
    const ctx = this.ctx;
    const t = ctx.currentTime + delay;
    const near = Math.max(0, 1 - delay / 3);
    const amb = this.bus('ambience');

    // Crack: bright noise snapping shut. Only for near strikes.
    if (near > 0.35) {
      const src = ctx.createBufferSource();
      src.buffer = this.g.pink;
      const lp = this.filter('lowpass', 3200, 0.7);
      lp.frequency.setValueAtTime(3200, t);
      lp.frequency.exponentialRampToValueAtTime(220, t + 0.6);
      const env = this.out(amb, 0);
      env.gain.setValueAtTime(0, t);
      env.gain.linearRampToValueAtTime(0.2 * strength * near, t + 0.012);
      env.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
      src.connect(lp);
      lp.connect(env);
      src.start(t, Math.random() * 3);
      src.stop(t + 1);
      this.release('ambience', src, lp, env);
    } else {
      this.voices.release('ambience');
    }

    // Roll: brown noise, rising and settling in two or three uneven swells.
    const src = ctx.createBufferSource();
    src.buffer = this.g.brown;
    src.loop = true;
    const lp = this.filter('lowpass', 170 + 150 * near, 0.7);
    const env = this.out(amb, 0, rand(-0.4, 0.4));
    const peak = (0.3 + 0.2 * near) * strength;
    env.gain.setValueAtTime(0, t);
    env.gain.setTargetAtTime(peak, t, 0.12 + (1 - near) * 0.3);
    let at = t + rand(0.6, 1.1);
    const swells = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < swells; i++) {
      env.gain.setTargetAtTime(peak * rand(0.35, 0.85), at, rand(0.25, 0.6));
      at += rand(0.6, 1.2);
    }
    env.gain.setTargetAtTime(0, at, rand(0.8, 1.5));
    src.connect(lp);
    lp.connect(env);
    src.start(t, Math.random() * 3);
    src.stop(at + 6);
    this.release('ambience', src, lp, env);
  }

  // ── Town ───────────────────────────────────────────────────────────────────────────────────

  /**
   * One bell strike. `rate` 1 is the town-hall bell (≈A3); below 1 the funeral knell; above,
   * hand-bells. `distant` puts it across town: duller and quieter.
   */
  bellStrike(when: number, rate: number, gain: number, pan = 0, distant = true, bus: BusName = 'ambience', ring = 0): void {
    const lowpass = distant ? 1500 : 5000;
    const ringTime = Math.min(ring > 0 ? ring : Infinity, this.bell.duration / rate);
    if (rate >= HAND_BELL_RATE) {
      // Hand-bells (UI chime, god sparkle, the engagement bell) ring for a second or two: an
      // ordinary counted effect voice.
      if (!this.reserve(1)) return;
      this.playBuf(this.bell, when, rate, this.bus(bus), gain, pan, lowpass);
      return;
    }
    // Tower bells (peal, knell, tolls, alarm) ring for seconds: counted over the interval they
    // sound, so a whole peal scheduled at once doesn't hold the pool while it waits its turn.
    if (!this.voices.reserveBell(this.ctx.currentTime, when, when + ringTime)) return;
    this.playBuf(this.bell, when, rate, this.bus(bus), gain, pan, lowpass, null, ring);
  }

  /** `count` slow tolls of the town-hall bell. */
  tolls(count: number, gain: number, pan = 0, rate = 0.75, spacing = 2.4): void {
    const t = this.ctx.currentTime + 0.05;
    for (let i = 0; i < count; i++) this.bellStrike(t + i * spacing + rand(-0.05, 0.05), rate * rand(0.995, 1.005), gain, pan);
  }

  /** A burst of two to four hammer blows on the anvil. */
  forge(level: number, pan: number): void {
    const n = 2 + Math.floor(Math.random() * 3);
    if (!this.reserve(n, 'ambience')) return;
    const t = this.ctx.currentTime + 0.03;
    const spacing = rand(0.36, 0.5);
    const rate = rand(0.9, 1.1);
    for (let i = 0; i < n; i++) {
      // The last blow of a burst is often the lighter tap that sets the piece.
      const g = (i === n - 1 && Math.random() < 0.5 ? 0.55 : 1) * 0.16 * level;
      this.playBuf(this.clink, t + i * spacing + rand(-0.02, 0.02), rate * rand(0.98, 1.02), this.bus('ambience'), g, pan, 4200, 'ambience');
    }
  }

  private pluckBuf(freq: number): { buf: AudioBuffer; rate: number } {
    const key = Math.round(freq * 10);
    let p = this.plucks.get(key);
    if (!p) {
      p = renderPluck(this.ctx, freq);
      this.plucks.set(key, p);
    }
    return p;
  }

  /** One lute note. */
  pluck(freq: number, when: number, gain: number, pan = 0, bus: BusName = 'music', lowpass = 2600): void {
    // The tavern lute (music bus) is a background layer; the same note as a story or god cue
    // (effects bus) is an effect.
    const cls: VoiceClass = bus === 'music' ? 'ambience' : 'fx';
    if (!this.reserve(1, cls)) return;
    const p = this.pluckBuf(freq);
    this.playBuf(p.buf, when, p.rate, this.bus(bus), gain, pan, lowpass, cls);
  }

  /**
   * A few bars of someone noodling on a lute behind the tavern walls: a random walk on the
   * pentatonic scale, lute-ish rhythm, now and then a two-note chord. Never the same twice.
   */
  tavernPhrase(level: number, pan: number): void {
    const t = this.ctx.currentTime + 0.05;
    let idx = 3 + Math.floor(Math.random() * 5);
    const n = 3 + Math.floor(Math.random() * 5);
    let at = t;
    const g = 0.2 * (0.4 + 0.6 * level);
    // Heard through the walls: the nearer, the brighter.
    const lp = 1200 + 1600 * level;
    for (let i = 0; i < n; i++) {
      this.pluck(PENTA[idx], at, g * rand(0.75, 1), pan, 'music', lp);
      if (Math.random() < 0.2 && idx + 2 < PENTA.length) this.pluck(PENTA[idx + 2], at + 0.012, g * 0.6, pan, 'music', lp);
      at += pick([0.26, 0.26, 0.39, 0.52]) * rand(0.97, 1.03);
      idx = Math.max(0, Math.min(PENTA.length - 1, idx + pick([-2, -1, -1, 1, 1, 2])));
    }
  }

  // ── Story cues ─────────────────────────────────────────────────────────────────────────────

  story(cue: StoryCue, gain: number, pan = 0): void {
    const t = this.ctx.currentTime + 0.05;
    const fx: BusName = 'effects';
    switch (cue) {
      case 'scuffle': {
        const n = Math.random() < 0.5 ? 2 : 3;
        let at = t;
        for (let i = 0; i < n; i++) {
          if (this.reserve(1)) this.playBuf(this.thumpBuf, at, rand(0.85, 1.15), this.bus(fx), 0.15 * gain, pan, 900);
          at += rand(0.16, 0.3);
        }
        break;
      }
      case 'romance':
        [5, 7, 8, 10].forEach((i, k) => this.pluck(PENTA[i], t + k * 0.14, 0.2 * gain, pan, fx));
        break;
      case 'engaged':
        [5, 7, 8, 10].forEach((i, k) => this.pluck(PENTA[i], t + k * 0.14, 0.2 * gain, pan, fx));
        this.bellStrike(t + 0.7, 2.67, 0.12 * gain, pan, false, fx);
        break;
      case 'peal': {
        // A descending major round on the tower bells, rung twice, the second a touch softer.
        const scale = [2, 1.875, 5 / 3, 1.5, 4 / 3, 1.25, 1.125, 1];
        for (let round = 0; round < 2; round++) {
          scale.forEach((r, k) => this.bellStrike(t + round * 2.8 + k * 0.3 + rand(-0.02, 0.02), r, (round ? 0.08 : 0.1) * gain, pan, true, fx, PEAL_RING));
        }
        break;
      }
      case 'sad':
        [220, 174.61, 146.83].forEach((f, k) => this.pluck(f, t + k * 0.5, 0.2 * gain, pan, fx, 1800));
        break;
      case 'whisper':
        this.breath(t, 0.16 * gain, pan, 2600, 0.7);
        this.breath(t + 0.45, 0.12 * gain, pan, 3000, 0.45);
        break;
      case 'sneak':
        [164.81, 155.56, 146.83].forEach((f, k) => this.pluck(f, t + k * 0.28, 0.14 * gain, pan, fx, 1100));
        break;
      case 'clang':
        if (this.reserve(1)) this.playBuf(this.clink, t, 0.38, this.bus(fx), 0.12 * gain, pan, 1800);
        if (this.reserve(1)) this.playBuf(this.thumpBuf, t, 0.8, this.bus(fx), 0.14 * gain, pan, 700);
        break;
      case 'knell':
        for (let i = 0; i < 3; i++) this.bellStrike(t + i * 3.4, 0.5, 0.13 * gain, pan, true, fx);
        break;
      case 'cheer':
        [5, 6, 7, 8, 10].forEach((i, k) => this.pluck(PENTA[i], t + k * 0.09, 0.17 * gain, pan, fx));
        break;
      case 'alarm':
        for (let i = 0; i < 6; i++) this.bellStrike(t + i * 0.45, 1.35, 0.12 * gain, pan, true, fx);
        break;
      case 'tolls':
        for (let i = 0; i < 3; i++) this.bellStrike(t + i * 2.2, 0.75, 0.13 * gain, pan, true, fx);
        break;
    }
  }

  /** A breathy swish: a slice of pink noise through a bandpass, swelling and fading. */
  private breath(when: number, gain: number, pan: number, freq: number, dur: number, sweepTo = 0): void {
    if (!this.reserve(1)) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.g.pink;
    const bp = this.filter('bandpass', freq, 0.9);
    if (sweepTo > 0) {
      bp.frequency.setValueAtTime(freq, when);
      bp.frequency.exponentialRampToValueAtTime(sweepTo, when + dur * 0.45);
      bp.frequency.exponentialRampToValueAtTime(freq * 1.3, when + dur);
    }
    const env = this.out(this.bus('effects'), 0, pan);
    env.gain.setValueAtTime(0, when);
    env.gain.linearRampToValueAtTime(gain, when + dur * 0.4);
    env.gain.linearRampToValueAtTime(0, when + dur);
    src.connect(bp);
    bp.connect(env);
    src.start(when, Math.random() * 3);
    src.stop(when + dur + 0.05);
    this.release('fx', src, bp, env);
  }

  // ── The player's hand ──────────────────────────────────────────────────────────────────────

  god(cue: GodCue, gain = 1): void {
    const t = this.ctx.currentTime + 0.02;
    const fx: BusName = 'effects';
    switch (cue) {
      case 'sparkle': {
        // Tiny bells climbing the pentatonic, a little uneven, the top one left ringing.
        const rates = [3.0, 3.36, 3.78, 4.49, 5.04, 6.0];
        rates.forEach((r, k) => this.bellStrike(t + k * rand(0.045, 0.065), r, 0.1 * gain, rand(-0.3, 0.3), false, fx));
        break;
      }
      case 'whoosh':
        this.breath(t, 0.28 * gain, 0, 280, 0.8, 1700);
        break;
      case 'coins': {
        const n = 3 + Math.floor(Math.random() * 3);
        let at = t;
        for (let i = 0; i < n; i++) {
          if (this.reserve(1)) this.playBuf(this.clink, at, rand(1.9, 2.5), this.bus(fx), 0.16 * gain * rand(0.6, 1), rand(-0.2, 0.2), 6000);
          at += rand(0.05, 0.1);
        }
        break;
      }
      case 'nudge':
        this.pluck(PENTA[8], t, 0.16 * gain, 0, fx);
        this.pluck(PENTA[10], t + 0.1, 0.1 * gain, 0, fx);
        break;
      case 'fanfare':
        // A bright climb up the pentatonic, the last note doubled, then a ringing bell on top:
        // louder and longer than any god cue, because the player earned it.
        [3, 5, 7, 8].forEach((i, k) => this.pluck(PENTA[i], t + k * 0.11, 0.18 * gain, 0, fx));
        this.pluck(PENTA[10], t + 0.48, 0.2 * gain, -0.15, fx);
        this.pluck(PENTA[10] / 2, t + 0.5, 0.14 * gain, 0.15, fx);
        this.bellStrike(t + 0.55, 3.0, 0.1 * gain, 0, false, fx);
        break;
    }
  }

  /** The alert toast's chime: one, two or three hand-bell notes by importance. */
  chime(tier: ChimeTier, gain = 1): void {
    const t = this.ctx.currentTime + 0.02;
    const notes = tier === 'player' ? [2.25, 2.83, 3.37] : tier === 'major' ? [2.52, 3.37] : [3.0];
    const g = 0.1 * gain;
    notes.forEach((r, k) => this.bellStrike(t + k * 0.13, r, g, 0, false, 'effects'));
  }

  dispose(): void {
    for (const b of [this.rain, this.wind, this.storm, this.crowd, this.room]) b.dispose();
    this.crowdPanner.disconnect();
    this.critters.disconnect();
  }
}

// ── Shared instance ─────────────────────────────────────────────────────────────────────────

let shared: Synth | null = null;
let sharedGraph: AudioGraph | null = null;

/**
 * The one synth for the live graph, or null when nothing can be heard right now (locked,
 * muted, hidden tab). Built on first use: rendering the bell and clink buffers takes a few ms,
 * which is why the canvas system asks for it from `audio.onReady` rather than mid-frame.
 */
export function getSynth(): Synth | null {
  const g = audio.graph();
  if (!g) return null;
  if (!shared || sharedGraph !== g) {
    shared?.dispose();
    shared = new Synth(g);
    sharedGraph = g;
  }
  return shared;
}

const chimeGate = createChimeGate();

/** The alert toast's chime (hooks/useDramaAlerts), rate-limited so a cascade rings once. */
export function playAlertChime(tier: ChimeTier): void {
  if (!chimeAllowed(chimeGate, tier, Date.now())) return;
  try {
    getSynth()?.chime(tier);
  } catch (err) {
    console.warn('[audio] chime failed:', err);
  }
}
