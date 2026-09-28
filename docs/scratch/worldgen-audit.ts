/* Throwaway adversarial audit of the worldgen pipeline. Read-only. */
import { generateWorld } from '../../server/lib/worldgen/pipeline';
import { computeRoadPositions } from '../../server/lib/worldgen/stages/roads';
import { ENCLOSED_BUILDING_TYPES } from '../../server/lib/worldgen/buildingTemplates';
import { INTERIOR_GRIDS } from '../../server/data/interiors';

const TILE = 32;

type Issue = { kind: string; detail: string };

function auditWorld(seed: string, agents: number) {
  const issues: Issue[] = [];
  const r = generateWorld({ sizeTier: 'auto', overrides: {}, seed } as any, agents);
  const { width: W, height: H } = r.dimensions;
  const grid = r.collisionGrid;
  const at = (x: number, y: number) => grid[y * W + x];

  // ---- road tile set ----
  const roadSet = new Set<string>();
  for (const t of r.roads) {
    roadSet.add(`${t.x},${t.y}`);
    if (t.x < 0 || t.x >= W || t.y < 0 || t.y >= H) {
      issues.push({ kind: 'ROAD_OOB', detail: `road tile ${t.x},${t.y} outside ${W}x${H}` });
    }
  }

  // ---- per-location geometry ----
  const tileRect = (l: any) => ({
    x0: Math.floor(l.position.x / TILE),
    y0: Math.floor(l.position.y / TILE),
    w: Math.ceil(l.position.width / TILE),
    h: Math.ceil(l.position.height / TILE),
  });

  for (const l of r.locations) {
    const q = tileRect(l);
    if (q.x0 < 0 || q.y0 < 0 || q.x0 + q.w > W || q.y0 + q.h > H) {
      issues.push({
        kind: 'LOC_OOB',
        detail: `${l.name}(${l.type}) tiles ${q.x0},${q.y0} ${q.w}x${q.h} outside ${W}x${H}`,
      });
    }
    // building overlapping road?
    if (ENCLOSED_BUILDING_TYPES.has(l.type)) {
      for (let y = q.y0; y < q.y0 + q.h; y++)
        for (let x = q.x0; x < q.x0 + q.w; x++)
          if (roadSet.has(`${x},${y}`))
            issues.push({ kind: 'BUILDING_ON_ROAD', detail: `${l.name} covers road ${x},${y}` });
    }
  }

  // ---- pairwise location overlap (all types, tile space) ----
  for (let a = 0; a < r.locations.length; a++) {
    for (let b = a + 1; b < r.locations.length; b++) {
      const A = tileRect(r.locations[a]), B = tileRect(r.locations[b]);
      const ov = A.x0 < B.x0 + B.w && A.x0 + A.w > B.x0 && A.y0 < B.y0 + B.h && A.y0 + A.h > B.y0;
      if (ov)
        issues.push({
          kind: 'LOC_OVERLAP',
          detail: `${r.locations[a].name}(${r.locations[a].type}) ∩ ${r.locations[b].name}(${r.locations[b].type})`,
        });
    }
  }

  // ---- collision grid vs geometry ----
  const expected: number[] = new Array(W * H).fill(0);
  for (const l of r.locations) {
    if (!ENCLOSED_BUILDING_TYPES.has(l.type)) continue;
    const q = tileRect(l);
    for (let y = q.y0; y < q.y0 + q.h; y++)
      for (let x = q.x0; x < q.x0 + q.w; x++)
        if (x >= 0 && x < W && y >= 0 && y < H) expected[y * W + x] = 1;
  }
  for (const l of r.locations) {
    if (!ENCLOSED_BUILDING_TYPES.has(l.type)) continue;
    const dx = Math.floor(l.entry_point.x / TILE), dy = Math.floor(l.entry_point.y / TILE);
    for (const d of [-1, 0, 1]) {
      const yy = dy + d;
      if (dx >= 0 && dx < W && yy >= 0 && yy < H) expected[yy * W + dx] = 0;
    }
  }
  // NOTE: this replicates the generator's own carve order only approximately;
  // report mismatches separately.
  let mismatch = 0;
  for (let i = 0; i < W * H; i++) if (String(expected[i]) !== grid[i]) mismatch++;

  // ---- door checks + reachability ----
  const walk = (x: number, y: number) => x >= 0 && x < W && y >= 0 && y < H && at(x, y) === '0';
  // BFS from all road tiles over walkable tiles, 8-dir with the same corner rule as A*
  const seen = new Uint8Array(W * H);
  const q: number[] = [];
  for (const t of r.roads) {
    if (walk(t.x, t.y) && !seen[t.y * W + t.x]) { seen[t.y * W + t.x] = 1; q.push(t.y * W + t.x); }
  }
  const DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1]];
  for (let head = 0; head < q.length; head++) {
    const cur = q[head], cx = cur % W, cy = (cur / W) | 0;
    for (const [ddx, ddy] of DIRS) {
      const nx = cx + ddx, ny = cy + ddy;
      if (!walk(nx, ny)) continue;
      if (ddx !== 0 && ddy !== 0) {
        if (!walk(cx + ddx, cy)) continue;
        if (!walk(cx, cy + ddy)) continue;
      }
      const nk = ny * W + nx;
      if (!seen[nk]) { seen[nk] = 1; q.push(nk); }
    }
  }
  for (const l of r.locations) {
    const dx = Math.floor(l.entry_point.x / TILE), dy = Math.floor(l.entry_point.y / TILE);
    if (dx < 0 || dx >= W || dy < 0 || dy >= H) {
      issues.push({ kind: 'DOOR_OOB', detail: `${l.name}(${l.type}) door tile ${dx},${dy}` });
      continue;
    }
    if (at(dx, dy) === '1')
      issues.push({ kind: 'DOOR_BLOCKED', detail: `${l.name}(${l.type}) door tile ${dx},${dy} is solid` });
    else if (!seen[dy * W + dx])
      issues.push({ kind: 'DOOR_UNREACHABLE', detail: `${l.name}(${l.type}) door ${dx},${dy} not reachable from road net` });
  }

  // ---- terrain on roads / buildings ----
  let terrainOnRoad = 0, terrainOnBuilding = 0, terrainOnDoor = 0;
  const buildingTiles = new Set<string>();
  const doorTiles = new Set<string>();
  for (const l of r.locations) {
    const q2 = tileRect(l);
    if (ENCLOSED_BUILDING_TYPES.has(l.type))
      for (let y = q2.y0; y < q2.y0 + q2.h; y++)
        for (let x = q2.x0; x < q2.x0 + q2.w; x++) buildingTiles.add(`${x},${y}`);
    doorTiles.add(`${Math.floor(l.entry_point.x / TILE)},${Math.floor(l.entry_point.y / TILE)}`);
  }
  for (const t of r.terrainTiles) {
    const k = `${t.x},${t.y}`;
    if (roadSet.has(k)) terrainOnRoad++;
    if (buildingTiles.has(k)) terrainOnBuilding++;
    if (doorTiles.has(k)) terrainOnDoor++;
  }

  // ---- interiors vs footprint ----
  for (const l of r.locations) {
    const g = INTERIOR_GRIDS[l.type];
    if (!g) continue;
    const q3 = tileRect(l);
    if (g.length !== q3.h || g[0].length !== q3.w)
      issues.push({
        kind: 'INTERIOR_SIZE',
        detail: `${l.name}(${l.type}) grid ${g[0].length}x${g.length} vs footprint ${q3.w}x${q3.h}`,
      });
    // door column agreement
    let doorCol = -1, doorRow = -1;
    for (let row = 0; row < g.length; row++)
      for (let col = 0; col < g[row].length; col++)
        if (g[row][col] === 3) { doorCol = col; doorRow = row; }
    const exDoorCol = Math.floor(l.entry_point.x / TILE) - q3.x0;
    if (doorCol >= 0 && doorCol !== exDoorCol)
      issues.push({
        kind: 'INTERIOR_DOOR_COL',
        detail: `${l.name}(${l.type}) interior door col ${doorCol} vs exterior ${exDoorCol}`,
      });
    if (doorRow >= 0 && doorRow !== g.length - 1)
      issues.push({ kind: 'INTERIOR_DOOR_ROW', detail: `${l.name}(${l.type}) door row ${doorRow}` });
  }

  // ---- determinism ----
  const r2 = generateWorld({ sizeTier: 'auto', overrides: {}, seed } as any, agents);
  if (JSON.stringify(r) !== JSON.stringify(r2))
    issues.push({ kind: 'NONDETERMINISM', detail: 'two runs of same seed differ' });

  return { r, issues, mismatch, terrainOnRoad, terrainOnBuilding, terrainOnDoor };
}

