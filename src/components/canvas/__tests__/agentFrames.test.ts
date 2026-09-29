import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  SHEET_FRAMES, SHEET_FRAME_COUNT, SHEET_FRAME_SIZE, SIDE_ENTER_DEG, SIDE_LEAVE_DEG,
  facingFromStep, pickAgentFrame, WALK_PX_PER_FRAME, type SheetFacing,
} from '../agentFrames';
import { SIDE_POSES, SIDE_PROFILE, bodyFrames } from '../../../lib/residentArt/bodySheet';
import { residentLook } from '../../../lib/residentArt/look';

const ROOT = join(__dirname, '../../../..');
const LUA = readFileSync(join(ROOT, 'scripts/aseprite/agent-sheets.lua'), 'utf8');

/** A unit step `deg` degrees above (negative) or below the horizontal, heading right. */
const step = (deg: number): [number, number] => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180)];

describe('facingFromStep', () => {
  it('turns its back when heading mostly north', () => {
    expect(facingFromStep(0, -1, 'down')).toBe('up');
    expect(facingFromStep(0.4, -1, 'down')).toBe('up');
  });

  it('faces the camera when heading south', () => {
    expect(facingFromStep(0, 1, 'up')).toBe('down');
  });

  it('shows the profile for sideways walks, either way (the rig mirrors it for left)', () => {
    expect(facingFromStep(1, -0.2, 'up')).toBe('side');
    expect(facingFromStep(-1, 0.1, 'down')).toBe('side');
    expect(facingFromStep(-1, 0, 'side')).toBe('side');
  });

  it('keeps the current facing when there is no movement', () => {
    for (const f of ['up', 'down', 'side'] as SheetFacing[]) expect(facingFromStep(0, 0, f)).toBe(f);
  });

  it('holds its view inside the hysteresis band, so a diagonal never flickers', () => {
    const mid = (SIDE_ENTER_DEG + SIDE_LEAVE_DEG) / 2;
    for (const deg of [SIDE_ENTER_DEG + 1, mid, SIDE_LEAVE_DEG - 1]) {
      expect(facingFromStep(...step(deg), 'side')).toBe('side');
      expect(facingFromStep(...step(deg), 'down')).toBe('down');
      expect(facingFromStep(...step(-deg), 'side')).toBe('side');
      expect(facingFromStep(...step(-deg), 'up')).toBe('up');
    }
  });

  it('switches only once a step clears the band', () => {
    expect(facingFromStep(...step(SIDE_ENTER_DEG - 1), 'down')).toBe('side');
    expect(facingFromStep(...step(SIDE_LEAVE_DEG + 1), 'side')).toBe('down');
    expect(facingFromStep(...step(-(SIDE_LEAVE_DEG + 1)), 'side')).toBe('up');
  });

  it('a vertical body in the band still turns round when the diagonal flips north/south', () => {
    expect(facingFromStep(...step(-45), 'down')).toBe('up');
    expect(facingFromStep(...step(45), 'up')).toBe('down');
  });

  it('an 8-directional zig-zag settles on one view instead of alternating per tile', () => {
    // East, north-east, east, north-east...: side-on the whole way.
    let f: SheetFacing = 'down';
    const seen = new Set<SheetFacing>();
    for (let i = 0; i < 8; i++) {
      f = facingFromStep(...step(i % 2 ? -45 : 0), f);
      if (i > 0) seen.add(f);
    }
    expect([...seen]).toEqual(['side']);
    // North, north-east...: the back the whole way.
    f = 'side';
    seen.clear();
    for (let i = 0; i < 8; i++) {
      f = facingFromStep(...step(i % 2 ? -45 : -90), f);
      seen.add(f);
    }
    expect([...seen]).toEqual(['up']);
  });
});

