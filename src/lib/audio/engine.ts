/**
 * The one Web Audio graph of the game, and the player's volume / mute settings.
 *
 *   ambience ─┐
 *   effects  ─┼─► muffle (low-pass) ─► master (volume) ─► limiter ─► speakers
 *   music    ─┘
 *
 * Why it is built this way:
 * - **One AudioContext, created on the first user gesture.** Browsers refuse to start audio
 *   before the page has been clicked or typed into; a context made earlier sits "suspended"
 *   and Chrome logs a warning for it. So nothing exists until the first pointerdown / keydown,
 *   and every voice asks `audio.graph()` first — `null` means "not now", and it plays nothing.
 * - **Suspended whenever nobody can hear it.** A hidden tab or a muted game suspends the
 *   context, which stops the audio thread entirely: the soundscape costs zero CPU in the
 *   background instead of mixing silence. `graph()` returns null while suspended, so voices
 *   are not piled up to burst out on return.
 * - **Graceful no-op.** Under Node (vitest), SSR or a browser without Web Audio, `install()`
 *   does nothing and `graph()` stays null forever; the rest of the game never has to check.
 * - **Muffle bus.** One low-pass in front of the master lets the night-skip fast-forward (and
 *   anything else that should sound "far away") close the whole mix down smoothly without
 *   each voice knowing about it.
 * - **Limiter last.** A gentle compressor catches the rare pile-up (thunder over a wedding
 *   peal over a chime), so no combination of cues can jump out of the speakers.
 *
 * Settings persist in localStorage (wrapped in try/catch: private windows and blocked storage
 * throw) and are published through `subscribe`/`getSettings` for `useSyncExternalStore`.
 */

export type BusName = 'ambience' | 'effects' | 'music';

export interface AudioSettings {
  muted: boolean;
  /** 0..1, as the slider shows it; `volumeToGain` turns it into the master gain. */
  volume: number;
}

export interface AudioGraph {
  ctx: AudioContext;
  buses: Record<BusName, GainNode>;
  /** Four seconds of pink noise, looped or sliced (random offset) by every noisy voice. */
  pink: AudioBuffer;
  /** Four seconds of brown noise: rumbles and room tone. */
  brown: AudioBuffer;
}

export const AUDIO_STORAGE_KEY = 'little-life.audio';
/** On, but modest: the town should be heard, not announced. */
export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = Object.freeze({ muted: false, volume: 0.6 });

/** Relative mix of the three buses. Story cues and music sit under the ambience, not over it. */
export const BUS_LEVELS: Readonly<Record<BusName, number>> = Object.freeze({ ambience: 0.9, effects: 0.6, music: 0.5 });

/**
 * Slider position → master gain. Loudness is roughly logarithmic, so a linear slider crams
 * all the useful range into its bottom fifth; squaring spreads it out. Full volume is
 * just under unity: the voices are mixed with ~10 dB of headroom (measured by rendering each
 * one offline: rain peaks near -10 dBFS pre-master, story cues near -20).
 */
