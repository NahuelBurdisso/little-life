import { describe, it, expect } from 'vitest';
import { heldItemFor, heldPose, type HeldContext, type HeldPose } from '../heldItem';
import { HELD_ITEMS, HELD_FRAME_COUNT, type HeldItemId } from '../heldFrames';

const ctx = (over: Partial<HeldContext>): HeldContext => ({
  actionType: 'idle',
  zoneActivity: null,
  locationType: null,
  atWorkplace: false,
  workplaceType: null,
  ...over,
});

describe('heldItemFor — working at the workplace', () => {
  const cases: Array<[string, HeldItemId]> = [
    ['bakery', 'rolling_pin'],
    ['workshop', 'hammer'],
    ['clinic', 'clipboard'],
    ['shop', 'ledger'],
    ['pawnshop', 'ledger'],
    ['tavern', 'mug'],
    ['divebar', 'mug'],
    ['town_hall', 'quill'],
    ['prison', 'keys'],
    ['farm', 'hoe'],
  ];
  for (const [type, item] of cases) {
    it(`${type} -> ${item}`, () => {
      expect(heldItemFor(ctx({ actionType: 'working', atWorkplace: true, workplaceType: type }))).toBe(item);
    });
  }

  it('shows nothing when working away from the workplace', () => {
    expect(heldItemFor(ctx({ actionType: 'working', atWorkplace: false, workplaceType: 'workshop' }))).toBeNull();
  });
  it('shows nothing for a workplace type without a tool', () => {
    expect(heldItemFor(ctx({ actionType: 'working', atWorkplace: true, workplaceType: 'park' }))).toBeNull();
    expect(heldItemFor(ctx({ actionType: 'working', atWorkplace: true, workplaceType: null }))).toBeNull();
  });
});

describe('heldItemFor — actions', () => {
  it('eating -> plate', () => expect(heldItemFor(ctx({ actionType: 'eating' }))).toBe('plate'));
  it('shopping -> basket', () => expect(heldItemFor(ctx({ actionType: 'shopping' }))).toBe('basket'));
  it('socializing at a tavern -> mug', () => {
    expect(heldItemFor(ctx({ actionType: 'socializing', locationType: 'tavern' }))).toBe('mug');
    expect(heldItemFor(ctx({ actionType: 'socializing', locationType: 'divebar' }))).toBe('mug');
  });
  it('socializing elsewhere -> nothing', () => {
    expect(heldItemFor(ctx({ actionType: 'socializing', locationType: 'park' }))).toBeNull();
    expect(heldItemFor(ctx({ actionType: 'socializing', locationType: null }))).toBeNull();
  });
  it('sleeping, walking, talking and plain idling hold nothing', () => {
    expect(heldItemFor(ctx({ actionType: 'sleeping' }))).toBeNull();
    expect(heldItemFor(ctx({ actionType: 'walking' }))).toBeNull();
    expect(heldItemFor(ctx({ actionType: 'talking' }))).toBeNull();
    expect(heldItemFor(ctx({ actionType: 'idle' }))).toBeNull();
  });
});

describe('heldItemFor — zone activities', () => {
  const zone: Array<[string, HeldItemId | null]> = [
    ['fish', 'rod'],
    ['garden', 'watering_can'],
    ['forage', 'basket'],
    ['perform', 'lute'],
    ['contemplate', 'book'],
    ['rest', 'book'],
    ['jog', null],
    ['browse', null],
    ['shoplifting', null],
    ['pickpocket', null],
    ['comfort', null],
  ];
  for (const [z, item] of zone) {
    it(`idle + ${z} -> ${item}`, () => {
      expect(heldItemFor(ctx({ actionType: 'idle', zoneActivity: z }))).toBe(item);
    });
  }
  it('comfort actions can carry a zone activity too', () => {
    expect(heldItemFor(ctx({ actionType: 'comfort', zoneActivity: 'rest' }))).toBe('book');
  });
  it('an unknown zone activity holds nothing', () => {
    expect(heldItemFor(ctx({ actionType: 'idle', zoneActivity: 'moonwalk' }))).toBeNull();
  });
  it('a zone activity never overrides sleeping or walking', () => {
    expect(heldItemFor(ctx({ actionType: 'sleeping', zoneActivity: 'fish' }))).toBeNull();
    expect(heldItemFor(ctx({ actionType: 'walking', zoneActivity: 'fish' }))).toBeNull();
  });
});