describe('pickAgentFrame', () => {
  const still = { walking: false, walkDistance: 0, blinking: false };

  it('stands on the idle frame of the current facing', () => {
    expect(pickAgentFrame({ ...still, facing: 'down' })).toBe(SHEET_FRAMES.idleDown);
    expect(pickAgentFrame({ ...still, facing: 'up' })).toBe(SHEET_FRAMES.idleUp);
    expect(pickAgentFrame({ ...still, facing: 'side' })).toBe(SHEET_FRAMES.idleSide);
  });

  it('blinks only when the face is visible head-on', () => {
    expect(pickAgentFrame({ ...still, facing: 'down', blinking: true })).toBe(SHEET_FRAMES.blinkDown);
    expect(pickAgentFrame({ ...still, facing: 'up', blinking: true })).toBe(SHEET_FRAMES.idleUp);
    expect(pickAgentFrame({ ...still, facing: 'side', blinking: true })).toBe(SHEET_FRAMES.idleSide);
  });

  it('steps through the four walk frames by distance covered', () => {
    for (const [facing, cycle] of [
      ['down', SHEET_FRAMES.walkDown], ['side', SHEET_FRAMES.walkSide],
    ] as const) {
      const at = (d: number) => pickAgentFrame({ facing, walking: true, walkDistance: d, blinking: false });
      expect([0, 1, 2, 3, 4].map(i => at(i * WALK_PX_PER_FRAME + 0.5))).toEqual([...cycle, cycle[0]]);
    }
  });

  it('walks away from the camera on the back-view frames', () => {
    const f = pickAgentFrame({ facing: 'up', walking: true, walkDistance: 0, blinking: false });
    expect(SHEET_FRAMES.walkUp).toContain(f);
  });
});

/**
 * The frame layout lives in three places: the Lua script that bakes the hand-drawn sheets, the
 * client's `SHEET_FRAMES`, and the generator for residents without art. A frame appended to one
 * and not the others shifts every later frame by one — walkers moonwalking on their idle pose —
 * and nothing else would notice, so these pin them together.
 */
describe('sheet layout: agent-sheets.lua ↔ SHEET_FRAMES ↔ bodySheet.ts', () => {
  const tags = [...LUA.matchAll(/\{ "(\w+)", (\d+), (\d+), (\d+) \}/g)].map(m => ({
    name: m[1], first: Number(m[2]) - 1, last: Number(m[3]) - 1, ms: Number(m[4]),
  }));
  const camel = (s: string) => s.replace(/_(\w)/g, (_, c: string) => c.toUpperCase());

  it('the Lua TAGS table is SHEET_FRAMES, frame for frame', () => {
    expect(tags.map(t => t.name)).toEqual([
      'idle_down', 'blink_down', 'walk_down', 'idle_up', 'walk_up', 'idle_side', 'walk_side',
    ]);
    const fromLua: Record<string, number | number[]> = {};
    for (const t of tags) {
      const range = Array.from({ length: t.last - t.first + 1 }, (_, i) => t.first + i);
      fromLua[camel(t.name)] = t.name.startsWith('walk') ? range : range[0];
    }
    expect(fromLua).toEqual(SHEET_FRAMES);
    expect(tags[tags.length - 1].last + 1).toBe(SHEET_FRAME_COUNT);
  });

  it('tags tile the strip with no gap or overlap', () => {
    tags.forEach((t, i) => expect(t.first).toBe(i === 0 ? 0 : tags[i - 1].last + 1));
  });

  it('the generator draws the same number of frames', () => {
    expect(bodyFrames(residentLook('Layout Check'))).toHaveLength(SHEET_FRAME_COUNT);
  });

  it('the generator ports the script\'s profile and stride verbatim', () => {
    const block = LUA.slice(LUA.indexOf('local PROFILE = {'), LUA.indexOf('}', LUA.indexOf('local PROFILE = {')));
    const profile = Object.fromEntries(
      [...block.matchAll(/\[(-?\d)\]\s*=\s*"([^"]+)"/g)].map(m => [Number(m[1]), m[2]]),
    );
    expect(profile).toEqual(SIDE_PROFILE);
    const poses = [...LUA.matchAll(
      /\{ far = (-?\d),(?: farLift = (\d),)? near = (-?\d),(?: nearLift = (\d),)? arm = (-?\d), bob = (\d) \}/g,
    )].map(m => ({
      far: Number(m[1]), ...(m[2] ? { farLift: Number(m[2]) } : {}),
      near: Number(m[3]), ...(m[4] ? { nearLift: Number(m[4]) } : {}),
      arm: Number(m[5]), bob: Number(m[6]),
    }));
    expect(poses).toEqual(SIDE_POSES);
    expect(poses).toHaveLength(1 + SHEET_FRAMES.walkSide.length);
  });

  it('every committed <name>_sheet.png was regenerated at the current width', () => {
    const dir = join(ROOT, 'public/sprites/agents');
    const sheets = readdirSync(dir).filter(f => f.endsWith('_sheet.png'));
    expect(sheets.length).toBeGreaterThanOrEqual(13);
    for (const f of sheets) {
      const png = readFileSync(join(dir, f));
      // IHDR: width and height are the big-endian words at bytes 16 and 20.
      expect([f, png.readUInt32BE(16), png.readUInt32BE(20)])
        .toEqual([f, SHEET_FRAME_SIZE * SHEET_FRAME_COUNT, SHEET_FRAME_SIZE]);
    }
  });
});
