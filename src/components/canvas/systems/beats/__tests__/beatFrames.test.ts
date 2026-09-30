import { describe, it, expect } from 'vitest';
import {
  BEATS_FRAME_COUNT, BEAT_STYLE, FX_ANIMS, beatDuration, fxDuration, fxFrame, kissFacing, KISS_LEAN_S,
  type FxName,
} from '../beatFrames';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BeatKind } from '../beatDetect';

const names = Object.keys(FX_ANIMS) as FxName[];

describe('FX_ANIMS layout', () => {
  it('tiles the strip exactly: no gaps, no overlaps, nothing past the end', () => {
    const sorted = [...names].sort((a, b) => FX_ANIMS[a].start - FX_ANIMS[b].start);
    let next = 0;
    for (const n of sorted) {
      expect(FX_ANIMS[n].start, n).toBe(next);
      next += FX_ANIMS[n].count;
    }
    expect(next).toBe(BEATS_FRAME_COUNT);
  });

  it('every effect lasts a sensible moment (one-shot, not a fixture)', () => {
    for (const n of names) {
      if (n === 'giftBox') continue; // the flying box is a single held frame
      const d = fxDuration(n);
      expect(d, n).toBeGreaterThanOrEqual(0.6);
      expect(d, n).toBeLessThanOrEqual(2);
    }
  });
});

describe('fxFrame', () => {
  it('starts on the first cell and steps at fps', () => {
    expect(fxFrame('brawl', 0)).toBe(0);
    expect(fxFrame('brawl', 0.21)).toBe(1); // 5 fps = 0.2 s per cell
    expect(fxFrame('brawl', -1)).toBe(0);
  });
  it('holds the last cell of a one-shot', () => {
    expect(fxFrame('brawl', 99)).toBe(FX_ANIMS.brawl.start + FX_ANIMS.brawl.count - 1);
  });
  it('loops a looping effect and stays inside its own cells', () => {
    const a = FX_ANIMS.cake;
    const seen = new Set<number>();
    for (let t = 0; t < fxDuration('cake'); t += 0.05) seen.add(fxFrame('cake', t));
    expect(seen.size).toBe(a.count);
    for (const f of seen) {
      expect(f).toBeGreaterThanOrEqual(a.start);
      expect(f).toBeLessThan(a.start + a.count);
    }
    // Second loop restarts on the first cell.
    expect(fxFrame('cake', a.count / a.fps + 0.001)).toBe(a.start);
  });
});

describe('BEAT_STYLE', () => {
  const kinds: BeatKind[] = [
    'fight', 'gift', 'romance', 'heartbreak', 'arrest', 'secret', 'levelup', 'birthday', 'death', 'kiss',
  ];
  it('dresses every beat kind with a known effect', () => {
    for (const k of kinds) {
      expect(FX_ANIMS[BEAT_STYLE[k].fx], k).toBeDefined();
      expect(beatDuration(k), k).toBeGreaterThan(0.6);
    }
  });
  it('the gift flight is part of the gift beat', () => {
    expect(beatDuration('gift')).toBeGreaterThan(fxDuration('giftPop'));
  });
});

describe('kiss dressing', () => {
  it('is its own effect with the kiss and blush emotes, not the romance hearts', () => {
    expect(BEAT_STYLE.kiss.fx).toBe('kiss');
    expect(BEAT_STYLE.kiss.emotes).toEqual(['kiss', 'blush']);
    expect(BEAT_STYLE.kiss.lift).toBe(20);
    expect(FX_ANIMS.kiss.count).toBe(5);
  });

  it('the lean is over before the hearts are', () => {
    expect(KISS_LEAN_S).toBeLessThanOrEqual(beatDuration('kiss') + 0.3);
    expect(KISS_LEAN_S).toBeGreaterThan(0.5);
  });

  it('lists the kiss cells in the Lua header and ships a strip exactly BEATS_FRAME_COUNT wide', () => {
    const root = join(__dirname, '..', '..', '..', '..', '..', '..');
    const lua = readFileSync(join(root, 'scripts/aseprite/beat-fx.lua'), 'utf8');
    const { start, count } = FX_ANIMS.kiss;
    expect(lua).toMatch(/--\s+48-52 kiss/);
    expect([start, start + count - 1]).toEqual([48, 52]);
    const png = readFileSync(join(root, 'public/sprites/fx/beats.png'));
    expect(png.readUInt32BE(16)).toBe(BEATS_FRAME_COUNT * 32);
    expect(png.readUInt32BE(20)).toBe(32);
  });
});

describe('kissFacing', () => {
  it('turns each of the pair toward the other', () => {
    expect(kissFacing(10, 30)).toEqual([1, -1]);
    expect(kissFacing(30, 10)).toEqual([-1, 1]);
  });
  it('leaves facing alone when they share a column', () => {
    expect(kissFacing(20, 20)).toBeNull();
    expect(kissFacing(20, 20.5)).toBeNull();
  });
});
