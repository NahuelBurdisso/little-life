import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVITY_SPECS, DRUNK_LOOP } from '../activitySpecs';
import { isEmoteName } from '../../../emoteFrames';
import { ACTIVITY_POSE_KINDS } from '../../../statePose';
import {
  ACTIVITY_FX_URL, FX_CELLS, FX_CELL_COUNT, FX_CELL_SIZE, FX_SPRITE_NAMES, fxCellAt,
} from '../activityFrames';
import type { ActivityId } from '../activity';

const root = join(__dirname, '..', '..', '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(root, rel), 'utf8');

const ids = Object.keys(ACTIVITY_SPECS) as ActivityId[];

describe('activity spec table', () => {
  it('covers every activity the resolver can return', () => {
    const src = read('src/components/canvas/systems/activityFx/activity.ts');
    const union = src.match(/export type ActivityId =([\s\S]*?);/)![1];
    const declared = [...union.matchAll(/'([a-z_]+)'/g)].map(m => m[1]);
    expect([...ids].sort()).toEqual([...declared].sort());
  });

  it('only uses emotes, poses and particle sprites that exist', () => {
    for (const id of ids) {
      const s = ACTIVITY_SPECS[id];
      expect(ACTIVITY_POSE_KINDS, id).toContain(s.pose);
      for (const name of [s.startEmote, s.endEmote, ...(s.loopEmotes?.flatMap(l => l.names) ?? [])]) {
        if (name) expect(isEmoteName(name), `${id}: ${name}`).toBe(true);
      }
      for (const em of s.emitters ?? []) expect(FX_SPRITE_NAMES, id).toContain(em.sprite);
    }
    for (const name of DRUNK_LOOP.names) expect(isEmoteName(name), name).toBe(true);
  });

  it('every emitter has a cadence, a life and a sane rate', () => {
    for (const id of ids) {
      for (const em of ACTIVITY_SPECS[id].emitters ?? []) {
        expect(em.life, id).toBeGreaterThan(0);
        if (em.trigger === 'stroke') {
          expect(em.every, `${id} stroke emitters ignore every`).toBeUndefined();
        } else {
          // Effects fire for a dozen agents at once: nothing may stream.
          expect(em.every, id).toBeGreaterThanOrEqual(0.075);
        }
        if (em.window) {
          expect(em.window.to, id).toBeGreaterThan(em.window.from);
          expect(em.window.to, id).toBeLessThanOrEqual(em.window.period);
        }
      }
      for (const le of ACTIVITY_SPECS[id].loopEmotes ?? []) {
        // Emotes float for 1.5 s; anything faster than every 4 s is a stream of them.
        expect(le.every, id).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it('stroke emitters only belong to work (the only time workStroke moves)', () => {
    for (const id of ids) {
      const stroky = (ACTIVITY_SPECS[id].emitters ?? []).some(e => e.trigger === 'stroke');
      if (stroky) expect(id.startsWith('work_'), id).toBe(true);
    }
  });

  it('gives fishing a bobber and a bite that fits its cycle', () => {
    const b = ACTIVITY_SPECS.fish.bobber!;
    expect(b.dipFrom).toBeLessThan(b.dipTo);
    expect(b.dipTo).toBeLessThanOrEqual(b.cycle);
    // The leap follows the dip.
    const fish = ACTIVITY_SPECS.fish.emitters!.find(e => e.sprite === 'fish')!;
    expect(fish.every).toBe(b.cycle);
    expect(fish.offset).toBeGreaterThanOrEqual(b.dipFrom);
    expect(fish.offset).toBeLessThan(b.dipTo);
  });

  it('lines the garden pour up with the watering can (HELD_ITEMS.watering_can sips 0.9 s of every 9)', () => {
    const held = read('src/components/canvas/systems/held/heldFrames.ts');
    expect(held).toMatch(/watering_can:[^\n]*motion: 'sip'[^\n]*rate: 9/);
    const w = ACTIVITY_SPECS.garden.emitters![0].window!;
    expect(w.period).toBe(9);
    expect(w.to).toBeLessThanOrEqual(0.9);
  });

  it('marks the thief and the conspirator with a shady tint', () => {
    for (const id of ['shoplift', 'pickpocket', 'scheme'] as const) {
      expect(ACTIVITY_SPECS[id].tint, id).toBeDefined();
    }
    expect(ACTIVITY_SPECS.shoplift.endEmote).toBe('money');
  });

  it('shows the private evening only as hearts over the house, never on the bodies', () => {
    const s = ACTIVITY_SPECS.tryst;
    expect(s.pose).toBe('none');
    expect(s.emitters).toHaveLength(1);
    const em = s.emitters![0];
    // Anchored to the roofline: the sprites are lying in bed, where no effect is ever drawn.
    expect(em.at).toBe('roof');
    expect(em.sprite).toBe('heart');
    // Two people run this spec, so each stays well under a heart every 5 s: a hint, not a shower.
    expect(em.every).toBeGreaterThanOrEqual(6);
    expect(s.loopEmotes).toBeUndefined();
    expect(s.startEmote).toBeUndefined();
  });

  it('only roofline emitters exist for the private evening; every other activity anchors to a body', () => {
    for (const id of ids) {
      for (const em of ACTIVITY_SPECS[id].emitters ?? []) {
        if (em.at === 'roof') expect(id, 'only the private evening has a roofline effect').toBe('tryst');
      }
    }
  });

  it('has the dawn walk home be a furtive shifty walk with a nervous bead now and then', () => {
    const s = ACTIVITY_SPECS.sneak_home;
    expect(s.pose).toBe('shifty');
    expect(s.tint).toBeDefined();
    expect(s.emitters).toBeUndefined();
    expect(s.loopEmotes?.flatMap(l => l.names)).toEqual(['sweat']);
  });

  it('shows jogging as a jog and the crouch for shoplifting', () => {
    expect(ACTIVITY_SPECS.jog.pose).toBe('jog');
    expect(ACTIVITY_SPECS.shoplift.pose).toBe('crouch');
  });
});

describe('particle atlas', () => {
  it('packs the cells back to back', () => {
    let next = 0;
    for (const name of FX_SPRITE_NAMES) {
      expect(FX_CELLS[name].start, name).toBe(next);
      next += FX_CELLS[name].count;
    }
    expect(next).toBe(FX_CELL_COUNT);
  });

  it('keeps the Lua header order in sync with the frame table', () => {
    const lua = read('scripts/aseprite/activity-fx.lua');
    const line = lua.split('\n').find(l => l.startsWith('-- ORDER:'));
    expect(line, 'activity-fx.lua needs a "-- ORDER: name:frames ..." header').toBeTruthy();
    const parsed = line!.replace('-- ORDER:', '').trim().split(/\s+/).map(t => {
      const [name, n] = t.split(':');
      return [name, Number(n)] as const;
    });
    expect(parsed.map(p => p[0])).toEqual([...FX_SPRITE_NAMES]);
    for (const [name, n] of parsed) expect(n, name).toBe(FX_CELLS[name as keyof typeof FX_CELLS].count);
  });

  it('has a heart particle of three frames', () => {
    expect(FX_SPRITE_NAMES).toContain('heart');
    expect(FX_CELLS.heart.count).toBe(3);
    // The last cell of the strip: appended, so no earlier particle moved.
    expect(FX_CELLS.heart.start + FX_CELLS.heart.count).toBe(FX_CELL_COUNT);
  });

  it('ships a strip PNG exactly FX_CELL_COUNT cells wide', () => {
    const png = join(root, 'public', ACTIVITY_FX_URL);
    expect(existsSync(png)).toBe(true);
    const buf = readFileSync(png);
    expect(buf.readUInt32BE(16)).toBe(FX_CELL_COUNT * FX_CELL_SIZE);
    expect(buf.readUInt32BE(20)).toBe(FX_CELL_SIZE);
  });
});

describe('fxCellAt', () => {
  it('stretches the frames over a life and holds the last', () => {
    const { start, count } = FX_CELLS.steam;
    expect(count).toBe(3);
    expect(fxCellAt('steam', 0, 1, 'life')).toBe(start);
    expect(fxCellAt('steam', 0.5, 1, 'life')).toBe(start + 1);
    expect(fxCellAt('steam', 0.99, 1, 'life')).toBe(start + 2);
    expect(fxCellAt('steam', 5, 1, 'life')).toBe(start + 2);
  });
  it('loops at fps', () => {
    const { start, count } = FX_CELLS.coin;
    expect(fxCellAt('coin', 0, 1, 'loop', 10)).toBe(start);
    expect(fxCellAt('coin', 0.11, 1, 'loop', 10)).toBe(start + 1);
    expect(fxCellAt('coin', 0.1 * count + 0.01, 1, 'loop', 10)).toBe(start);
  });
  it('tolerates negative ages and zero lives', () => {
    expect(fxCellAt('steam', -1, 1, 'life')).toBe(FX_CELLS.steam.start);
    expect(fxCellAt('steam', 1, 0, 'life')).toBe(FX_CELLS.steam.start);
  });
});