// ---------------------------------------------------------------------------
const origLog = console.log, origWarn = console.warn;
console.log = () => {}; console.warn = () => {};

const counts: Record<string, number> = {};
const samples: Record<string, string> = {};
let worlds = 0, gridMismatchWorlds = 0, terrRoad = 0, terrBldg = 0, terrDoor = 0, terrTotal = 0;
const failures: string[] = [];

const AGENT_COUNTS = [4, 8, 12, 16, 24, 30];
const SEEDS = 60;

for (const n of AGENT_COUNTS) {
  for (let i = 0; i < SEEDS; i++) {
    const seed = `audit-${n}-${i}`;
    try {
      const res = auditWorld(seed, n);
      worlds++;
      if (res.mismatch > 0) gridMismatchWorlds++;
      terrRoad += res.terrainOnRoad; terrBldg += res.terrainOnBuilding; terrDoor += res.terrainOnDoor;
      terrTotal += res.r.terrainTiles.length;
      for (const iss of res.issues) {
        counts[iss.kind] = (counts[iss.kind] ?? 0) + 1;
        if (!samples[iss.kind]) samples[iss.kind] = `seed=${seed} agents=${n} :: ${iss.detail}`;
      }
    } catch (e: any) {
      failures.push(`seed=${seed} agents=${n} :: ${e.message}`);
    }
  }
}

console.log = origLog; console.warn = origWarn;

console.log(`worlds generated OK: ${worlds}`);
console.log(`generation failures: ${failures.length}`);
for (const f of failures.slice(0, 10)) console.log('  FAIL ' + f);
console.log('');
console.log('issue counts:');
for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k}: ${v}`);
  console.log(`     e.g. ${samples[k]}`);
}
console.log('');
console.log(`collision-grid mismatch worlds: ${gridMismatchWorlds}/${worlds}`);
console.log(`terrain tiles total=${terrTotal} onRoad=${terrRoad} onBuilding=${terrBldg} onDoor=${terrDoor}`);
