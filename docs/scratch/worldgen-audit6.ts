/* Probe 6: alley branch distribution + single-seed repro detail. */
import { generateWorld } from '../../server/lib/worldgen/pipeline';
const TILE = 32;
const o = console.log, w2 = console.warn;
const mute = () => { console.log = () => {}; console.warn = () => {}; };
const unmute = () => { console.log = o; console.warn = w2; };

mute();
const shapes: Record<string, number> = {};
let blockedByShape: Record<string, number> = {};
for (const agents of [6, 10, 14, 20, 30]) {
  for (let i = 0; i < 60; i++) {
    const r = generateWorld({ sizeTier: 'auto', overrides: {}, seed: `al-${agents}-${i}` } as any, agents);
    const a = r.locations.find((l: any) => l.type === 'alley');
    if (!a) continue;
    const tw = Math.ceil(a.position.width / TILE), th = Math.ceil(a.position.height / TILE);
    // vertical-gap branch => height == gapY (2 or 3) and width == overlap (>=2)
    // horizontal-gap branch => width == gapX (2 or 3)
    const branch = th <= 3 && tw > 3 ? 'vertical-gap' : tw <= 3 && th > 3 ? 'horizontal-gap' : `ambiguous ${tw}x${th}`;
    shapes[branch] = (shapes[branch] ?? 0) + 1;
    const W = r.dimensions.width;
    const dx = Math.floor(a.entry_point.x / TILE), dy = Math.floor(a.entry_point.y / TILE);
    if (r.collisionGrid[dy * W + dx] === '1') blockedByShape[branch] = (blockedByShape[branch] ?? 0) + 1;
  }
}
unmute();
console.log('--- alley branch distribution ---');
for (const [k, v] of Object.entries(shapes))
  console.log(`  ${k}: ${v} alleys, entry inside a solid building: ${blockedByShape[k] ?? 0}`);

// repro detail
mute();
const r = generateWorld({ sizeTier: 'auto', overrides: {}, seed: 'audit-8-2' } as any, 8);
unmute();
const a = r.locations.find((l: any) => l.type === 'alley')!;
console.log('');
console.log('--- repro seed=audit-8-2 agents=8 ---');
console.log(`  map ${r.dimensions.width}x${r.dimensions.height}`);
console.log(`  alley rect tiles x=${a.position.x / TILE} y=${a.position.y / TILE} ${a.position.width / TILE}x${a.position.height / TILE}`);
console.log(`  alley entry tile = (${a.entry_point.x / TILE}, ${a.entry_point.y / TILE})  collision='${r.collisionGrid[(a.entry_point.y / TILE) * r.dimensions.width + a.entry_point.x / TILE]}'`);
for (const l of r.locations) {
  const x0 = l.position.x / TILE, y0 = l.position.y / TILE, tw = l.position.width / TILE, th = l.position.height / TILE;
  const dx = a.entry_point.x / TILE, dy = a.entry_point.y / TILE;
  if (dx >= x0 && dx < x0 + tw && dy >= y0 && dy < y0 + th)
    console.log(`  entry tile lies inside: ${l.name} (${l.type}) rect ${x0},${y0} ${tw}x${th}`);
}
console.log(`  proposed fix y = alleyY + floor(gapY/2) = ${a.position.y / TILE + Math.floor((a.position.height / TILE) / 2)} → collision='${r.collisionGrid[(a.position.y / TILE + Math.floor((a.position.height / TILE) / 2)) * r.dimensions.width + a.entry_point.x / TILE]}'`);
