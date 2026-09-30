import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  EMOTE_NAMES,
  EMOTE_FRAMES,
  EMOTE_FRAME_COUNT,
  EMOTE_CELL,
  EMOTE_EMOJI_FALLBACK,
  emoteFrameAt,
  isEmoteName,
} from '../emoteFrames';

const root = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

describe('emote frame table', () => {
  it('has at least one frame per name and every index inside the atlas', () => {
    for (const name of EMOTE_NAMES) {
      const { frames, fps } = EMOTE_FRAMES[name];
      expect(frames.length, name).toBeGreaterThanOrEqual(1);
      expect(fps, name).toBeGreaterThan(0);
      for (const f of frames) {
        expect(Number.isInteger(f), name).toBe(true);
        expect(f, name).toBeGreaterThanOrEqual(0);
        expect(f, name).toBeLessThan(EMOTE_FRAME_COUNT);
      }
    }
  });

  it('packs the cells back to back: no gaps, no cell used by two emotes', () => {
    const all = EMOTE_NAMES.flatMap(n => EMOTE_FRAMES[n].frames);
    expect(new Set(all).size).toBe(all.length);
    expect(Math.max(...all)).toBe(EMOTE_FRAME_COUNT - 1);
    expect(all.length).toBe(EMOTE_FRAME_COUNT);
  });

  it('has no duplicate names and covers everything the plan lists', () => {
    expect(new Set(EMOTE_NAMES).size).toBe(EMOTE_NAMES.length);
    const required = [
      'heart', 'anger', 'laugh', 'wave', 'question', 'exclaim', 'zzz', 'cry', 'sparkle', 'fish',
      'flower', 'music', 'sweat', 'money', 'skull', 'fire', 'star', 'drink', 'sick', 'think',
      'work', 'gift', 'handcuffs', 'whisper', 'levelup', 'candle', 'cake', 'broken_heart', 'dizzy',
      'blush', 'kiss', 'wink',
    ];
    expect([...EMOTE_NAMES].sort()).toEqual([...required].sort());
  });

  it('covers every emote name BubbleSystem, GameCanvas and the server can ask for', () => {
    const bubble = read('src/components/canvas/BubbleSystem.ts');
    const canvas = read('src/components/canvas/GameCanvas.tsx');
    const literals = new Set<string>();
    // Values of the STATE_EMOTES / ACTIVITY_EMOTES maps.
    for (const block of bubble.matchAll(/const (?:STATE|ACTIVITY)_EMOTES[^=]*=\s*\{([\s\S]*?)\};/g)) {
      for (const m of block[1].matchAll(/:\s*'([a-z_]+)'/g)) literals.add(m[1]);
    }
    // Direct showEmote(aid, "x", pos) calls.
    for (const m of bubble.matchAll(/showEmote\(\s*\w+,\s*["']([a-z_]+)["']/g)) literals.add(m[1]);
    // Looped pose emotes.
    for (const m of bubble.matchAll(/LOOPED_EMOTES = new Set\(\[([^\]]*)\]/g)) {
      for (const s of m[1].matchAll(/'([a-z_]+)'/g)) literals.add(s[1]);
    }
    for (const block of canvas.matchAll(/const POSE_EMOTES[^=]*=\s*\{([\s\S]*?)\};/g)) {
      for (const m of block[1].matchAll(/:\s*'([a-z_]+)'/g)) literals.add(m[1]);
    }
    // Greeting emote stamped by the perception registry.
    const perception = read('server/lib/perception/perceptionRegistry.ts');
    for (const m of perception.matchAll(/emote:\s*'([a-z_]+)'/g)) literals.add(m[1]);

    expect(literals.size).toBeGreaterThan(10);
    for (const name of literals) expect(isEmoteName(name), name).toBe(true);
  });

  it('keeps an emoji fallback for every legacy name', () => {
    for (const name of Object.keys(EMOTE_EMOJI_FALLBACK)) expect(isEmoteName(name), name).toBe(true);
    for (const name of ['heart', 'anger', 'zzz', 'work', 'sick', 'think', 'drink']) {
      expect(EMOTE_EMOJI_FALLBACK[name], name).toBeTruthy();
    }
  });
});

describe('emoteFrameAt', () => {
  it('returns null for unknown names so callers fall back to the emoji', () => {
    expect(emoteFrameAt('not_an_emote', 0)).toBeNull();
    expect(isEmoteName('not_an_emote')).toBe(false);
  });

  it('starts on the first frame and steps at the emote fps', () => {
    const { frames, fps } = EMOTE_FRAMES.heart;
    expect(frames.length).toBeGreaterThan(1);
    const step = 1000 / fps;
    expect(emoteFrameAt('heart', 0)).toBe(frames[0]);
    expect(emoteFrameAt('heart', step * 0.99)).toBe(frames[0]);
    expect(emoteFrameAt('heart', step * 1.01)).toBe(frames[1]);
  });

  it('loops and tolerates negative, huge or NaN elapsed times', () => {
    const { frames, fps } = EMOTE_FRAMES.zzz;
    const step = 1000 / fps;
    expect(emoteFrameAt('zzz', step * frames.length * 3 + 1)).toBe(frames[0]);
    expect(emoteFrameAt('zzz', -50)).toBe(frames[0]);
    expect(frames).toContain(emoteFrameAt('zzz', 1e12));
    expect(emoteFrameAt('zzz', NaN)).toBe(frames[0]);
  });
});

describe('atlas assets', () => {
  it('keeps the Lua header order in sync with the frame table', () => {
    const lua = read('scripts/aseprite/emotes.lua');
    const line = lua.split('\n').find(l => l.startsWith('-- ORDER:'));
    expect(line, 'emotes.lua needs a "-- ORDER: name:frames ..." header').toBeTruthy();
    const parsed = line!.replace('-- ORDER:', '').trim().split(/\s+/).map(t => {
      const [name, n] = t.split(':');
      return [name, Number(n)] as const;
    });
    expect(parsed.map(p => p[0])).toEqual([...EMOTE_NAMES]);
    for (const [name, n] of parsed) {
      expect(n, name).toBe(EMOTE_FRAMES[name as keyof typeof EMOTE_FRAMES].frames.length);
    }
  });

  it('ships a strip PNG exactly EMOTE_FRAME_COUNT cells wide', () => {
    const png = join(root, 'public/sprites/fx/emotes.png');
    expect(existsSync(png)).toBe(true);
    const buf = readFileSync(png);
    expect(buf.readUInt32BE(16)).toBe(EMOTE_FRAME_COUNT * EMOTE_CELL);
    expect(buf.readUInt32BE(20)).toBe(EMOTE_CELL);
  });
});