describe('item table', () => {
  it('every item has a frame inside the atlas and a grip inside the cell', () => {
    for (const def of Object.values(HELD_ITEMS)) {
      expect(def.frame).toBeGreaterThanOrEqual(0);
      expect(def.frame).toBeLessThan(HELD_FRAME_COUNT);
      if (def.altFrame !== null) expect(def.altFrame).toBeLessThan(HELD_FRAME_COUNT);
      expect(def.grip.x).toBeGreaterThanOrEqual(0);
      expect(def.grip.x).toBeLessThanOrEqual(16);
      expect(def.grip.y).toBeGreaterThanOrEqual(0);
      expect(def.grip.y).toBeLessThanOrEqual(16);
    }
  });
  it('frames are unique across items and cover the whole atlas', () => {
    const used = Object.values(HELD_ITEMS).flatMap(d => (d.altFrame === null ? [d.frame] : [d.frame, d.altFrame]));
    expect(new Set(used).size).toBe(used.length);
    expect(used.length).toBe(HELD_FRAME_COUNT);
  });
});

describe('heldPose', () => {
  const out = (): HeldPose => ({ rot: 0, dy: 0, alt: false });

  it('swing tools rotate further as the stroke deepens', () => {
    const a = heldPose(HELD_ITEMS.hammer, 0, 0, 0, out());
    const b = heldPose(HELD_ITEMS.hammer, 0, 1, 0, out());
    expect(b.rot).toBeGreaterThan(a.rot);
  });
  it('the hammer uses its raised frame at the top of the stroke only', () => {
    expect(heldPose(HELD_ITEMS.hammer, 0, 0, 0, out()).alt).toBe(true);
    expect(heldPose(HELD_ITEMS.hammer, 0, 1, 0, out()).alt).toBe(false);
  });
  it('items without an alt frame never ask for one', () => {
    expect(heldPose(HELD_ITEMS.plate, 3, 0.5, 0, out()).alt).toBe(false);
  });
  it('the mug stays level most of the time and tips up during a sip', () => {
    const def = HELD_ITEMS.mug;
    let tipped = 0;
    let level = 0;
    for (let t = 0; t < 12; t += 0.1) {
      const p = heldPose(def, t, 0, 0, out());
      if (Math.abs(p.rot) > 0.2) tipped++; else level++;
    }
    expect(tipped).toBeGreaterThan(0);
    expect(level).toBeGreaterThan(tipped * 2);
  });
  it('the rod keeps bobbing', () => {
    const seen = new Set<number>();
    for (let t = 0; t < 4; t += 0.25) seen.add(Math.round(heldPose(HELD_ITEMS.rod, t, 0, 0, out()).rot * 1000));
    expect(seen.size).toBeGreaterThan(3);
  });
  it('phase offsets desynchronise neighbours', () => {
    const a = heldPose(HELD_ITEMS.rod, 1, 0, 0, out()).rot;
    const b = heldPose(HELD_ITEMS.rod, 1, 0, 1.3, out()).rot;
    expect(a).not.toBe(b);
  });
  it('writes into the given object and returns it', () => {
    const o = out();
    expect(heldPose(HELD_ITEMS.hoe, 0, 0.5, 0, o)).toBe(o);
  });
  it('static items do not move', () => {
    const a = heldPose(HELD_ITEMS.ledger, 0, 0, 0, out());
    const b = heldPose(HELD_ITEMS.ledger, 5, 0, 0, out());
    expect(a.rot).toBe(b.rot);
    expect(a.dy).toBe(b.dy);
  });
});