export function volumeToGain(volume: number): number {
  const v = Number.isFinite(volume) ? Math.min(1, Math.max(0, volume)) : DEFAULT_AUDIO_SETTINGS.volume;
  return 0.95 * v * v;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Stored settings, or the defaults for anything missing, malformed or unreadable. */
export function loadAudioSettings(storage: StorageLike | null = defaultStorage()): AudioSettings {
  try {
    const raw = storage?.getItem(AUDIO_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_AUDIO_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AudioSettings> | null;
    const volume = typeof parsed?.volume === 'number' && Number.isFinite(parsed.volume)
      ? Math.min(1, Math.max(0, parsed.volume))
      : DEFAULT_AUDIO_SETTINGS.volume;
    const muted = typeof parsed?.muted === 'boolean' ? parsed.muted : DEFAULT_AUDIO_SETTINGS.muted;
    return { muted, volume };
  } catch {
    return { ...DEFAULT_AUDIO_SETTINGS };
  }
}

export function saveAudioSettings(s: AudioSettings, storage: StorageLike | null = defaultStorage()): void {
  try {
    storage?.setItem(AUDIO_STORAGE_KEY, JSON.stringify({ muted: s.muted, volume: s.volume }));
  } catch {
    /* storage full or blocked: the setting just won't survive a reload */
  }
}

const NOISE_SECONDS = 4;

/**
 * Pink (Paul Kellet's economy filter) and brown noise, rendered once. Loops of pink noise
 * this long are not recognisable as loops once they are filtered and their gain wanders.
 */
function makeNoise(ctx: AudioContext): { pink: AudioBuffer; brown: AudioBuffer } {
  const n = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const pink = ctx.createBuffer(1, n, ctx.sampleRate);
  const brown = ctx.createBuffer(1, n, ctx.sampleRate);
  const p = pink.getChannelData(0);
  const b = brown.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    p[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
    last = (last + 0.02 * w) / 1.02;
    b[i] = last * 3.5;
  }
  // Cross-fade the seam so the loop point doesn't click.
  const fade = Math.min(2048, n >> 3);
  for (let i = 0; i < fade; i++) {
    const t = i / fade;
    p[n - fade + i] = p[n - fade + i] * (1 - t) + p[i] * t;
    b[n - fade + i] = b[n - fade + i] * (1 - t) + b[i] * t;
  }
  return { pink, brown };
}

type Listener = () => void;

/** Lowest cutoff of the muffle filter (fully muffled): through a closed window. */
const MUFFLE_MIN_HZ = 650;
const MUFFLE_OPEN_HZ = 16000;

export class AudioEngine {
  private graphRef: AudioGraph | null = null;
  private master: GainNode | null = null;
  private muffle: BiquadFilterNode | null = null;
  private settings: AudioSettings = loadAudioSettings();
  private readonly listeners = new Set<Listener>();
  private readonly readyListeners = new Set<(g: AudioGraph) => void>();
  private installed = false;
  private hidden = false;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private muffleAmount = 0;

  /** Web Audio exists here at all (false under Node / SSR / very old browsers). */
  get available(): boolean {
    return typeof window !== 'undefined'
      && typeof (window.AudioContext ?? (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext) === 'function';
  }

  /**
   * Arm the first-gesture unlock and the visibility pause. Idempotent; every consumer calls
   * it (the canvas system, the speaker button) so whichever mounts first sets things up.
   */
  install(): void {
    if (this.installed || !this.available) return;
    this.installed = true;
    // Capture phase: a click that a panel stops from propagating still counts as the gesture.
    window.addEventListener('pointerdown', this.unlock, true);
    window.addEventListener('keydown', this.unlock, true);
    window.addEventListener('touchend', this.unlock, true);
    document.addEventListener('visibilitychange', this.onVisibility);
    this.hidden = document.visibilityState === 'hidden';
  }

  private readonly unlock = (): void => {
    window.removeEventListener('pointerdown', this.unlock, true);
    window.removeEventListener('keydown', this.unlock, true);
    window.removeEventListener('touchend', this.unlock, true);
    if (this.graphRef) return;
    try {
      this.build();
    } catch (err) {
      console.warn('[audio] could not start Web Audio:', err);
      return;
    }
    this.applyRunning();
    const g = this.graphRef;
    if (g) for (const l of this.readyListeners) {
      try { l(g); } catch (err) { console.warn('[audio] ready listener failed:', err); }
    }
  };

  private build(): void {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    // "playback" favours smooth output over latency: nothing here is interactive to the ms.
    const ctx = new Ctor({ latencyHint: 'playback' });
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -14;
    limiter.knee.value = 10;
    limiter.ratio.value = 6;
    limiter.attack.value = 0.005;
    limiter.release.value = 0.25;
    limiter.connect(ctx.destination);

    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(limiter);

    const muffle = ctx.createBiquadFilter();
    muffle.type = 'lowpass';
    muffle.Q.value = 0.5;
    muffle.frequency.value = MUFFLE_OPEN_HZ;
    muffle.connect(master);

    const bus = (name: BusName) => {
      const g = ctx.createGain();
      g.gain.value = BUS_LEVELS[name];
      g.connect(muffle);
      return g;
    };
    const { pink, brown } = makeNoise(ctx);
    this.master = master;
    this.muffle = muffle;
    this.graphRef = { ctx, buses: { ambience: bus('ambience'), effects: bus('effects'), music: bus('music') }, pink, brown };
    this.setMuffle(this.muffleAmount);
  }

  private readonly onVisibility = (): void => {
    this.hidden = document.visibilityState === 'hidden';
    this.applyRunning();
  };

  /** Resume or suspend the context to match (unlocked && visible && not muted). */
  private applyRunning(): void {
    const g = this.graphRef;
    if (!g || !this.master) return;
    const want = !this.hidden && !this.settings.muted;
    const t = g.ctx.currentTime;
    if (this.suspendTimer) { clearTimeout(this.suspendTimer); this.suspendTimer = null; }
    if (want) {
      void g.ctx.resume().catch(() => { /* not allowed yet: the next gesture retries via setMuted */ });
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(volumeToGain(this.settings.volume), t, 0.15);
    } else {
      // Fade before suspending, or the cut clicks.
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(0, t, 0.04);
      this.suspendTimer = setTimeout(() => {
        this.suspendTimer = null;
        if (this.hidden || this.settings.muted) void g.ctx.suspend().catch(() => {});
      }, 220);
    }
  }

  /** The live graph, or null when there is nothing to play into (locked, suspended, muted, hidden). */
  graph(): AudioGraph | null {
    const g = this.graphRef;
    if (!g || g.ctx.state !== 'running' || this.hidden || this.settings.muted) return null;
    return g;
  }

  /**
   * Called once when the context first comes to life (immediately if it already has).
   * Returns the unsubscribe function. Long-lived nodes (ambience beds) are built here.
   */
  onReady(cb: (g: AudioGraph) => void): () => void {
    this.readyListeners.add(cb);
    if (this.graphRef) cb(this.graphRef);
    return () => { this.readyListeners.delete(cb); };
  }

  /**
   * Close the whole mix down to "heard through a wall": 0 = open, 1 = fully muffled.
   * Exponential in frequency so the sweep sounds even.
   */
  setMuffle(amount: number): void {
    const a = Math.min(1, Math.max(0, amount));
    this.muffleAmount = a;
    const g = this.graphRef;
    if (!g || !this.muffle) return;
    const hz = MUFFLE_OPEN_HZ * Math.pow(MUFFLE_MIN_HZ / MUFFLE_OPEN_HZ, a);
    this.muffle.frequency.setTargetAtTime(hz, g.ctx.currentTime, 0.6);
  }

  /** Scale a bus (0..1 on top of its BUS_LEVELS mix), smoothly. */
  setBusLevel(bus: BusName, level: number, seconds = 0.5): void {
    const g = this.graphRef;
    if (!g) return;
    const v = BUS_LEVELS[bus] * Math.min(1, Math.max(0, level));
    g.buses[bus].gain.setTargetAtTime(v, g.ctx.currentTime, Math.max(0.01, seconds / 3));
  }

  // ── Settings (React reads these through useSyncExternalStore) ─────────────────────────────

  getSettings = (): AudioSettings => this.settings;

  /** True once the first gesture has created the context (the UI hints "click to start" before). */
  get unlocked(): boolean {
    return this.graphRef !== null;
  }

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => { this.listeners.delete(l); };
  };

  setVolume(volume: number): void {
    const v = Math.min(1, Math.max(0, Number.isFinite(volume) ? volume : this.settings.volume));
    // Dragging the volume up from a muted state means "I want to hear it".
    this.update({ volume: Math.round(v * 100) / 100, muted: v > 0 ? false : this.settings.muted });
  }

  setMuted(muted: boolean): void {
    this.update({ ...this.settings, muted });
  }

  toggleMute(): void {
    this.setMuted(!this.settings.muted);
  }

  private update(next: AudioSettings): void {
    if (next.muted === this.settings.muted && next.volume === this.settings.volume) return;
    this.settings = next;
    saveAudioSettings(next);
    this.applyRunning();
    for (const l of this.listeners) l();
  }
}

/** The game's single audio engine. */
export const audio = new AudioEngine();
