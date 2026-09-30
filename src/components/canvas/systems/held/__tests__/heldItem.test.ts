import { describe, it, expect } from 'vitest';
import { BAG_CARRY_MS, bagDeadline, heldItemFor, heldPose, type HeldContext, type HeldPose } from '../heldItem';
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
  it('eating behind bars -> a bowl, not china', () => {
    expect(heldItemFor(ctx({ actionType: 'eating', locationType: 'prison' }))).toBe('bowl');
    expect(heldItemFor(ctx({ actionType: 'eating', locationType: 'tavern' }))).toBe('plate');
  });
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
    ['comfort', 'cup'],
    ['cook', 'pan'],
    ['speech', 'megaphone'],
    ['announce', 'megaphone'],
    ['protest', 'sign'],
    ['plant', 'hoe'],
    ['harvest', 'basket'],
    ['pick_flowers', 'basket'],
    ['collect_eggs', 'basket'],
    ['feed_animals', 'basket'],
    ['watch', null],
    ['people_watch', null],
    ['scheme', null],
    ['secret_meeting', null],
    ['confide', null],
  ];
  for (const [z, item] of zone) {
    it(`idle + ${z} -> ${item}`, () => {
      expect(heldItemFor(ctx({ actionType: 'idle', zoneActivity: z }))).toBe(item);
    });
  }
  it('a comfort visit is a cup of tea even without a zone tag', () => {
    expect(heldItemFor(ctx({ actionType: 'comfort' }))).toBe('cup');
  });
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

describe('heldItemFor — the shopping bag', () => {
  it('is carried while walking or idling after a trip', () => {
    expect(heldItemFor(ctx({ actionType: 'walking', bag: true }))).toBe('bag');
    expect(heldItemFor(ctx({ actionType: 'idle', bag: true }))).toBe('bag');
  });
  it('gives way to a real tool, and never comes to bed or work', () => {
    expect(heldItemFor(ctx({ actionType: 'idle', zoneActivity: 'fish', bag: true }))).toBe('rod');
    expect(heldItemFor(ctx({ actionType: 'sleeping', bag: true }))).toBeNull();
    expect(heldItemFor(ctx({ actionType: 'working', atWorkplace: true, workplaceType: 'bakery', bag: true }))).toBe('rolling_pin');
  });
  it('is absent unless asked for', () => {
    expect(heldItemFor(ctx({ actionType: 'walking' }))).toBeNull();
  });
});

describe('bagDeadline', () => {
  it('starts the clock when a trip ends and stops it when a new one begins', () => {
    expect(bagDeadline(true, false, 1000, 0)).toBe(1000 + BAG_CARRY_MS);
    expect(bagDeadline(true, true, 1000, 0)).toBe(0);
    expect(bagDeadline(false, true, 1000, 5000)).toBe(0);
  });
  it('keeps the deadline until it passes', () => {
    expect(bagDeadline(false, false, 2000, 9000)).toBe(9000);
    expect(bagDeadline(false, false, 9000, 9000)).toBe(0);
    expect(bagDeadline(false, false, 10_000, 9000)).toBe(0);
    expect(bagDeadline(false, false, 1000, 0)).toBe(0);
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
  it('the cup and the megaphone are lifted now and then, then rest', () => {
    for (const id of ['cup', 'megaphone'] as const) {
      const def = HELD_ITEMS[id];
      const rots = new Set<number>();
      for (let t = 0; t < def.rate; t += 0.1) rots.add(Math.round(heldPose(def, t, 0, 0, out()).rot * 100));
      expect(rots.size, id).toBeGreaterThan(2);
    }
  });
  it('static items do not move', () => {
    const a = heldPose(HELD_ITEMS.ledger, 0, 0, 0, out());
    const b = heldPose(HELD_ITEMS.ledger, 5, 0, 0, out());
    expect(a.rot).toBe(b.rot);
    expect(a.dy).toBe(b.dy);
  });
});

describe('heldItemFor — a baby in arms', () => {
  it('carries the baby at home and on a stroll', () => {
    expect(heldItemFor(ctx({ baby: true, locationType: 'home' }))).toBe('baby');
    expect(heldItemFor(ctx({ baby: true, zoneActivity: 'stroll' }))).toBe('baby');
    expect(heldItemFor(ctx({ actionType: 'comfort', baby: true, locationType: 'home' }))).toBe('baby');
  });

  it('leaves the baby minded elsewhere, and never without one', () => {
    expect(heldItemFor(ctx({ baby: true, locationType: 'tavern' }))).toBeNull();
    expect(heldItemFor(ctx({ actionType: 'working', baby: true, atWorkplace: true, workplaceType: 'bakery' }))).toBe('rolling_pin');
    expect(heldItemFor(ctx({ locationType: 'home' }))).toBeNull();
  });
});
