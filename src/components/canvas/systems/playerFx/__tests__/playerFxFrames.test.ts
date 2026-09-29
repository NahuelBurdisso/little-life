import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DIGITS_FRAME_COUNT, DIGITS_FRAME_SIZE, PFX_ANIMS, PFX_FRAME_COUNT, PFX_FRAME_SIZE,
  digitCells, pfxDuration, pfxFrame, type PfxName,
} from '../playerFxFrames';

const root = join(__dirname, '..', '..', '..', '..', '..', '..');
const names = Object.keys(PFX_ANIMS) as PfxName[];

/** PNG IHDR: width and height are big-endian u32 at bytes 16 and 20. */
function pngSize(rel: string): { w: number; h: number } {
  const b = readFileSync(join(root, rel));
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

describe('PFX_ANIMS layout', () => {
  it('tiles the strip exactly: no gaps, no overlaps, nothing past the end', () => {
    const sorted = [...names].sort((a, b) => PFX_ANIMS[a].start - PFX_ANIMS[b].start);
    let next = 0;
    for (const n of sorted) {
      expect(PFX_ANIMS[n].start, n).toBe(next);
      next += PFX_ANIMS[n].count;
    }
    expect(next).toBe(PFX_FRAME_COUNT);
  });

  it('matches the LAYOUT line of the Lua script, in order', () => {
    const lua = readFileSync(join(root, 'scripts/aseprite/player-fx.lua'), 'utf8');
    const line = lua.split(/\r?\n/).find(l => l.startsWith('-- LAYOUT:'));
    expect(line).toBeTruthy();
    const listed = line!.replace('-- LAYOUT:', '').trim().split(/\s+/).map(s => s.split(':'));
    const byStart = [...names].sort((a, b) => PFX_ANIMS[a].start - PFX_ANIMS[b].start);
    expect(listed.map(([n]) => n)).toEqual(byStart);
    for (const [n, c] of listed) expect(Number(c), n).toBe(PFX_ANIMS[n as PfxName].count);
  });

  it('the exported PNG strips have the size the loader expects', () => {
    const fx = pngSize('public/sprites/fx/playerfx.png');
    expect(fx).toEqual({ w: PFX_FRAME_SIZE * PFX_FRAME_COUNT, h: PFX_FRAME_SIZE });
    const dg = pngSize('public/sprites/fx/playerfxdigits.png');
    expect(dg).toEqual({ w: DIGITS_FRAME_SIZE * DIGITS_FRAME_COUNT, h: DIGITS_FRAME_SIZE });
  });
});

describe('pfxFrame', () => {
  it('starts on the first cell and steps at fps', () => {
    expect(pfxFrame('clash', 0)).toBe(PFX_ANIMS.clash.start);
    expect(pfxFrame('clash', 1 / 6 + 0.001)).toBe(PFX_ANIMS.clash.start + 1);
    expect(pfxFrame('clash', -3)).toBe(PFX_ANIMS.clash.start);
  });
  it('holds the last cell of a one-shot but wraps when cycling', () => {
    const a = PFX_ANIMS.poof;
    expect(pfxFrame('poof', 99)).toBe(a.start + a.count - 1);
    const seen = new Set<number>();
    for (let t = 0; t < 3; t += 0.05) seen.add(pfxFrame('poof', t, true));
    expect(seen.size).toBe(a.count);
    for (const f of seen) {
      expect(f).toBeGreaterThanOrEqual(a.start);
      expect(f).toBeLessThan(a.start + a.count);
    }
  });
  it('durations are positive', () => {
    for (const n of names) expect(pfxDuration(n), n).toBeGreaterThan(0);
  });
});

describe('digitCells', () => {
  it('is a plus followed by one cell per digit', () => {
    expect(digitCells(0)).toEqual([10, 0]);
    expect(digitCells(50)).toEqual([10, 5, 0]);
    expect(digitCells(1234)).toEqual([10, 1, 2, 3, 4]);
  });
  it('floors fractions and survives junk', () => {
    expect(digitCells(7.9)).toEqual([10, 7]);
    expect(digitCells(-5)).toEqual([10, 0]);
    expect(digitCells(NaN)).toEqual([10, 0]);
  });
  it('every cell exists in the digits strip', () => {
    for (const c of digitCells(9876543210)) expect(c).toBeLessThan(DIGITS_FRAME_COUNT);
  });
});
