/* Probe 4: farmyard root cause + dimension sweep for OOB / blocked doors. */
import { generateWorld } from '../../server/lib/worldgen/pipeline';
import { ENCLOSED_BUILDING_TYPES } from '../../server/lib/worldgen/buildingTemplates';

const TILE = 32;
const origLog = console.log, origWarn = console.warn;
const mute = () => { console.log = () => {}; console.warn = () => {}; };
const unmute = () => { console.log = origLog; console.warn = origWarn; };

const tileRect = (l: any) => ({
  x0: Math.floor(l.position.x / TILE),
  y0: Math.floor(l.position.y / TILE),
  w: Math.ceil(l.position.width / TILE),
  h: Math.ceil(l.position.height / TILE),
});

// -------------------------------------------------------------------------
// A. Farmyard: reconstruct layout's `blocked` mask and test the two candidate
//    offsets used by deriveFarmyard (+1) vs the BUILDING_GAP-correct one (+2).
// -------------------------------------------------------------------------
const BUILDING_GAP = 2, ROAD_BUFFER = 1, BORDER_BUFFER = 2;
function rebuildBlocked(r: any) {
  const { width, height } = r.dimensions;
  const blocked = new Set<string>();
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++)
      if (x < BORDER_BUFFER || x >= width - BORDER_BUFFER || y < BORDER_BUFFER || y >= height - BORDER_BUFFER)
        blocked.add(`${x},${y}`);
  for (const t of r.roads)
    for (let dy = -ROAD_BUFFER; dy <= ROAD_BUFFER; dy++)
      for (let dx = -ROAD_BUFFER; dx <= ROAD_BUFFER; dx++)
        blocked.add(`${t.x + dx},${t.y + dy}`);
  // template-placed buildings only (types with a template), not derived outdoors
  const DERIVED = new Set(['mainstreet', 'market_square', 'alley', 'farmyard', 'home']);
  for (const l of r.locations) {
    if (DERIVED.has(l.type)) continue;
    const q = tileRect(l);
    for (let y = q.y0 - BUILDING_GAP; y < q.y0 + q.h + BUILDING_GAP; y++)
      for (let x = q.x0 - BUILDING_GAP; x < q.x0 + q.w + BUILDING_GAP; x++)
        blocked.add(`${x},${y}`);
  }
  return blocked;
}
function fits(sx: number, sy: number, w: number, h: number, blocked: Set<string>) {
  for (let y = sy; y < sy + h; y++) for (let x = sx; x < sx + w; x++) if (blocked.has(`${x},${y}`)) return false;
  return true;
}

mute();
let plus1 = 0, plus2 = 0, tot = 0;
for (const agents of [6, 10, 14, 20, 30]) {
  for (let i = 0; i < 40; i++) {
    const r = generateWorld({ sizeTier: 'auto', overrides: {}, seed: `fyr-${agents}-${i}` } as any, agents);
    const farm = r.locations.find((l: any) => l.type === 'farm');
    if (!farm) continue;
    tot++;
    const blocked = rebuildBlocked(r);
    const q = tileRect(farm);
    const c1 = [{ x: q.x0 + q.w + 1, y: q.y0 }, { x: q.x0, y: q.y0 + q.h + 1 }];
    const c2 = [{ x: q.x0 + q.w + 2, y: q.y0 }, { x: q.x0, y: q.y0 + q.h + 2 }];
    if (c1.some((c) => fits(c.x, c.y, 3, 3, blocked))) plus1++;
    if (c2.some((c) => fits(c.x, c.y, 3, 3, blocked))) plus2++;
  }
}
unmute();
console.log('--- deriveFarmyard candidate offsets (3x3 probe against layout blocked mask) ---');
console.log(`  worlds with a farm: ${tot}`);
console.log(`  offset +1 (current code) fits: ${plus1}`);
console.log(`  offset +2 (== BUILDING_GAP)  fits: ${plus2}`);

// -------------------------------------------------------------------------
// B. dimension sweep — is anything out of bounds / blocked at other sizes?
// -------------------------------------------------------------------------
const problems: Record<string, number> = {};
const samples: Record<string, string> = {};
let sweptOk = 0, sweptErr = 0;
mute();
for (let w = 56; w <= 90; w += 2) {
  for (let h = 43; h <= 70; h += 3) {
    for (let s = 0; s < 2; s++) {
      let r: any;
      try {
        r = generateWorld({ sizeTier: 'auto', seed: `sw-${w}-${h}-${s}`, overrides: { dimensions: { width: w, height: h } } } as any, 10);
      } catch { sweptErr++; continue; }
      sweptOk++;
      const W = r.dimensions.width, H = r.dimensions.height;
      const at = (x: number, y: number) => r.collisionGrid[y * W + x];
      for (const l of r.locations) {
        const q = tileRect(l);
        if (q.x0 < 0 || q.y0 < 0 || q.x0 + q.w > W || q.y0 + q.h > H) {
          problems['LOC_OOB'] = (problems['LOC_OOB'] ?? 0) + 1;
          samples['LOC_OOB'] ??= `map ${W}x${H} seed sw-${w}-${h}-${s} :: ${l.name}(${l.type}) at tiles ${q.x0},${q.y0} ${q.w}x${q.h}`;
        }
        const dx = Math.floor(l.entry_point.x / TILE), dy = Math.floor(l.entry_point.y / TILE);
        if (dx < 0 || dx >= W || dy < 0 || dy >= H) {
          problems['DOOR_OOB'] = (problems['DOOR_OOB'] ?? 0) + 1;
          samples['DOOR_OOB'] ??= `map ${W}x${H} seed sw-${w}-${h}-${s} :: ${l.name}(${l.type}) door ${dx},${dy}`;
        } else if (at(dx, dy) === '1') {
          const k = `DOOR_BLOCKED_${l.type}`;
          problems[k] = (problems[k] ?? 0) + 1;
          samples[k] ??= `map ${W}x${H} seed sw-${w}-${h}-${s} :: ${l.name} door ${dx},${dy}`;
        }
      }
      // building/road overlap
      const roadSet = new Set(r.roads.map((t: any) => `${t.x},${t.y}`));
      for (const l of r.locations) {
        if (!ENCLOSED_BUILDING_TYPES.has(l.type)) continue;
        const q = tileRect(l);
        for (let y = q.y0; y < q.y0 + q.h; y++) for (let x = q.x0; x < q.x0 + q.w; x++)
          if (roadSet.has(`${x},${y}`)) {
            problems['BUILDING_ON_ROAD'] = (problems['BUILDING_ON_ROAD'] ?? 0) + 1;
            samples['BUILDING_ON_ROAD'] ??= `map ${W}x${H} :: ${l.name} at ${x},${y}`;
          }
      }
    }
  }
}
unmute();
console.log('');
console.log(`--- dimension sweep (${sweptOk} worlds ok, ${sweptErr} failed to generate) ---`);
if (!Object.keys(problems).length) console.log('  no problems');
for (const [k, v] of Object.entries(problems).sort((a, b) => b[1] - a[1]))
  console.log(`  ${k}: ${v}\n     e.g. ${samples[k]}`);
