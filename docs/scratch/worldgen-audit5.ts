/* Probe 5: wide dimension sweep looking for OOB market squares / any OOB geometry. */
import { generateWorld } from '../../server/lib/worldgen/pipeline';

const TILE = 32;
const origLog = console.log, origWarn = console.warn;
const mute = () => { console.log = () => {}; console.warn = () => {}; };
const unmute = () => { console.log = origLog; console.warn = origWarn; };
const tileRect = (l: any) => ({
  x0: Math.floor(l.position.x / TILE), y0: Math.floor(l.position.y / TILE),
  w: Math.ceil(l.position.width / TILE), h: Math.ceil(l.position.height / TILE),
});

const problems: Record<string, number> = {};
const samples: Record<string, string> = {};
let ok = 0, fail = 0;
mute();
for (let w = 44; w <= 120; w += 4) {
  for (let h = 34; h <= 100; h += 2) {
    for (const agents of [5, 14]) {
      let r: any;
      try {
        r = generateWorld({ sizeTier: 'auto', seed: `wide-${w}-${h}-${agents}`, overrides: { dimensions: { width: w, height: h } } } as any, agents);
      } catch { fail++; continue; }
      ok++;
      const W = r.dimensions.width, H = r.dimensions.height;
      for (const l of r.locations) {
        const q = tileRect(l);
        if (q.x0 < 0 || q.y0 < 0 || q.x0 + q.w > W || q.y0 + q.h > H) {
          const k = `OOB_${l.type}`;
          problems[k] = (problems[k] ?? 0) + 1;
          samples[k] ??= `map ${W}x${H} agents=${agents} :: ${l.name} tiles ${q.x0},${q.y0} ${q.w}x${q.h}`;
        }
        const dx = Math.floor(l.entry_point.x / TILE), dy = Math.floor(l.entry_point.y / TILE);
        if (dx < 0 || dx >= W || dy < 0 || dy >= H) {
          const k = `DOOROOB_${l.type}`;
          problems[k] = (problems[k] ?? 0) + 1;
          samples[k] ??= `map ${W}x${H} agents=${agents} :: ${l.name} door ${dx},${dy}`;
        }
      }
      for (const t of r.terrainTiles)
        if (t.x < 0 || t.x >= W || t.y < 0 || t.y >= H) problems['TERRAIN_OOB'] = (problems['TERRAIN_OOB'] ?? 0) + 1;
      for (const t of r.roads)
        if (t.x < 0 || t.x >= W || t.y < 0 || t.y >= H) problems['ROAD_OOB'] = (problems['ROAD_OOB'] ?? 0) + 1;
    }
  }
}
unmute();
console.log(`wide sweep: ${ok} worlds ok, ${fail} generation failures`);
if (!Object.keys(problems).length) console.log('  no OOB problems found');
for (const [k, v] of Object.entries(problems).sort((a, b) => b[1] - a[1]))
  console.log(`  ${k}: ${v}\n     e.g. ${samples[k] ?? '-'}`);
