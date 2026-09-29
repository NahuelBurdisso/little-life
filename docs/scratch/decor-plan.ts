// Dumps eventDecor placements for a 12x8-tile town square to JSON for decor-mock.lua.
//   npx tsx docs/scratch/decor-plan.ts docs/scratch/shots/decor-plan.json
import fs from 'node:fs';
import { planEvent } from '../../src/components/canvas/systems/townEvents/eventDecor';

const OX = 16, OY = 36;
const square = { id: 1, type: 'town_square', position: { x: OX, y: OY, width: 384, height: 256 }, entry_point: { x: 200, y: 200 } };
// A bakery below the square to show flames on a roof.
const bakery = { id: 5, type: 'bakery', position: { x: 16, y: 320, width: 128, height: 96 }, entry_point: { x: 80, y: 416 } };
const clinic = { id: 3, type: 'clinic', position: { x: 200, y: 320, width: 128, height: 96 }, entry_point: { x: 264, y: 416 } };
const locs = [square, bakery, clinic];

const types = ['festival', 'wedding', 'funeral', 'harvest', 'competition', 'town_meeting', 'scandal',
  'market_day', 'blessing', 'traveling_merchant', 'sickness', 'fire_outbreak'];
const out: any = { square: square.position, bakery: bakery.position, clinic: clinic.position, events: {} };
for (const t of types) {
  out.events[t] = planEvent({ id: 7, type: t, location_id: t === 'fire_outbreak' ? 5 : null }, locs, { w: 1920, h: 1280 });
}
fs.writeFileSync(process.argv[2] ?? 'docs/scratch/shots/decor-plan.json', JSON.stringify(out));
console.log(Object.entries(out.events).map(([k, v]: any) => `${k}:${v.length}`).join(' '));
