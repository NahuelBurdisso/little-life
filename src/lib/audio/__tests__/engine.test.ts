import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  AUDIO_STORAGE_KEY, AudioEngine, DEFAULT_AUDIO_SETTINGS, loadAudioSettings, saveAudioSettings, volumeToGain,
} from '../engine';
import { Pacer, getSynth, playAlertChime } from '../synth';

function memoryStorage(init: Record<string, string> = {}) {
  const data = new Map(Object.entries(init));
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    data,
  };
}

describe('audio settings', () => {
  it('defaults to on at a modest volume', () => {
    expect(loadAudioSettings(memoryStorage())).toEqual({ muted: false, volume: DEFAULT_AUDIO_SETTINGS.volume });
    expect(DEFAULT_AUDIO_SETTINGS.muted).toBe(false);
    expect(DEFAULT_AUDIO_SETTINGS.volume).toBeGreaterThan(0.2);
    expect(DEFAULT_AUDIO_SETTINGS.volume).toBeLessThan(0.7);
  });

  it('round-trips through storage', () => {
    const s = memoryStorage();
    saveAudioSettings({ muted: true, volume: 0.3 }, s);
    expect(loadAudioSettings(s)).toEqual({ muted: true, volume: 0.3 });
  });

  it('tolerates garbage, out-of-range and partial values', () => {
    expect(loadAudioSettings(memoryStorage({ [AUDIO_STORAGE_KEY]: '{not json' }))).toEqual({ ...DEFAULT_AUDIO_SETTINGS });
    expect(loadAudioSettings(memoryStorage({ [AUDIO_STORAGE_KEY]: '{"volume":7}' })).volume).toBe(1);
    expect(loadAudioSettings(memoryStorage({ [AUDIO_STORAGE_KEY]: '{"volume":"loud","muted":1}' })))
      .toEqual({ ...DEFAULT_AUDIO_SETTINGS });
    expect(loadAudioSettings(memoryStorage({ [AUDIO_STORAGE_KEY]: 'null' }))).toEqual({ ...DEFAULT_AUDIO_SETTINGS });
  });

  it('survives storage that throws (private windows, blocked site data)', () => {
    const throwing = {
      getItem: () => { throw new Error('SecurityError'); },
      setItem: () => { throw new Error('QuotaExceededError'); },
    };
    expect(loadAudioSettings(throwing)).toEqual({ ...DEFAULT_AUDIO_SETTINGS });
    expect(() => saveAudioSettings({ muted: false, volume: 1 }, throwing)).not.toThrow();
    expect(loadAudioSettings(null)).toEqual({ ...DEFAULT_AUDIO_SETTINGS });
  });
});

describe('volumeToGain', () => {
  it('is silent at 0, below unity at full, and curved in between', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBeLessThan(1);
    expect(volumeToGain(1)).toBeGreaterThan(0.5);
    expect(volumeToGain(0.5)).toBeLessThan(volumeToGain(1) / 2);
    expect(volumeToGain(-3)).toBe(0);
    expect(volumeToGain(9)).toBe(volumeToGain(1));
    expect(volumeToGain(Number.NaN)).toBe(volumeToGain(DEFAULT_AUDIO_SETTINGS.volume));
  });
});

describe('AudioEngine without Web Audio (Node, SSR)', () => {
  it('is a quiet no-op everywhere', () => {
    const e = new AudioEngine();
    expect(e.available).toBe(false);
    expect(() => e.install()).not.toThrow();
    expect(e.graph()).toBeNull();
    expect(e.unlocked).toBe(false);
    expect(() => { e.setMuffle(1); e.setBusLevel('music', 0.5); }).not.toThrow();
    const ready = vi.fn();
    e.onReady(ready);
    expect(ready).not.toHaveBeenCalled();
  });

  it('still keeps and publishes the player settings', () => {
    const e = new AudioEngine();
    const listener = vi.fn();
    const off = e.subscribe(listener);
    e.setMuted(true);
    expect(e.getSettings().muted).toBe(true);
    e.toggleMute();
    expect(e.getSettings().muted).toBe(false);
    e.setVolume(0.25);
    expect(e.getSettings().volume).toBe(0.25);
    expect(listener).toHaveBeenCalledTimes(3);
    // No change, no notification (useSyncExternalStore would re-render for nothing).
    e.setVolume(0.25);
    expect(listener).toHaveBeenCalledTimes(3);
    off();
    e.setVolume(0.9);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it('raising the volume unmutes; the snapshot object changes only on change', () => {
    const e = new AudioEngine();
    e.setMuted(true);
    const snap = e.getSettings();
    expect(e.getSettings()).toBe(snap);
    e.setVolume(0.6);
    expect(e.getSettings().muted).toBe(false);
    expect(e.getSettings()).not.toBe(snap);
    e.setVolume(-1);
    expect(e.getSettings().volume).toBe(0);
  });

  it('the synth and chimes do nothing without a graph', () => {
    expect(getSynth()).toBeNull();
    expect(() => playAlertChime('player')).not.toThrow();
  });
});

describe('Pacer', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('never fires while silent, and re-arms after silence instead of firing at once', () => {
    const p = new Pacer(1, 2);
    expect(p.due(0, 0)).toBe(false);
    expect(p.due(100, 0)).toBe(false);
    expect(p.due(100, 1)).toBe(false); // arms
    expect(p.due(100.1, 1)).toBe(false);
  });

  it('fires once per interval at full level', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // interval 1.5 s, first wait half that
    const p = new Pacer(1, 2);
    p.due(0, 1);
    let fired = 0;
    for (let t = 0; t <= 10; t += 0.1) if (p.due(t, 1)) fired++;
    expect(fired).toBeGreaterThanOrEqual(6);
    expect(fired).toBeLessThanOrEqual(7);
  });

  it('a faint layer is also a rare one', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const count = (level: number) => {
      const p = new Pacer(1, 2);
      let n = 0;
      for (let t = 0; t <= 60; t += 0.1) if (p.due(t, level)) n++;
      return n;
    };
    expect(count(0.2)).toBeLessThan(count(1) / 3);
    expect(count(0.2)).toBeGreaterThan(0);
  });
});
